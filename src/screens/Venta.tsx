import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { formatearStock, precioVentaBsHoy, precioVentaUsd } from "../precios";
import { fechaHoraVenezuela } from "../fecha";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";
import {
  AporteCapitalExterno,
  AvanceEfectivo,
  Cliente,
  ConfigRow,
  LineaCarrito,
  LineaPago,
  MetodoPago,
  METODOS_PAGO,
  Producto,
  Repartidor,
  Vendedor,
} from "../types";
import logo from "../assets/logo.png";

const MAX_TICKETS_ABIERTOS = 6;

// Recargo de delivery por WhatsApp: $0.10 por cada producto del carrito,
// para pasarle el precio final al cliente (mismo monto que se le paga de
// comisión al repartidor, ver Cuentas → Comisiones delivery — deben
// coincidir siempre). Se guarda como una línea más del carrito contra este
// producto placeholder (desactivado para que no aparezca en la búsqueda
// normal — ver Estadisticas.tsx/Cuentas.tsx, que ya lo excluyen de sus
// conteos por este mismo id), así el total de la venta y el ticket
// impreso ya lo incluyen solos, sin tocar nada más del resto de la app.
const COMISION_USD_POR_PRODUCTO = 0.1;
const PRODUCTO_DELIVERY_ID = "f195fbac-103d-48fa-a27a-28371fba7745";

// Productos que salen del inventario sin ser una venta (mermas, uso
// propio del negocio, muestras). A diferencia de un ticket, esta lista es
// única y vive durante todo el día: se van agregando productos según
// aparece la necesidad y se guarda todo junto una sola vez — no hace
// falta "cerrarla" por cada producto.
type LineaConsumoInterno = {
  producto_id: string;
  nombre: string;
  cantidad: number;
  motivo: string;
  stock_disponible: number;
  costo_actual_usd: number;
};

// Un "ticket abierto" es un carrito/cobro en construcción. Permite dejar
// a un cliente a medias (ej. mientras busca su cédula, o sigue agregando
// cosas) y atender a otro sin perder nada, con varias facturas avanzando
// en paralelo. Solo se convierte en una venta real de la base de datos
// cuando se confirma el cobro.
type TicketAbierto = {
  id: string;
  carrito: LineaCarrito[];
  pagos: LineaPago[];
  clienteId: string | null;
  clienteNombre: string;
  clienteCedula: string;
  clienteDireccion: string | null;
  clienteCreditoAutorizado: boolean;
  // Deuda que este cliente ya arrastraba de ventas anteriores (no la de
  // este ticket) — se consulta al seleccionarlo, para poder avisarle al
  // cajero antes de que siga sumando más a la cuenta sin darse cuenta.
  deudaPendienteUsd: number;
  avisoCreditoResuelto: boolean;
  // true cuando el cajero eligió explícitamente "cobrar completo" ante el
  // aviso de deuda — bloquea que esta venta se cierre a medio pagar.
  bloquearCredito: boolean;
  // true = "Sumar a la cuenta actual" o "Sumar y abonar": la deuda vieja
  // se suma al total a cobrar de este ticket. false = "No sumar": la
  // deuda vieja queda intacta, aparte, y esta venta es independiente.
  combinarDeuda: boolean;
  // Pedido de delivery cargado a mano (por WhatsApp) — reemplaza al viejo
  // truco de agregar un producto "DELIVERY" a $0.10 x cantidad: con esto
  // marcado, la venta queda con canal="DELIVERY" y el repartidor elegido,
  // y la comisión se calcula sola (ver Cuentas → Comisiones de delivery).
  esDelivery: boolean;
  repartidorId: string | null;
};

function ticketVacio(): TicketAbierto {
  return {
    id: crypto.randomUUID(),
    carrito: [],
    pagos: [],
    clienteId: null,
    clienteNombre: "",
    clienteCedula: "",
    clienteDireccion: null,
    clienteCreditoAutorizado: false,
    deudaPendienteUsd: 0,
    avisoCreditoResuelto: true,
    bloquearCredito: false,
    combinarDeuda: false,
    esDelivery: false,
    repartidorId: null,
  };
}

// Este negocio no factura IVA por separado — el precio de venta ya es el
// precio final, así que el total de la venta es directo el subtotal.
//
// El total en Bs se arma a partir del total en USD YA REDONDEADO a
// centavos, no sumando los Bs de cada línea por separado: cada línea
// individual ya es consistente (ver precioVentaBsHoy en precios.ts), pero
// sumar varias líneas y mostrar "USD total" como esa suma de Bs dividida
// entre la tasa (y recién ahí redondeada) da un USD que, multiplicado a
// mano por la tasa, no reconstruye el Bs que se ve en pantalla — mismo
// problema que con el precio por producto, ahora a nivel de todo el
// carrito. Redondeando el USD total UNA sola vez y calculando el Bs desde
// ahí, lo que se ve siempre cuadra con una calculadora.
function calcularTotales(carrito: LineaCarrito[], tasa: number) {
  const totalUsdSinRedondear = carrito.reduce(
    (acc, l) => acc + (tasa > 0 ? (l.precio_unit_bs / tasa) * l.cantidad : 0),
    0
  );
  const totalUsd = Math.round(totalUsdSinRedondear * 100) / 100;
  const total = totalUsd * tasa;
  return { subtotal: total, total, totalUsd };
}

// Reparte una lista de pagos entre "lo que cubre un monto objetivo" (ej. la
// deuda vieja que se está combinando) y "lo que sobra" — en el orden en que
// se agregaron, partiendo una línea en dos si hace falta. Se usa para saber
// cuánto de lo que pagó el cliente va a la deuda anterior y cuánto a la
// venta actual cuando el cajero elige combinarlas.
function dividirPagos(pagos: LineaPago[], monto: number): { consumidos: LineaPago[]; restantes: LineaPago[] } {
  let restante = monto;
  const consumidos: LineaPago[] = [];
  const restantes: LineaPago[] = [];
  for (const p of pagos) {
    if (restante <= 0.001) {
      restantes.push(p);
      continue;
    }
    if (p.monto_bs <= restante + 0.001) {
      consumidos.push(p);
      restante -= p.monto_bs;
    } else {
      consumidos.push({ ...p, monto_bs: Number(restante.toFixed(2)) });
      restantes.push({ ...p, monto_bs: Number((p.monto_bs - restante).toFixed(2)) });
      restante = 0;
    }
  }
  return { consumidos, restantes };
}

// Convierte el string guardado (ya en hora de Venezuela) a algo legible,
// sin volver a pasarlo por ninguna conversión de zona horaria — son los
// mismos números, solo con otro formato.
function formatearFechaHora(fh: string): string {
  const [fecha, hora] = fh.split(" ");
  const [y, m, d] = fecha.split("-");
  const [hh, mm] = (hora ?? "00:00").split(":");
  return `${d}/${m}/${y} ${hh}:${mm}`;
}

export default function Venta({
  config,
  vendedor,
  onTasaVista,
  visible,
}: {
  config: ConfigRow;
  vendedor: Vendedor | null;
  onTasaVista: () => void;
  // App.tsx mantiene este componente siempre montado (solo lo oculta con
  // CSS) para no perder los tickets abiertos ni el consumo interno del
  // día al cambiar de pestaña. Esta prop es la única forma de saber
  // "volviste a esta pestaña" para, por ejemplo, reenfocar el buscador.
  visible: boolean;
}) {
  const [primerTicket] = useState<TicketAbierto>(() => ticketVacio());
  const [tickets, setTickets] = useState<TicketAbierto[]>([primerTicket]);
  const [activeId, setActiveId] = useState<string>(primerTicket.id);
  const activo = tickets.find((t) => t.id === activeId) ?? tickets[0];

  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<Producto[]>([]);
  const [mostrarDropdown, setMostrarDropdown] = useState(false);
  const [indiceActivo, setIndiceActivo] = useState(-1);
  const [metodoNuevo, setMetodoNuevo] = useState<MetodoPago>("EFECTIVO");
  const [montoNuevo, setMontoNuevo] = useState("");
  const [refNueva, setRefNueva] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Último click antes de registrar la venta: se muestra un resumen
  // (productos, cantidades, total, método de pago) para que la caja
  // confirme que no hubo un error de click por trabajar rápido — la venta
  // recién se guarda cuando se acepta este resumen (ver ejecutarVentaConfirmada).
  const [confirmacionVenta, setConfirmacionVenta] = useState<{
    pagosReales: LineaPago[];
    esCredito: boolean;
    montoPendienteUsd: number | null;
    // Si el cajero combinó la deuda vieja: la porción del pago que se le
    // aplica a esa deuda (no a esta venta), para saldarla con un abono
    // aparte antes de confirmar la venta — ver ejecutarVentaConfirmada.
    pagosParaDeuda: LineaPago[];
  } | null>(null);

  // Cuando se escanea/escribe un código que no coincide con ningún
  // producto, puede ser un producto nuevo (creado desde una factura de
  // compra) al que todavía no se le asignó su código de barras real —
  // ver Compras.tsx e Inventario.tsx. En vez de solo fallar, se ofrece
  // asignarlo ahí mismo y seguir con la venta sin cortar la fila.
  const [codigoSinAsignar, setCodigoSinAsignar] = useState<string | null>(null);
  const [pendientesAsignacion, setPendientesAsignacion] = useState<Producto[]>([]);

  // --- Búsqueda de cliente por cédula ---
  const [clienteBusqueda, setClienteBusqueda] = useState("");
  const [clienteResultados, setClienteResultados] = useState<Cliente[]>([]);
  const [clienteMostrarDropdown, setClienteMostrarDropdown] = useState(false);
  const [clienteNuevoNombre, setClienteNuevoNombre] = useState("");
  const [clienteNuevoCedula, setClienteNuevoCedula] = useState("");
  const [clienteNuevoTelefono, setClienteNuevoTelefono] = useState("");
  const [clienteNuevoDireccion, setClienteNuevoDireccion] = useState("");
  const [mostrarClienteNuevo, setMostrarClienteNuevo] = useState(false);

  // --- Consumo interno del día (independiente de los tickets de venta) ---
  const [consumoInterno, setConsumoInterno] = useState<LineaConsumoInterno[]>([]);
  const [mostrarConsumo, setMostrarConsumo] = useState(false);
  const [busquedaConsumo, setBusquedaConsumo] = useState("");
  const [resultadosConsumo, setResultadosConsumo] = useState<Producto[]>([]);
  const [mostrarDropdownConsumo, setMostrarDropdownConsumo] = useState(false);
  const [guardandoConsumo, setGuardandoConsumo] = useState(false);
  const [mensajeConsumo, setMensajeConsumo] = useState<string | null>(null);

  // --- Avances de efectivo del día (el cliente pide efectivo, se le cobra
  // un monto mayor por otro método — la diferencia es la comisión). Cada
  // uno se guarda al momento, no se acumula como el consumo interno,
  // porque es un cambio de efectivo real que ya ocurrió en caja.
  const [mostrarAvances, setMostrarAvances] = useState(false);
  const [avancesHoy, setAvancesHoy] = useState<AvanceEfectivo[]>([]);
  const [avanceMontoEfectivo, setAvanceMontoEfectivo] = useState("");
  const [avanceMontoCobrado, setAvanceMontoCobrado] = useState("");
  const [avanceMetodoCobro, setAvanceMetodoCobro] = useState<MetodoPago>("PUNTO_VENTA");
  const [avanceFuente, setAvanceFuente] = useState<"CAJA" | "CAPITAL_EXTERIOR">("CAJA");
  const [avanceReferencia, setAvanceReferencia] = useState("");
  const [guardandoAvance, setGuardandoAvance] = useState(false);
  const [mensajeAvance, setMensajeAvance] = useState<string | null>(null);

  // Saldo del capital externo para avances: no es "de hoy", es acumulado
  // (alguien deposita un monto y se va gastando en avances a lo largo de
  // varios días hasta que se agota o se repone) — por eso se consulta
  // aparte, sin filtrar por fecha.
  const [aportesCapitalExterno, setAportesCapitalExterno] = useState<AporteCapitalExterno[]>([]);
  const [saldoCapitalExterno, setSaldoCapitalExterno] = useState(0);
  const [montoAporteNuevo, setMontoAporteNuevo] = useState("");
  const [notaAporteNuevo, setNotaAporteNuevo] = useState("");
  const [guardandoAporte, setGuardandoAporte] = useState(false);
  const [mensajeAporte, setMensajeAporte] = useState<string | null>(null);

  // --- Repartidores (para marcar una venta como delivery por WhatsApp) ---
  const [repartidores, setRepartidores] = useState<Repartidor[]>([]);
  useEffect(() => {
    (async () => {
      const db = await getDb();
      setRepartidores(await db.select<Repartidor[]>("SELECT * FROM repartidores WHERE activo = 1 ORDER BY nombre"));
    })();
  }, []);

  const [recibo, setRecibo] = useState<null | {
    numero: string;
    fechaHora: string;
    vendedor: string;
    lineas: LineaCarrito[];
    pagos: LineaPago[];
    subtotal: number;
    total: number;
    cliente: string;
    clienteDireccion: string | null;
    tasa: number;
    sinConexion: boolean;
  }>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reloj en vivo (hora de Venezuela) que se ve mientras se arma la venta.
  const [horaActual, setHoraActual] = useState(fechaHoraVenezuela());
  useEffect(() => {
    const t = setInterval(() => setHoraActual(fechaHoraVenezuela()), 1000);
    return () => clearInterval(t);
  }, []);

  // Como el componente ya no se desmonta al cambiar de pestaña (para no
  // perder los tickets), el enfoque automático del buscador depende de
  // "visible" en vez de correr solo una vez al montar.
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  const { subtotal: subtotalCarrito, total: totalCarrito } = calcularTotales(activo.carrito, config.tasa_cambio_dia);
  // Cantidad total de productos reales del carrito (para el recargo de
  // delivery de abajo) — antes de agregar la línea del recargo en sí. Un
  // producto por peso (ej. 0.2kg) cuenta como 1 producto entero, no como
  // 0.2 — la comisión/recargo es por PRODUCTO entregado, no por kilo.
  const totalUnidadesCarrito = activo.carrito.reduce((acc, l) => acc + (l.por_peso ? 1 : l.cantidad), 0);
  const recargoDeliveryBs = activo.esDelivery
    ? totalUnidadesCarrito * COMISION_USD_POR_PRODUCTO * config.tasa_cambio_dia
    : 0;
  // El subtotal/total de la venta ya incluyen el recargo de delivery (si
  // aplica) — así todo lo que se calcula a partir de acá (restante a
  // cobrar, cobro rápido, recibo) lo tiene en cuenta sin tener que tocar
  // cada lugar por separado.
  const subtotal = subtotalCarrito + recargoDeliveryBs;
  const total = totalCarrito + recargoDeliveryBs;
  // Si el cajero eligió combinar la deuda vieja, el total "a cobrar" de
  // este ticket la incluye (convertida a la tasa de HOY, igual criterio
  // que el resto de la app) — pero el total real de la VENTA que se
  // guarda sigue siendo solo el del carrito (la deuda vieja se salda con
  // un abono aparte, ver procesarVenta).
  const deudaBsHoy = activo.combinarDeuda ? activo.deudaPendienteUsd * config.tasa_cambio_dia : 0;
  const totalConDeuda = total + deudaBsHoy;
  const totalPagado = activo.pagos.reduce((acc, p) => acc + p.monto_bs, 0);
  const restante = Number((totalConDeuda - totalPagado).toFixed(2));
  const proximoNumero = `${config.prefijo_caja}-${String(config.proximo_numero_ticket).padStart(6, "0")}`;
  const totalConsumoUsd = consumoInterno.reduce((acc, l) => acc + l.costo_actual_usd * l.cantidad, 0);

  // Precarga el monto que falta en el campo de pago manual (para pagos
  // divididos o a crédito) — el cajero solo lo sobreescribe si el cliente
  // paga una parte distinta. No pisa lo que el cajero ya esté escribiendo.
  useEffect(() => {
    if (montoNuevo === "" && restante > 0.01) {
      setMontoNuevo(restante.toFixed(2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restante, activo.id]);

  function actualizarActivo(cambios: Partial<TicketAbierto>) {
    setTickets((prev) => prev.map((t) => (t.id === activeId ? { ...t, ...cambios } : t)));
  }

  function cambiarDeTicket(id: string) {
    setActiveId(id);
    setBusqueda("");
    setResultados([]);
    setMostrarDropdown(false);
    setIndiceActivo(-1);
    setClienteBusqueda("");
    setClienteResultados([]);
    setClienteMostrarDropdown(false);
    setMostrarClienteNuevo(false);
    setMensaje(null);
    setMontoNuevo("");
    setRefNueva("");
    inputRef.current?.focus();
  }

  function nuevoTicket() {
    if (tickets.length >= MAX_TICKETS_ABIERTOS) {
      setMensaje(`Ya tienes ${MAX_TICKETS_ABIERTOS} tickets abiertos a la vez. Cierra o cobra alguno antes de abrir otro.`);
      return;
    }
    const t = ticketVacio();
    setTickets((prev) => [...prev, t]);
    cambiarDeTicket(t.id);
  }

  function cerrarTicket(id: string) {
    const t = tickets.find((x) => x.id === id);
    if (t && (t.carrito.length > 0 || t.pagos.length > 0)) {
      const ok = confirm("Este ticket tiene productos agregados. ¿Seguro que quieres cerrarlo sin cobrar?");
      if (!ok) return;
    }
    setTickets((prev) => {
      const resto = prev.filter((x) => x.id !== id);
      if (resto.length === 0) {
        const nuevo = ticketVacio();
        setActiveId(nuevo.id);
        return [nuevo];
      }
      if (id === activeId) setActiveId(resto[0].id);
      return resto;
    });
  }

  // Búsqueda de producto en vivo (nombre o código), con debounce.
  useEffect(() => {
    const term = busqueda.trim();
    if (term.length < 2) {
      setResultados([]);
      setMostrarDropdown(false);
      setIndiceActivo(-1);
      return;
    }
    const timer = setTimeout(async () => {
      const db = await getDb();
      const rows = await db.selectRapido<Producto[]>(
        `SELECT * FROM productos WHERE activo = 1 AND (${sqlSinAcentos("nombre")} LIKE $1 OR codigo_barra LIKE $2) ORDER BY nombre LIMIT 8`,
        [`%${normalizarTexto(term)}%`, `%${term}%`]
      );
      setResultados(rows);
      setMostrarDropdown(rows.length > 0);
      setIndiceActivo(-1);
    }, 200);
    return () => clearTimeout(timer);
  }, [busqueda]);

  // Búsqueda de cliente por cédula (o nombre) en vivo, con debounce.
  useEffect(() => {
    const term = clienteBusqueda.trim();
    if (term.length < 2) {
      setClienteResultados([]);
      setClienteMostrarDropdown(false);
      return;
    }
    const timer = setTimeout(async () => {
      const db = await getDb();
      const rows = await db.selectRapido<Cliente[]>(
        `SELECT * FROM clientes WHERE cedula LIKE $1 OR ${sqlSinAcentos("nombre")} LIKE $2 ORDER BY nombre LIMIT 6`,
        [`%${term}%`, `%${normalizarTexto(term)}%`]
      );
      setClienteResultados(rows);
      setClienteMostrarDropdown(true);
    }, 200);
    return () => clearTimeout(timer);
  }, [clienteBusqueda]);

  // Búsqueda de producto para consumo interno — separada de la búsqueda
  // del carrito de venta para que no se pisen si se usan las dos casi al
  // mismo tiempo.
  useEffect(() => {
    const term = busquedaConsumo.trim();
    if (term.length < 2) {
      setResultadosConsumo([]);
      setMostrarDropdownConsumo(false);
      return;
    }
    const timer = setTimeout(async () => {
      const db = await getDb();
      const rows = await db.selectRapido<Producto[]>(
        `SELECT * FROM productos WHERE activo = 1 AND (${sqlSinAcentos("nombre")} LIKE $1 OR codigo_barra LIKE $2) ORDER BY nombre LIMIT 8`,
        [`%${normalizarTexto(term)}%`, `%${term}%`]
      );
      setResultadosConsumo(rows);
      setMostrarDropdownConsumo(rows.length > 0);
    }, 200);
    return () => clearTimeout(timer);
  }, [busquedaConsumo]);

  function agregarAConsumo(p: Producto) {
    setConsumoInterno((prev) => {
      const existente = prev.find((l) => l.producto_id === p.id);
      if (existente) {
        return prev.map((l) => (l.producto_id === p.id ? { ...l, cantidad: l.cantidad + 1 } : l));
      }
      return [
        ...prev,
        {
          producto_id: p.id,
          nombre: p.nombre,
          cantidad: 1,
          motivo: "Consumo interno",
          stock_disponible: p.stock_actual,
          costo_actual_usd: p.costo_actual_usd,
        },
      ];
    });
    setBusquedaConsumo("");
    setResultadosConsumo([]);
    setMostrarDropdownConsumo(false);
  }

  async function buscarYAgregarConsumo(e: React.FormEvent) {
    e.preventDefault();
    setMensajeConsumo(null);

    if (resultadosConsumo.length > 0) {
      agregarAConsumo(resultadosConsumo[0]);
      return;
    }

    const codigo = busquedaConsumo.trim();
    if (!codigo) return;

    const db = await getDb();
    const rows = await db.selectRapido<Producto[]>("SELECT * FROM productos WHERE codigo_barra = $1 AND activo = 1", [codigo]);
    if (rows.length === 0) {
      setMensajeConsumo(`No se encontró ningún producto activo con código "${codigo}".`);
      setBusquedaConsumo("");
      setMostrarDropdownConsumo(false);
      return;
    }
    agregarAConsumo(rows[0]);
  }

  // Igual criterio que cambiarCantidad del carrito de venta: no se quita la
  // línea sola al pasar por 0 (productos por peso escriben "0.3" pasando
  // por un "0" intermedio) — solo se quita con el botón "quitar".
  function cambiarCantidadConsumo(producto_id: string, cantidad: number) {
    setConsumoInterno((prev) =>
      prev.map((l) => (l.producto_id === producto_id ? { ...l, cantidad: Math.max(0, cantidad) } : l))
    );
  }

  function cambiarMotivoConsumo(producto_id: string, motivo: string) {
    setConsumoInterno((prev) => prev.map((l) => (l.producto_id === producto_id ? { ...l, motivo } : l)));
  }

  function quitarLineaConsumo(producto_id: string) {
    setConsumoInterno((prev) => prev.filter((l) => l.producto_id !== producto_id));
  }

  async function guardarConsumoInterno() {
    if (guardandoConsumo) return;
    setMensajeConsumo(null);

    if (consumoInterno.length === 0) {
      setMensajeConsumo("Agrega al menos un producto antes de guardar.");
      return;
    }
    const sinStock = consumoInterno.find((l) => l.cantidad > l.stock_disponible);
    if (sinStock) {
      const continuar = confirm(
        `"${sinStock.nombre}" tiene ${sinStock.stock_disponible} en stock y estás descontando ${sinStock.cantidad}. ¿Continuar de todas formas?`
      );
      if (!continuar) return;
    }

    setGuardandoConsumo(true);
    let sinConexion = false;
    try {
      // Igual que confirmar_venta y ajustar_stock: todo se descuenta en
      // una sola transacción real en Rust, no con INSERT/UPDATE sueltos.
      // Si no hay conexión, queda en la cola local y se sincroniza sola.
      const resultado = await invoke<{ sin_conexion: boolean }>("registrar_consumo_interno", {
        input: {
          fecha_hora: fechaHoraVenezuela(),
          items: consumoInterno.map((l) => ({
            producto_id: l.producto_id,
            cantidad: l.cantidad,
            motivo: l.motivo,
          })),
        },
      });
      sinConexion = resultado.sin_conexion;
    } catch (e) {
      setMensajeConsumo(`No se pudo guardar el consumo interno: ${String(e)}`);
      setGuardandoConsumo(false);
      return;
    }

    setConsumoInterno([]);
    setGuardandoConsumo(false);
    setMensajeConsumo(
      sinConexion
        ? "Consumo interno guardado sin conexión ⚠ — se sincronizará solo cuando vuelva internet."
        : "Consumo interno del día guardado y descontado del inventario ✅"
    );
  }

  async function cargarAvancesHoy() {
    const db = await getDb();
    const hoy = fechaHoraVenezuela().slice(0, 10);
    const rows = await db.select<AvanceEfectivo[]>(
      "SELECT * FROM avances_efectivo WHERE date(created_at) = $1 ORDER BY created_at DESC",
      [hoy]
    );
    setAvancesHoy(rows);
  }

  async function cargarCapitalExterno() {
    const db = await getDb();
    const aportes = await db.select<AporteCapitalExterno[]>(
      "SELECT * FROM aportes_capital_externo ORDER BY created_at DESC LIMIT 20"
    );
    setAportesCapitalExterno(aportes);
    const [{ total_aportado }] = await db.select<{ total_aportado: number }[]>(
      "SELECT COALESCE(SUM(monto_bs), 0) as total_aportado FROM aportes_capital_externo"
    );
    const [{ total_usado }] = await db.select<{ total_usado: number }[]>(
      "SELECT COALESCE(SUM(monto_efectivo_bs), 0) as total_usado FROM avances_efectivo WHERE fuente_efectivo = 'CAPITAL_EXTERIOR'"
    );
    setSaldoCapitalExterno(total_aportado - total_usado);
  }

  useEffect(() => {
    if (visible && mostrarAvances) {
      cargarAvancesHoy();
      cargarCapitalExterno();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mostrarAvances]);

  async function registrarAporteCapitalExterno() {
    setMensajeAporte(null);
    const monto = Number(montoAporteNuevo);
    if (!monto || monto <= 0) {
      setMensajeAporte("El monto debe ser mayor a 0.");
      return;
    }
    setGuardandoAporte(true);
    const db = await getDb();
    try {
      await db.execute("INSERT INTO aportes_capital_externo (id, monto_bs, nota, usuario, created_at) VALUES ($1,$2,$3,$4,$5)", [
        crypto.randomUUID(),
        monto,
        notaAporteNuevo.trim() || null,
        vendedor?.nombre ?? null,
        fechaHoraVenezuela(),
      ]);
    } catch (e) {
      setMensajeAporte(`No se pudo registrar el aporte: ${String(e)}`);
      setGuardandoAporte(false);
      return;
    }
    setMontoAporteNuevo("");
    setNotaAporteNuevo("");
    setGuardandoAporte(false);
    await cargarCapitalExterno();
  }

  async function registrarAvance() {
    setMensajeAvance(null);
    const montoEfectivo = Number(avanceMontoEfectivo);
    const montoCobrado = Number(avanceMontoCobrado);
    if (!montoEfectivo || montoEfectivo <= 0) {
      setMensajeAvance("El efectivo entregado debe ser mayor a 0.");
      return;
    }
    if (!montoCobrado || montoCobrado <= 0) {
      setMensajeAvance("El monto cobrado debe ser mayor a 0.");
      return;
    }
    if (montoCobrado < montoEfectivo) {
      setMensajeAvance("El monto cobrado no puede ser menor al efectivo entregado.");
      return;
    }
    if (avanceFuente === "CAPITAL_EXTERIOR" && montoEfectivo > saldoCapitalExterno + 0.01) {
      const continuar = confirm(
        `El capital externo disponible es Bs ${saldoCapitalExterno.toFixed(2)} — este avance usa Bs ${montoEfectivo.toFixed(2)}, más de lo que queda. ¿Registrarlo igual?`
      );
      if (!continuar) return;
    }
    setGuardandoAvance(true);
    const db = await getDb();
    try {
      await db.execute(
        `INSERT INTO avances_efectivo (id, monto_efectivo_bs, monto_cobrado_bs, metodo_cobro, fuente_efectivo, referencia, usuario, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          crypto.randomUUID(),
          montoEfectivo,
          montoCobrado,
          avanceMetodoCobro,
          avanceFuente,
          avanceReferencia.trim() || null,
          vendedor?.nombre ?? null,
          fechaHoraVenezuela(),
        ]
      );
    } catch (e) {
      setMensajeAvance(`No se pudo registrar el avance: ${String(e)}`);
      setGuardandoAvance(false);
      return;
    }
    setAvanceMontoEfectivo("");
    setAvanceMontoCobrado("");
    setAvanceReferencia("");
    setGuardandoAvance(false);
    await cargarAvancesHoy();
    if (avanceFuente === "CAPITAL_EXTERIOR") await cargarCapitalExterno();
  }

  async function seleccionarCliente(c: Cliente) {
    const ticketId = activo.id;
    actualizarActivo({
      clienteId: c.id,
      clienteNombre: c.nombre,
      clienteCedula: c.cedula,
      clienteDireccion: c.direccion,
      clienteCreditoAutorizado: !!c.credito_autorizado,
      deudaPendienteUsd: 0,
      avisoCreditoResuelto: true,
      bloquearCredito: false,
      combinarDeuda: false,
    });
    setClienteBusqueda("");
    setClienteResultados([]);
    setClienteMostrarDropdown(false);
    setMostrarClienteNuevo(false);

    // Si ya arrastra deuda de ventas anteriores, se lo recordamos al
    // cajero apenas lo selecciona — antes de que empiece a cobrar, no
    // después. Se busca por su propio id de ticket (no por "el ticket
    // activo" de ese momento) por si cambió de pestaña mientras esto
    // cargaba.
    const db = await getDb();
    const rows = await db.select<{ total_pendiente_usd: number | null }[]>(
      "SELECT SUM(monto_pendiente_usd) as total_pendiente_usd FROM ventas WHERE cliente_cedula = $1 AND estado = 'CREDITO_PENDIENTE'",
      [c.cedula]
    );
    const deuda = rows[0]?.total_pendiente_usd ?? 0;
    if (deuda > 0.01) {
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, deudaPendienteUsd: deuda, avisoCreditoResuelto: false } : t))
      );
    }
  }

  function quitarCliente() {
    actualizarActivo({
      clienteId: null,
      clienteNombre: "",
      clienteCedula: "",
      clienteDireccion: null,
      clienteCreditoAutorizado: false,
      deudaPendienteUsd: 0,
      avisoCreditoResuelto: true,
      bloquearCredito: false,
      combinarDeuda: false,
    });
  }

  async function crearClienteRapido() {
    const cedula = clienteNuevoCedula.trim();
    if (!cedula || !clienteNuevoNombre.trim()) {
      setMensaje("Para crear el cliente necesitas cédula y nombre.");
      return;
    }
    const db = await getDb();
    const id = crypto.randomUUID();
    const telefono = clienteNuevoTelefono.trim() || null;
    const direccion = clienteNuevoDireccion.trim() || null;
    try {
      await db.execute("INSERT INTO clientes (id, nombre, cedula, telefono, direccion) VALUES ($1,$2,$3,$4,$5)", [
        id,
        clienteNuevoNombre.trim(),
        cedula,
        telefono,
        direccion,
      ]);
    } catch (e) {
      setMensaje(`No se pudo crear el cliente (¿cédula repetida?): ${String(e)}`);
      return;
    }
    seleccionarCliente({
      id,
      nombre: clienteNuevoNombre.trim(),
      cedula,
      telefono,
      direccion,
      cliente_app_id: null,
      credito_autorizado: 0,
    });
    setClienteNuevoNombre("");
    setClienteNuevoCedula("");
    setClienteNuevoTelefono("");
    setClienteNuevoDireccion("");
    setMostrarClienteNuevo(false);
  }

  function agregarAlCarrito(p: Producto) {
    const existente = activo.carrito.find((l) => l.producto_id === p.id);
    const nuevoCarrito = existente
      ? activo.carrito.map((l) => (l.producto_id === p.id ? { ...l, cantidad: l.cantidad + 1 } : l))
      : [
        ...activo.carrito,
        {
          producto_id: p.id,
          codigo_barra: p.codigo_barra,
          nombre: p.nombre,
          cantidad: 1,
          precio_unit_bs: precioVentaBsHoy(p, config.tasa_cambio_dia),
          es_gravable: p.es_gravable,
          tasa_iva: p.tasa_iva,
          stock_disponible: p.stock_actual,
          por_peso: p.por_peso,
        },
      ];
    actualizarActivo({ carrito: nuevoCarrito });
    setBusqueda("");
    setResultados([]);
    setMostrarDropdown(false);
    setIndiceActivo(-1);
    setCodigoSinAsignar(null);
    setPendientesAsignacion([]);
  }

  async function buscarYAgregar(e: React.FormEvent) {
    e.preventDefault();
    setMensaje(null);

    if (indiceActivo >= 0 && resultados[indiceActivo]) {
      agregarAlCarrito(resultados[indiceActivo]);
      return;
    }
    if (mostrarDropdown && resultados.length > 0) {
      agregarAlCarrito(resultados[0]);
      return;
    }

    const codigo = busqueda.trim();
    if (!codigo) return;

    const db = await getDb();
    const rows = await db.selectRapido<Producto[]>(
      "SELECT * FROM productos WHERE codigo_barra = $1 AND activo = 1",
      [codigo]
    );

    if (rows.length === 0) {
      setMensaje(`No se encontró ningún producto activo con código "${codigo}".`);
      setMostrarDropdown(false);
      // Puede ser un producto nuevo sin código de barras asignado todavía
      // (ver Compras.tsx/Inventario.tsx) — se ofrece elegirlo de la lista
      // de pendientes en vez de solo fallar.
      const pendientes = await db.select<Producto[]>(
        "SELECT * FROM productos WHERE codigo_barra LIKE 'SINCOD-%' AND activo = 1 ORDER BY nombre"
      );
      setPendientesAsignacion(pendientes);
      setCodigoSinAsignar(codigo);
      setBusqueda("");
      return;
    }

    agregarAlCarrito(rows[0]);
  }

  // Asigna el código recién escaneado a un producto pendiente (creado
  // desde una factura de compra sin código de barras real todavía) y
  // sigue con la venta de una vez — sin frenar la fila.
  async function asignarCodigoYAgregar(p: Producto) {
    if (!codigoSinAsignar) return;
    const db = await getDb();
    try {
      await db.execute("UPDATE productos SET codigo_barra = $1 WHERE id = $2", [codigoSinAsignar, p.id]);
    } catch (e) {
      setMensaje(`No se pudo asignar el código: ${String(e)}`);
      return;
    }
    agregarAlCarrito({ ...p, codigo_barra: codigoSinAsignar });
    setCodigoSinAsignar(null);
    setPendientesAsignacion([]);
    setMensaje(null);
  }

  function onKeyDownBusqueda(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!mostrarDropdown || resultados.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndiceActivo((i) => Math.min(i + 1, resultados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndiceActivo((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setMostrarDropdown(false);
      setIndiceActivo(-1);
    }
  }

  // No se quita la línea sola aunque quede en 0 — productos por peso (ej.
  // 0.3kg) pasan por un "0" o un "0." intermedio mientras se escribe la
  // cantidad, y sacarla de encima ahí mismo obligaría a buscar el producto
  // de nuevo. Solo se quita con el botón "quitar" o "vaciar carrito".
  function cambiarCantidad(producto_id: string, cantidad: number) {
    const nuevo = activo.carrito.map((l) =>
      l.producto_id === producto_id ? { ...l, cantidad: Math.max(0, cantidad) } : l
    );
    actualizarActivo({ carrito: nuevo });
  }

  function quitarLinea(producto_id: string) {
    actualizarActivo({ carrito: activo.carrito.filter((l) => l.producto_id !== producto_id) });
  }

  function limpiarCarrito() {
    if (activo.carrito.length === 0 && activo.pagos.length === 0) return;
    const ok = confirm("¿Vaciar el carrito de este ticket? Se perderán los productos y pagos agregados.");
    if (!ok) return;
    actualizarActivo({ carrito: [], pagos: [] });
    setMensaje(null);
    setMontoNuevo("");
    setRefNueva("");
  }

  function agregarPago() {
    const monto = Number(montoNuevo);
    if (!monto || monto <= 0) return;
    actualizarActivo({
      pagos: [...activo.pagos, { metodo: metodoNuevo, monto_bs: monto, referencia: refNueva || undefined }],
    });
    setMontoNuevo("");
    setRefNueva("");
  }

  function quitarPago(idx: number) {
    actualizarActivo({ pagos: activo.pagos.filter((_, i) => i !== idx) });
  }

  // Núcleo compartido entre "Confirmar venta" (usa los pagos ya agregados
  // a mano) y los botones de cobro rápido (arman el pago completo de un
  // solo método sin pasar por el formulario). Recibe la lista de pagos ya
  // decidida para no depender del estado de React justo después de
  // actualizarlo (setState es asíncrono).
  async function procesarVenta(pagosBase: LineaPago[]) {
    if (guardando) return;
    setMensaje(null);

    const carrito = activo.carrito;

    if (carrito.length === 0) {
      setMensaje("Agrega al menos un producto antes de cobrar.");
      return;
    }
    const sinStock = carrito.find((l) => l.cantidad > l.stock_disponible);
    if (sinStock) {
      const continuar = confirm(
        `"${sinStock.nombre}" tiene ${sinStock.stock_disponible} en stock y estás vendiendo ${sinStock.cantidad}. ¿Continuar de todas formas?`
      );
      if (!continuar) return;
    }

    const totalPagadoBase = pagosBase.reduce((acc, p) => acc + p.monto_bs, 0);
    // Contra el total COMBINADO (carrito + deuda vieja si se eligió sumarla)
    // — así "cobrar completo" y el aviso de crédito consideran todo lo que
    // hay que cubrir, no solo el carrito.
    const restanteBase = Number((totalConDeuda - totalPagadoBase).toFixed(2));

    const esCredito = restanteBase > 0.01;
    if (esCredito && activo.bloquearCredito) {
      setMensaje(
        `Elegiste cobrar completo a ${activo.clienteNombre || "este cliente"} — falta Bs ${restanteBase.toFixed(2)}. Complétalo o cambia tu elección arriba si prefieres dejarlo a crédito.`
      );
      return;
    }
    if (esCredito) {
      if (!activo.clienteId) {
        setMensaje(
          `Falta cubrir Bs ${restanteBase.toFixed(2)}. Para dejarlo a crédito, selecciona primero al cliente por su cédula.`
        );
        return;
      }
      if (!activo.clienteCreditoAutorizado) {
        const autorizar = confirm(
          `${activo.clienteNombre} no tiene crédito autorizado. ¿Quieres autorizarlo ahora y continuar con esta venta a crédito?`
        );
        if (!autorizar) {
          setMensaje(
            `Venta no confirmada — ${activo.clienteNombre} no tiene crédito autorizado. Cobra el resto o autorízalo para dejarlo a crédito.`
          );
          return;
        }
        const db = await getDb();
        await db.execute("UPDATE clientes SET credito_autorizado = 1 WHERE id = $1", [activo.clienteId]);
        actualizarActivo({ clienteCreditoAutorizado: true });
      }
    }
    if (restanteBase < -0.01) {
      setMensaje(`Los pagos superan el total por Bs ${Math.abs(restanteBase).toFixed(2)}. Ajusta los montos.`);
      return;
    }

    // Si se combinó la deuda vieja, lo que se pagó se aplica PRIMERO a esa
    // deuda (se salda con un abono aparte) y lo que sobra a esta venta —
    // en ese orden, para que "sumar y abonar" con un pago que no alcanza
    // para todo primero reduzca la deuda más vieja, igual criterio que ya
    // usa un abono normal.
    let pagosParaDeuda: LineaPago[] = [];
    let pagosParaVenta = pagosBase;
    if (activo.combinarDeuda && deudaBsHoy > 0.01) {
      const dividido = dividirPagos(pagosBase, deudaBsHoy);
      pagosParaDeuda = dividido.consumidos;
      pagosParaVenta = dividido.restantes;
    }

    const totalPagadoVenta = pagosParaVenta.reduce((acc, p) => acc + p.monto_bs, 0);
    const restanteVenta = Number((total - totalPagadoVenta).toFixed(2));
    const ventaEsCredito = restanteVenta > 0.01;
    const montoPendienteUsd = ventaEsCredito ? restanteVenta / config.tasa_cambio_dia : null;
    const pagosReales = [...pagosParaVenta];
    if (ventaEsCredito) {
      pagosReales.push({ metodo: "CREDITO", monto_bs: restanteVenta });
    }

    // No se guarda todavía — se muestra el resumen para que la caja
    // confirme (ver ejecutarVentaConfirmada, que es quien de verdad llama
    // a confirmar_venta).
    setConfirmacionVenta({ pagosReales, esCredito: ventaEsCredito, montoPendienteUsd, pagosParaDeuda });
  }

  function confirmarVenta() {
    return procesarVenta(activo.pagos);
  }

  function cancelarConfirmacionVenta() {
    setConfirmacionVenta(null);
  }

  async function ejecutarVentaConfirmada() {
    if (!confirmacionVenta || guardando) return;
    const { pagosReales, montoPendienteUsd, esCredito, pagosParaDeuda } = confirmacionVenta;
    const carrito = activo.carrito;
    // Línea automática del recargo de delivery (ver recargoDeliveryBs más
    // arriba) — se agrega sola al guardar, tanto a los items reales de la
    // venta como al ticket impreso, sin que el cajero tenga que buscar
    // ningún producto a mano.
    const lineaRecargoDelivery: LineaCarrito | null =
      activo.esDelivery && totalUnidadesCarrito > 0
        ? {
            producto_id: PRODUCTO_DELIVERY_ID,
            codigo_barra: "1111111",
            nombre: "DELIVERY",
            cantidad: totalUnidadesCarrito,
            precio_unit_bs: COMISION_USD_POR_PRODUCTO * config.tasa_cambio_dia,
            es_gravable: 0,
            tasa_iva: 0,
            stock_disponible: 0,
            por_peso: 0,
          }
        : null;
    const carritoConRecargo = lineaRecargoDelivery ? [...carrito, lineaRecargoDelivery] : carrito;

    setGuardando(true);
    const id = crypto.randomUUID();
    const fechaHora = fechaHoraVenezuela();

    // Si se combinó la deuda vieja, primero se salda (parcial o total)
    // con un abono aparte por cada línea de pago que le corresponde —
    // antes de registrar la venta actual, para que el orden en el
    // historial del cliente quede correcto (se abona la deuda vieja, y
    // recién después se genera el nuevo ticket).
    if (pagosParaDeuda.length > 0 && activo.clienteCedula) {
      for (const p of pagosParaDeuda) {
        try {
          await invoke("registrar_abono_cliente_total", {
            input: {
              cliente_cedula: activo.clienteCedula,
              monto_usd: p.monto_bs / config.tasa_cambio_dia,
              tasa_cambio_dia: config.tasa_cambio_dia,
              metodo: p.metodo,
            },
          });
        } catch (e) {
          setMensaje(`No se pudo aplicar el abono a la deuda anterior: ${String(e)}`);
          setGuardando(false);
          setConfirmacionVenta(null);
          return;
        }
      }
    }

    let numeroTicket: string;
    let sinConexion: boolean;
    try {
      // Todo esto se guarda en una sola transacción real dentro de Rust
      // (ver src-tauri/src/comandos.rs) — si algo falla a mitad de camino,
      // no queda ni la venta ni el descuento de stock a medias. Si no hay
      // conexión, queda en una cola local y se sincroniza sola con Turso
      // más tarde (sin_conexion=true, numero_ticket queda provisional).
      const resultado = await invoke<{ numero_ticket: string; sin_conexion: boolean }>("confirmar_venta", {
        input: {
          id,
          fecha_hora: fechaHora,
          cliente_nombre: activo.clienteNombre || null,
          cliente_cedula: activo.clienteCedula || null,
          cliente_direccion: activo.clienteDireccion || null,
          vendedor_id: vendedor?.id ?? null,
          vendedor_nombre: vendedor?.nombre ?? null,
          tasa_cambio_dia: config.tasa_cambio_dia,
          subtotal_bs: subtotal,
          iva_bs: 0,
          total_bs: total,
          estado: esCredito ? "CREDITO_PENDIENTE" : "COMPLETADA",
          monto_pendiente_usd: montoPendienteUsd,
          canal: activo.esDelivery ? "DELIVERY" : "TIENDA",
          repartidor_id: activo.esDelivery ? activo.repartidorId : null,
          items: carritoConRecargo.map((l) => ({
            producto_id: l.producto_id,
            cantidad: l.cantidad,
            precio_unit_bs: l.precio_unit_bs,
          })),
          pagos: pagosReales.map((p) => ({
            metodo: p.metodo,
            monto_bs: p.monto_bs,
            referencia: p.referencia ?? null,
          })),
        },
      });
      numeroTicket = resultado.numero_ticket;
      sinConexion = resultado.sin_conexion;
    } catch (e) {
      setMensaje(`No se pudo registrar la venta: ${String(e)}`);
      setGuardando(false);
      setConfirmacionVenta(null);
      return;
    }

    setRecibo({
      numero: numeroTicket,
      fechaHora,
      vendedor: vendedor?.nombre ?? "Sin especificar",
      lineas: carritoConRecargo,
      pagos: pagosReales,
      subtotal,
      total,
      cliente: activo.clienteNombre ? `${activo.clienteNombre} (${activo.clienteCedula})` : "Consumidor final",
      clienteDireccion: activo.clienteDireccion,
      tasa: config.tasa_cambio_dia,
      sinConexion,
    });

    setTickets((prev) => {
      const resto = prev.filter((t) => t.id !== activo.id);
      if (resto.length === 0) {
        const nuevo = ticketVacio();
        setActiveId(nuevo.id);
        return [nuevo];
      }
      setActiveId(resto[0].id);
      return resto;
    });

    setMontoNuevo("");
    setRefNueva("");
    setGuardando(false);
    setConfirmacionVenta(null);
    onTasaVista();
    inputRef.current?.focus();
  }

  // Cobro en un solo click: para el caso más común (un solo método cubre
  // el total exacto), evita que el cajero tenga que escribir el monto y
  // luego apretar "Agregar pago" antes de confirmar.
  function cobrarRapido(metodo: MetodoPago) {
    if (restante <= 0.01) return procesarVenta(activo.pagos);
    return procesarVenta([...activo.pagos, { metodo, monto_bs: restante }]);
  }

  function imprimirTicket() {
    window.print();
  }

  if (recibo) {
    return (
      <div className="card ticket">
        <h2>Venta registrada ✅</h2>
        {recibo.sinConexion && (
          <p style={{ background: "#fff3cd", color: "#7a5c00", padding: "8px 12px", borderRadius: 6, fontWeight: 600 }}>
            ⚠ Guardada sin conexión — el número de ticket es provisional y se ajustará solo cuando vuelva internet.
          </p>
        )}
        <img src={logo} alt={config.nombre_negocio} className="ticket-logo" />
        <p className="ticket-meta">
          Ticket {recibo.numero} — {formatearFechaHora(recibo.fechaHora)}
          <br />
          Vendedor: {recibo.vendedor}
          <br />
          Cliente: {recibo.cliente}
          {recibo.clienteDireccion && (
            <>
              <br />
              Dirección: {recibo.clienteDireccion}
            </>
          )}
        </p>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Cant.</th>
              <th>Precio Bs</th>
              <th>Precio USD</th>
              <th>Subtotal USD</th>
              <th>Subtotal Bs</th>
            </tr>
          </thead>
          <tbody>
            {recibo.lineas.map((l) => (
              <tr key={l.producto_id}>
                <td>{l.nombre}</td>
                <td>{l.cantidad}</td>
                <td>{l.precio_unit_bs.toFixed(2)}</td>
                <td>{(l.precio_unit_bs / recibo.tasa).toFixed(2)}</td>
                <td>{((l.precio_unit_bs * l.cantidad) / recibo.tasa).toFixed(2)}</td>
                <td>{(l.precio_unit_bs * l.cantidad).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>Subtotal: Bs {recibo.subtotal.toFixed(2)}</p>
        <p className="ticket-total">
          Total: Bs {recibo.total.toFixed(2)}{" "}
          <span style={{ fontWeight: 400, fontSize: 13, color: "#5f5e5a" }}>
            (USD {(recibo.total / recibo.tasa).toFixed(2)})
          </span>
        </p>
        <p>Pagos: {recibo.pagos.map((p) => `${p.metodo} Bs ${p.monto_bs.toFixed(2)}`).join(" · ")}</p>
        <div className="form-row no-print">
          <button onClick={imprimirTicket}>Imprimir ticket</button>
          <button onClick={() => setRecibo(null)}>Volver a la caja</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="ticket-tabs">
        {tickets.map((t, i) => {
          const { total: totalCarritoT } = calcularTotales(t.carrito, config.tasa_cambio_dia);
          const unidadesT = t.carrito.reduce((acc, l) => acc + (l.por_peso ? 1 : l.cantidad), 0);
          const totalT = t.esDelivery ? totalCarritoT + unidadesT * COMISION_USD_POR_PRODUCTO * config.tasa_cambio_dia : totalCarritoT;
          return (
            <div key={t.id} className={`ticket-tab ${t.id === activeId ? "ticket-tab-activo" : ""}`}>
              <button className="ticket-tab-btn" onClick={() => cambiarDeTicket(t.id)}>
                Ticket {i + 1}
                {t.carrito.length > 0 ? ` · ${t.carrito.length} ítem${t.carrito.length > 1 ? "s" : ""} · Bs ${totalT.toFixed(0)}` : ""}
              </button>
              {tickets.length > 1 && (
                <button className="ticket-tab-cerrar" title="Cerrar ticket" onClick={() => cerrarTicket(t.id)}>
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button className="ticket-tab-nuevo" onClick={nuevoTicket} title="Nuevo ticket">
          + Nuevo
        </button>
      </div>

      <div className="card" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", fontSize: 13, color: "#5f5e5a" }}>
        <span>Próximo N° de venta: <strong>{proximoNumero}</strong></span>
        <span>{formatearFechaHora(horaActual)} (Venezuela)</span>
        <span>Vendedor: <strong>{vendedor?.nombre ?? "sin seleccionar"}</strong></span>
      </div>

      <div className="venta-layout">
        <div className="card">
          <form onSubmit={buscarYAgregar} className="form-row" style={{ position: "relative" }}>
            <input
              ref={inputRef}
              placeholder="Escanear código, o escribir nombre/código"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={onKeyDownBusqueda}
              onBlur={() => setTimeout(() => setMostrarDropdown(false), 150)}
              onFocus={() => resultados.length > 0 && setMostrarDropdown(true)}
              autoFocus
            />
            <button type="submit">Agregar</button>

            {mostrarDropdown && (
              <ul
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 90,
                  background: "#fff",
                  border: "1px solid #d3d1c7",
                  borderRadius: 8,
                  listStyle: "none",
                  margin: 0,
                  padding: 4,
                  zIndex: 10,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                }}
              >
                {resultados.map((p, i) => (
                  <li
                    key={p.id}
                    onMouseDown={() => agregarAlCarrito(p)}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: i === indiceActivo ? "#f1efe8" : "transparent",
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 14,
                    }}
                  >
                    <span>{p.nombre}</span>
                    <span style={{ color: "#5f5e5a" }}>
                      {p.codigo_barra} · Bs {precioVentaBsHoy(p, config.tasa_cambio_dia).toFixed(2)} (USD{" "}
                      {precioVentaUsd(p).toFixed(2)})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </form>
          {mensaje && <p className="error">{mensaje}</p>}

          {codigoSinAsignar && (
            <div className="aviso-credito">
              {pendientesAsignacion.length > 0 ? (
                <>
                  <p>
                    El código "{codigoSinAsignar}" no existe. ¿Es uno de estos productos nuevos
                    (creados desde una factura, todavía sin código de barras)?
                  </p>
                  <div className="form-row">
                    {pendientesAsignacion.map((p) => (
                      <button key={p.id} type="button" onClick={() => asignarCodigoYAgregar(p)}>
                        {p.nombre}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setCodigoSinAsignar(null);
                        setPendientesAsignacion([]);
                      }}
                    >
                      no es ninguno, cancelar
                    </button>
                  </div>
                </>
              ) : (
                <p>
                  El código "{codigoSinAsignar}" no existe y tampoco hay productos pendientes de
                  código de barras. Créalo desde Compras o Inventario primero.
                </p>
              )}
            </div>
          )}

          {activo.carrito.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <button type="button" className="link-btn link-btn-danger" onClick={limpiarCarrito}>
                vaciar carrito
              </button>
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Cant.</th>
                <th>Precio Bs</th>
                <th>Precio USD</th>
                <th>Subtotal USD</th>
                <th>Subtotal Bs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activo.carrito.map((l) => (
                <tr key={l.producto_id}>
                  <td>{l.nombre}</td>
                  <td>
                    <input
                      type="number"
                      className="cant-input"
                      value={l.cantidad}
                      onChange={(e) => cambiarCantidad(l.producto_id, Number(e.target.value))}
                    />
                  </td>
                  <td>{l.precio_unit_bs.toFixed(2)}</td>
                  <td>{(l.precio_unit_bs / config.tasa_cambio_dia).toFixed(2)}</td>
                  <td>{((l.precio_unit_bs * l.cantidad) / config.tasa_cambio_dia).toFixed(2)}</td>
                  <td>{(l.precio_unit_bs * l.cantidad).toFixed(2)}</td>
                  <td>
                    <button className="link-btn link-btn-danger" onClick={() => quitarLinea(l.producto_id)}>
                      quitar
                    </button>
                  </td>
                </tr>
              ))}
              {activo.carrito.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    Carrito vacío. Escanea el primer producto.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="totales">
            <span>Subtotal: Bs {subtotal.toFixed(2)}</span>
            <strong>
              Total: Bs {total.toFixed(2)}{" "}
              <span className="hint" style={{ margin: 0 }}>
                (USD {(total / config.tasa_cambio_dia).toFixed(2)})
              </span>
            </strong>
          </div>
        </div>

        <div className="card">
          <h2>Cliente</h2>
          {activo.clienteId ? (
            <>
              <p className="hint">
                {activo.clienteNombre} — {activo.clienteCedula}{" "}
                {activo.clienteCreditoAutorizado ? "· crédito autorizado" : "· sin crédito autorizado"}{" "}
                <button className="link-btn link-btn-danger" onClick={quitarCliente}>
                  quitar
                </button>
              </p>
              {!activo.avisoCreditoResuelto && activo.deudaPendienteUsd > 0.01 && (
                <div className="aviso-credito">
                  <p>
                    ⚠ <strong>{activo.clienteNombre}</strong> ya tiene una deuda pendiente de{" "}
                    <strong>USD {activo.deudaPendienteUsd.toFixed(2)}</strong> (Bs{" "}
                    {(activo.deudaPendienteUsd * config.tasa_cambio_dia).toFixed(2)}) de ventas anteriores.
                    ¿Qué haces con esta venta?
                  </p>
                  <div className="form-row">
                    <button
                      type="button"
                      title="El total a cobrar de este ticket pasa a incluir la deuda vieja — hay que cubrirlo completo."
                      onClick={() =>
                        actualizarActivo({ avisoCreditoResuelto: true, bloquearCredito: true, combinarDeuda: true })
                      }
                    >
                      Sumar a la cuenta actual
                    </button>
                    <button
                      type="button"
                      title="La deuda vieja queda aparte, sin tocar — esta venta es independiente."
                      onClick={() =>
                        actualizarActivo({ avisoCreditoResuelto: true, bloquearCredito: false, combinarDeuda: false })
                      }
                    >
                      No sumar
                    </button>
                    <button
                      type="button"
                      disabled={!activo.clienteCreditoAutorizado}
                      title={
                        activo.clienteCreditoAutorizado
                          ? "Se suma la deuda vieja a esta venta, pero se puede pagar solo una parte — el resto queda como el nuevo crédito."
                          : "Este cliente no tiene crédito autorizado — actívalo en su ficha primero."
                      }
                      onClick={() =>
                        actualizarActivo({ avisoCreditoResuelto: true, bloquearCredito: false, combinarDeuda: true })
                      }
                    >
                      Sumar y abonar
                    </button>
                  </div>
                  {activo.combinarDeuda && (
                    <p className="hint" style={{ marginTop: 6 }}>
                      Total a cobrar ahora: Bs {totalConDeuda.toFixed(2)} (carrito Bs {total.toFixed(2)} + deuda
                      vieja Bs {deudaBsHoy.toFixed(2)}).
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={{ position: "relative" }}>
              <div className="form-row">
                <input
                  placeholder="Buscar cliente por cédula o nombre"
                  value={clienteBusqueda}
                  onChange={(e) => setClienteBusqueda(e.target.value)}
                  onFocus={() => clienteResultados.length > 0 && setClienteMostrarDropdown(true)}
                  onBlur={() => setTimeout(() => setClienteMostrarDropdown(false), 150)}
                />
              </div>
              {clienteMostrarDropdown && (
                <ul
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: 0,
                    background: "#fff",
                    border: "1px solid #d3d1c7",
                    borderRadius: 8,
                    listStyle: "none",
                    margin: 0,
                    padding: 4,
                    zIndex: 10,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                  }}
                >
                  {clienteResultados.map((c) => (
                    <li
                      key={c.id}
                      onMouseDown={() => seleccionarCliente(c)}
                      style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 14 }}
                    >
                      {c.nombre} — {c.cedula} {c.credito_autorizado ? "(crédito ✓)" : ""}
                    </li>
                  ))}
                  {clienteResultados.length === 0 && clienteBusqueda.trim().length >= 2 && (
                    <li style={{ padding: "8px 10px", fontSize: 13, color: "#5f5e5a" }}>
                      Sin resultados para "{clienteBusqueda}".
                      {!mostrarClienteNuevo && (
                        <button
                          className="link-btn"
                          style={{ marginLeft: 6 }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            // La cédula ya tecleada en la búsqueda es casi
                            // siempre la del cliente nuevo — se precarga,
                            // pero queda editable por si escribieron el
                            // nombre en vez de la cédula.
                            setClienteNuevoCedula(clienteBusqueda.trim());
                            setMostrarClienteNuevo(true);
                          }}
                        >
                          crear cliente nuevo
                        </button>
                      )}
                    </li>
                  )}
                </ul>
              )}
              {mostrarClienteNuevo && (
                <div className="form-row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                  <input
                    placeholder="Nombre"
                    value={clienteNuevoNombre}
                    onChange={(e) => setClienteNuevoNombre(e.target.value)}
                  />
                  <input
                    placeholder="Cédula"
                    value={clienteNuevoCedula}
                    onChange={(e) => setClienteNuevoCedula(e.target.value)}
                  />
                  <input
                    placeholder="Teléfono (opcional)"
                    value={clienteNuevoTelefono}
                    onChange={(e) => setClienteNuevoTelefono(e.target.value)}
                  />
                  <input
                    placeholder="Dirección (opcional)"
                    value={clienteNuevoDireccion}
                    onChange={(e) => setClienteNuevoDireccion(e.target.value)}
                  />
                  <button type="button" onClick={crearClienteRapido}>
                    Crear y usar
                  </button>
                  <button type="button" className="link-btn" onClick={() => setMostrarClienteNuevo(false)}>
                    cancelar
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="form-row" style={{ marginTop: 16, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={activo.esDelivery}
                onChange={(e) =>
                  actualizarActivo({
                    esDelivery: e.target.checked,
                    repartidorId: e.target.checked ? activo.repartidorId : null,
                  })
                }
              />
              Es delivery (WhatsApp)
            </label>
            {activo.esDelivery && (
              <select
                value={activo.repartidorId ?? ""}
                onChange={(e) => actualizarActivo({ repartidorId: e.target.value || null })}
              >
                <option value="">Repartidor (opcional, se puede asignar después)…</option>
                {repartidores.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </select>
            )}
          </div>
          {activo.esDelivery && (
            <div className="previsualizacion" style={{ marginTop: 8 }}>
              Recargo de delivery: <strong>Bs {recargoDeliveryBs.toFixed(2)}</strong>{" "}
              <span className="hint" style={{ margin: 0 }}>
                ({totalUnidadesCarrito} producto{totalUnidadesCarrito === 1 ? "" : "s"} × USD{" "}
                {COMISION_USD_POR_PRODUCTO.toFixed(2)})
              </span>
              <br />
              <span className="hint" style={{ marginTop: 4 }}>
                Ya se suma solo al total a cobrar — no hace falta agregar ningún producto a mano.
              </span>
            </div>
          )}

          <h2 style={{ marginTop: 16 }}>Cobro</h2>

          {activo.carrito.length > 0 && restante > 0.01 && (
            <div className="cobro-rapido">
              <button
                type="button"
                className="cobro-rapido-btn"
                disabled={guardando}
                onClick={() => cobrarRapido("PUNTO_VENTA")}
              >
                Punto de venta · Bs {restante.toFixed(2)}
              </button>
              <button
                type="button"
                className="cobro-rapido-btn"
                disabled={guardando}
                onClick={() => cobrarRapido("BIOPAGO")}
              >
                Biopago · Bs {restante.toFixed(2)}
              </button>
              <button
                type="button"
                className="cobro-rapido-btn"
                disabled={guardando}
                onClick={() => cobrarRapido("PAGO_MOVIL")}
              >
                Pago móvil · Bs {restante.toFixed(2)}
              </button>
              <button
                type="button"
                className="cobro-rapido-btn"
                disabled={guardando}
                onClick={() => cobrarRapido("EFECTIVO")}
              >
                Efectivo · Bs {restante.toFixed(2)}
              </button>
              <button
                type="button"
                className="cobro-rapido-btn"
                disabled={guardando}
                onClick={() => cobrarRapido("DIVISAS")}
              >
                Divisas · Bs {restante.toFixed(2)}
              </button>
              <button
                type="button"
                className="cobro-rapido-btn"
                disabled={guardando}
                onClick={() => cobrarRapido("TRANSFERENCIA")}
              >
                Transferencia · Bs {restante.toFixed(2)}
              </button>
            </div>
          )}

          <p className="hint" style={{ marginTop: activo.carrito.length > 0 && restante > 0.01 ? 10 : 0 }}>
            {activo.carrito.length > 0 && restante > 0.01
              ? "¿Paga con otro método o divide el pago? Agrégalo abajo:"
              : "Pago dividido o a crédito:"}
          </p>
          <div className="form-row">
            <select value={metodoNuevo} onChange={(e) => setMetodoNuevo(e.target.value as MetodoPago)}>
              {METODOS_PAGO.map((m) => (
                <option key={m} value={m}>
                  {m.split("_").join(" ")}
                </option>
              ))}
            </select>
            <input
              placeholder="Monto Bs"
              type="number"
              step="0.01"
              value={montoNuevo}
              onChange={(e) => setMontoNuevo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && agregarPago()}
            />
            <input
              placeholder="Referencia (opcional)"
              value={refNueva}
              onChange={(e) => setRefNueva(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && agregarPago()}
            />
            <button type="button" onClick={agregarPago}>
              Agregar pago
            </button>
          </div>

          <ul className="lista-pagos">
            {activo.pagos.map((p, i) => (
              <li key={i}>
                {p.metodo.split("_").join(" ")} — Bs {p.monto_bs.toFixed(2)} {p.referencia ? `(${p.referencia})` : ""}
                <button className="link-btn link-btn-danger" onClick={() => quitarPago(i)}>
                  quitar
                </button>
              </li>
            ))}
          </ul>

          <div className="totales">
            <span>
              Pagado: Bs {totalPagado.toFixed(2)}{" "}
              <span className="hint" style={{ margin: 0 }}>
                (USD {(totalPagado / config.tasa_cambio_dia).toFixed(2)})
              </span>
            </span>
            <strong className={restante > 0.01 ? "restante-pendiente" : ""}>
              {restante > 0.01
                ? `Falta: Bs ${restante.toFixed(2)} (USD ${(restante / config.tasa_cambio_dia).toFixed(2)})`
                : "Cubierto ✓"}
            </strong>
          </div>

          <button className="cobrar-btn" onClick={confirmarVenta} disabled={guardando}>
            {guardando ? "Guardando…" : "Confirmar venta"}
          </button>
        </div>
      </div>

      <div className="card">
        <button type="button" className="consumo-interno-toggle" onClick={() => setMostrarConsumo((v) => !v)}>
          <h2 style={{ margin: 0 }}>
            {mostrarConsumo ? "▾" : "▸"} Consumo interno del día
            {consumoInterno.length > 0 ? ` · ${consumoInterno.length} producto${consumoInterno.length > 1 ? "s" : ""}` : ""}
          </h2>
        </button>
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          Productos que salen del inventario sin ser una venta (mermas, uso propio, muestras). Ve
          agregando durante el día y guarda todo junto al cerrar — se descuenta del stock real y
          queda como referencia para el cuadre de caja.
        </p>

        {mostrarConsumo && (
          <>
            <form onSubmit={buscarYAgregarConsumo} className="form-row" style={{ position: "relative", marginTop: 14 }}>
              <input
                placeholder="Buscar producto por nombre o código"
                value={busquedaConsumo}
                onChange={(e) => setBusquedaConsumo(e.target.value)}
                onFocus={() => resultadosConsumo.length > 0 && setMostrarDropdownConsumo(true)}
                onBlur={() => setTimeout(() => setMostrarDropdownConsumo(false), 150)}
              />
              <button type="submit">Agregar</button>

              {mostrarDropdownConsumo && (
                <ul
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: 90,
                    background: "#fff",
                    border: "1px solid #d3d1c7",
                    borderRadius: 8,
                    listStyle: "none",
                    margin: 0,
                    padding: 4,
                    zIndex: 10,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                  }}
                >
                  {resultadosConsumo.map((p) => (
                    <li
                      key={p.id}
                      onMouseDown={() => agregarAConsumo(p)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 14,
                      }}
                    >
                      <span>{p.nombre}</span>
                      <span style={{ color: "#5f5e5a" }}>
                        {p.codigo_barra} · stock {formatearStock(p.stock_actual)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </form>

            {mensajeConsumo && (
              <p className={mensajeConsumo.includes("✅") ? "hint" : "error"}>{mensajeConsumo}</p>
            )}

            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cant.</th>
                  <th>Motivo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {consumoInterno.map((l) => (
                  <tr key={l.producto_id}>
                    <td>{l.nombre}</td>
                    <td>
                      <input
                        type="number"
                        className="cant-input"
                        value={l.cantidad}
                        onChange={(e) => cambiarCantidadConsumo(l.producto_id, Number(e.target.value))}
                      />
                    </td>
                    <td>
                      <input
                        value={l.motivo}
                        list="motivos-consumo-interno"
                        onChange={(e) => cambiarMotivoConsumo(l.producto_id, e.target.value)}
                        style={{ width: "100%", padding: "6px 8px", border: "1px solid #b4b2a9", borderRadius: 6 }}
                      />
                    </td>
                    <td>
                      <button className="link-btn link-btn-danger" onClick={() => quitarLineaConsumo(l.producto_id)}>
                        quitar
                      </button>
                    </td>
                  </tr>
                ))}
                {consumoInterno.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      Sin productos agregados todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <datalist id="motivos-consumo-interno">
              <option value="Consumo interno" />
              <option value="Merma" />
              <option value="Producto vencido" />
              <option value="Producto dañado" />
              <option value="Muestra / obsequio" />
            </datalist>

            {consumoInterno.length > 0 && (
              <div className="totales">
                <span>Costo estimado: USD {totalConsumoUsd.toFixed(2)}</span>
                <button onClick={guardarConsumoInterno} disabled={guardandoConsumo}>
                  {guardandoConsumo ? "Guardando…" : "Guardar consumo interno del día"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <button type="button" className="consumo-interno-toggle" onClick={() => setMostrarAvances((v) => !v)}>
          <h2 style={{ margin: 0 }}>
            {mostrarAvances ? "▾" : "▸"} Avances de efectivo del día
            {avancesHoy.length > 0 ? ` · ${avancesHoy.length}` : ""}
          </h2>
        </button>
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          El cliente pide efectivo y se le cobra un monto mayor por otro método — la diferencia es
          la comisión del negocio. Esto se guarda al momento y afecta el cuadre de caja: sube el
          esperado del método con el que se cobró, y baja el esperado de efectivo (sale de la caja
          física sin importar la fuente). Un aporte de capital externo también sube el esperado de
          efectivo, porque ese dinero entra a la misma caja.
        </p>

        {mostrarAvances && (
          <>
            <div className="card" style={{ background: "#f7f6f2" }}>
              <div className="form-row" style={{ alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>
                  Capital externo disponible:{" "}
                  <span className={saldoCapitalExterno <= 0 ? "restante-pendiente" : ""}>
                    Bs {saldoCapitalExterno.toFixed(2)}
                  </span>
                </h2>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>
                Cuando entra dinero de fuera de la caja para financiar avances (ej. te depositan Bs
                500), regístralo acá — el saldo baja solo cada vez que un avance sale de "Capital
                externo".
              </p>
              <div className="form-row">
                <input
                  type="number"
                  step="0.01"
                  placeholder="Monto del aporte (Bs)"
                  value={montoAporteNuevo}
                  onChange={(e) => setMontoAporteNuevo(e.target.value)}
                  style={{ maxWidth: 180 }}
                />
                <input
                  placeholder="Nota (opcional)"
                  value={notaAporteNuevo}
                  onChange={(e) => setNotaAporteNuevo(e.target.value)}
                />
                <button type="button" onClick={registrarAporteCapitalExterno} disabled={guardandoAporte}>
                  {guardandoAporte ? "Guardando…" : "Registrar aporte"}
                </button>
              </div>
              {mensajeAporte && <p className="error">{mensajeAporte}</p>}
              {aportesCapitalExterno.length > 0 && (
                <ul className="lista-pagos">
                  {aportesCapitalExterno.map((a) => (
                    <li key={a.id}>
                      {formatearFechaHora(a.created_at)} — Bs {a.monto_bs.toFixed(2)}
                      {a.nota ? ` (${a.nota})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="form-grid" style={{ marginTop: 14 }}>
              <div className="campo">
                <label>Efectivo entregado (Bs)</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="Ej. 300"
                  value={avanceMontoEfectivo}
                  onChange={(e) => setAvanceMontoEfectivo(e.target.value)}
                />
              </div>
              <div className="campo">
                <label>Monto cobrado (Bs)</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="Ej. 330"
                  value={avanceMontoCobrado}
                  onChange={(e) => setAvanceMontoCobrado(e.target.value)}
                />
              </div>
              <div className="campo">
                <label>Método de cobro</label>
                <select value={avanceMetodoCobro} onChange={(e) => setAvanceMetodoCobro(e.target.value as MetodoPago)}>
                  {METODOS_PAGO.filter((m) => m !== "EFECTIVO").map((m) => (
                    <option key={m} value={m}>
                      {m.split("_").join(" ")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="campo">
                <label>Efectivo de</label>
                <select value={avanceFuente} onChange={(e) => setAvanceFuente(e.target.value as "CAJA" | "CAPITAL_EXTERIOR")}>
                  <option value="CAJA">Esta caja</option>
                  <option value="CAPITAL_EXTERIOR">Capital externo</option>
                </select>
              </div>
              <div className="campo">
                <label>Referencia (opcional)</label>
                <input
                  placeholder="Últimos dígitos, nombre..."
                  value={avanceReferencia}
                  onChange={(e) => setAvanceReferencia(e.target.value)}
                />
              </div>
              <div className="campo-boton">
                <button type="button" onClick={registrarAvance} disabled={guardandoAvance}>
                  {guardandoAvance ? "Guardando…" : "Registrar avance"}
                </button>
              </div>
            </div>
            {avanceMontoEfectivo && avanceMontoCobrado && Number(avanceMontoCobrado) > Number(avanceMontoEfectivo) && (
              <p className="hint">Comisión: Bs {(Number(avanceMontoCobrado) - Number(avanceMontoEfectivo)).toFixed(2)}</p>
            )}
            {mensajeAvance && <p className="error">{mensajeAvance}</p>}

            <table>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Efectivo</th>
                  <th>Cobrado</th>
                  <th>Comisión</th>
                  <th>Método</th>
                  <th>Origen</th>
                  <th>Referencia</th>
                </tr>
              </thead>
              <tbody>
                {avancesHoy.map((a) => (
                  <tr key={a.id}>
                    <td>{a.created_at.split(" ")[1]?.slice(0, 5)}</td>
                    <td>{a.monto_efectivo_bs.toFixed(2)}</td>
                    <td>{a.monto_cobrado_bs.toFixed(2)}</td>
                    <td>{(a.monto_cobrado_bs - a.monto_efectivo_bs).toFixed(2)}</td>
                    <td>{a.metodo_cobro.split("_").join(" ")}</td>
                    <td>{a.fuente_efectivo === "CAJA" ? "Esta caja" : "Capital externo"}</td>
                    <td>{a.referencia ?? "—"}</td>
                  </tr>
                ))}
                {avancesHoy.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      Sin avances registrados hoy.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {avancesHoy.length > 0 && (
              <div className="totales">
                <span>Efectivo entregado: Bs {avancesHoy.reduce((acc, a) => acc + a.monto_efectivo_bs, 0).toFixed(2)}</span>
                <strong>
                  Comisión del día: Bs{" "}
                  {avancesHoy.reduce((acc, a) => acc + (a.monto_cobrado_bs - a.monto_efectivo_bs), 0).toFixed(2)}
                </strong>
              </div>
            )}
          </>
        )}
      </div>

      {confirmacionVenta && (
        <div className="modal-fondo" onMouseDown={cancelarConfirmacionVenta}>
          <div className="modal-caja" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Confirmar venta antes de registrarla</h2>
            <p className="hint">
              Revisa productos, cantidades y método de pago — al confirmar se descuenta el stock y
              queda registrada.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cant.</th>
                  <th>Precio Bs</th>
                  <th>Subtotal Bs</th>
                </tr>
              </thead>
              <tbody>
                {activo.carrito.map((l) => (
                  <tr key={l.producto_id}>
                    <td>{l.nombre}</td>
                    <td>{l.cantidad}</td>
                    <td>{l.precio_unit_bs.toFixed(2)}</td>
                    <td>{(l.precio_unit_bs * l.cantidad).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Cliente:{" "}
              {activo.clienteNombre ? `${activo.clienteNombre} (${activo.clienteCedula})` : "Consumidor final"}
              {activo.clienteDireccion ? ` — ${activo.clienteDireccion}` : ""}
            </p>
            {confirmacionVenta.pagosParaDeuda.length > 0 && (
              <p className="hint">
                Abono a la deuda anterior:{" "}
                {confirmacionVenta.pagosParaDeuda
                  .map((p) => `${p.metodo.split("_").join(" ")} Bs ${p.monto_bs.toFixed(2)}`)
                  .join(" · ")}
              </p>
            )}
            <p>
              Pago de esta venta:{" "}
              {confirmacionVenta.pagosReales.length > 0
                ? confirmacionVenta.pagosReales
                    .map((p) => `${p.metodo.split("_").join(" ")} Bs ${p.monto_bs.toFixed(2)}`)
                    .join(" · ")
                : "—"}
            </p>
            <p className="ticket-total">
              Total: Bs {total.toFixed(2)}{" "}
              <span style={{ fontWeight: 400, fontSize: 13, color: "#5f5e5a" }}>
                (USD {(total / config.tasa_cambio_dia).toFixed(2)})
              </span>
            </p>
            {confirmacionVenta.esCredito && (
              <p className="restante-pendiente">
                Queda a crédito: USD {(confirmacionVenta.montoPendienteUsd ?? 0).toFixed(2)}
              </p>
            )}
            <div className="form-row">
              <button className="cobrar-btn" onClick={ejecutarVentaConfirmada} disabled={guardando}>
                {guardando ? "Registrando…" : "✓ Confirmar y registrar"}
              </button>
              <button className="link-btn" onClick={cancelarConfirmacionVenta} disabled={guardando}>
                cancelar, quiero revisar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}