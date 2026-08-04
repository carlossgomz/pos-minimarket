import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { precioVentaBsHoy, precioVentaUsd } from "../precios";
import { fechaHoraVenezuela } from "../fecha";
import {
  Cliente,
  ConfigRow,
  LineaCarrito,
  LineaPago,
  MetodoPago,
  METODOS_PAGO,
  Producto,
  Vendedor,
} from "../types";

const MAX_TICKETS_ABIERTOS = 6;

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
  clienteCreditoAutorizado: boolean;
  // Deuda que este cliente ya arrastraba de ventas anteriores (no la de
  // este ticket) — se consulta al seleccionarlo, para poder avisarle al
  // cajero antes de que siga sumando más a la cuenta sin darse cuenta.
  deudaPendienteUsd: number;
  avisoCreditoResuelto: boolean;
  // true cuando el cajero eligió explícitamente "cobrar completo" ante el
  // aviso de deuda — bloquea que esta venta se cierre a medio pagar.
  bloquearCredito: boolean;
};

function ticketVacio(): TicketAbierto {
  return {
    id: crypto.randomUUID(),
    carrito: [],
    pagos: [],
    clienteId: null,
    clienteNombre: "",
    clienteCedula: "",
    clienteCreditoAutorizado: false,
    deudaPendienteUsd: 0,
    avisoCreditoResuelto: true,
    bloquearCredito: false,
  };
}

// Este negocio no factura IVA por separado — el precio de venta ya es el
// precio final, así que el total de la venta es directo el subtotal.
function calcularTotales(carrito: LineaCarrito[]) {
  const subtotal = carrito.reduce((acc, l) => acc + l.precio_unit_bs * l.cantidad, 0);
  return { subtotal, total: subtotal };
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
  const [mostrarClienteNuevo, setMostrarClienteNuevo] = useState(false);

  // --- Consumo interno del día (independiente de los tickets de venta) ---
  const [consumoInterno, setConsumoInterno] = useState<LineaConsumoInterno[]>([]);
  const [mostrarConsumo, setMostrarConsumo] = useState(false);
  const [busquedaConsumo, setBusquedaConsumo] = useState("");
  const [resultadosConsumo, setResultadosConsumo] = useState<Producto[]>([]);
  const [mostrarDropdownConsumo, setMostrarDropdownConsumo] = useState(false);
  const [guardandoConsumo, setGuardandoConsumo] = useState(false);
  const [mensajeConsumo, setMensajeConsumo] = useState<string | null>(null);

  const [recibo, setRecibo] = useState<null | {
    numero: string;
    fechaHora: string;
    vendedor: string;
    lineas: LineaCarrito[];
    pagos: LineaPago[];
    subtotal: number;
    total: number;
    cliente: string;
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

  const { subtotal, total } = calcularTotales(activo.carrito);
  const totalPagado = activo.pagos.reduce((acc, p) => acc + p.monto_bs, 0);
  const restante = Number((total - totalPagado).toFixed(2));
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
      const rows = await db.select<Producto[]>(
        "SELECT * FROM productos WHERE activo = 1 AND (nombre LIKE $1 OR codigo_barra LIKE $1) ORDER BY nombre LIMIT 8",
        [`%${term}%`]
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
      const rows = await db.select<Cliente[]>(
        "SELECT * FROM clientes WHERE cedula LIKE $1 OR nombre LIKE $1 ORDER BY nombre LIMIT 6",
        [`%${term}%`]
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
      const rows = await db.select<Producto[]>(
        "SELECT * FROM productos WHERE activo = 1 AND (nombre LIKE $1 OR codigo_barra LIKE $1) ORDER BY nombre LIMIT 8",
        [`%${term}%`]
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
    const rows = await db.select<Producto[]>("SELECT * FROM productos WHERE codigo_barra = $1 AND activo = 1", [codigo]);
    if (rows.length === 0) {
      setMensajeConsumo(`No se encontró ningún producto activo con código "${codigo}".`);
      setBusquedaConsumo("");
      setMostrarDropdownConsumo(false);
      return;
    }
    agregarAConsumo(rows[0]);
  }

  function cambiarCantidadConsumo(producto_id: string, cantidad: number) {
    setConsumoInterno((prev) =>
      prev
        .map((l) => (l.producto_id === producto_id ? { ...l, cantidad: Math.max(0, cantidad) } : l))
        .filter((l) => l.cantidad > 0)
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

  async function seleccionarCliente(c: Cliente) {
    const ticketId = activo.id;
    actualizarActivo({
      clienteId: c.id,
      clienteNombre: c.nombre,
      clienteCedula: c.cedula,
      clienteCreditoAutorizado: !!c.credito_autorizado,
      deudaPendienteUsd: 0,
      avisoCreditoResuelto: true,
      bloquearCredito: false,
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
      clienteCreditoAutorizado: false,
      deudaPendienteUsd: 0,
      avisoCreditoResuelto: true,
      bloquearCredito: false,
    });
  }

  async function crearClienteRapido() {
    const cedula = clienteBusqueda.trim();
    if (!cedula || !clienteNuevoNombre.trim()) {
      setMensaje("Para crear el cliente necesitas cédula y nombre.");
      return;
    }
    const db = await getDb();
    const id = crypto.randomUUID();
    try {
      await db.execute("INSERT INTO clientes (id, nombre, cedula) VALUES ($1,$2,$3)", [
        id,
        clienteNuevoNombre.trim(),
        cedula,
      ]);
    } catch (e) {
      setMensaje(`No se pudo crear el cliente (¿cédula repetida?): ${String(e)}`);
      return;
    }
    seleccionarCliente({ id, nombre: clienteNuevoNombre.trim(), cedula, telefono: null, credito_autorizado: 0 });
    setClienteNuevoNombre("");
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
    const rows = await db.select<Producto[]>(
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

  function cambiarCantidad(producto_id: string, cantidad: number) {
    const nuevo = activo.carrito
      .map((l) => (l.producto_id === producto_id ? { ...l, cantidad: Math.max(0, cantidad) } : l))
      .filter((l) => l.cantidad > 0);
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
    const restanteBase = Number((total - totalPagadoBase).toFixed(2));

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

    setGuardando(true);
    const id = crypto.randomUUID();
    const fechaHora = fechaHoraVenezuela();
    const montoPendienteUsd = esCredito ? restanteBase / config.tasa_cambio_dia : null;

    const pagosReales = [...pagosBase];
    if (esCredito) {
      pagosReales.push({ metodo: "CREDITO", monto_bs: restanteBase });
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
          vendedor_id: vendedor?.id ?? null,
          vendedor_nombre: vendedor?.nombre ?? null,
          tasa_cambio_dia: config.tasa_cambio_dia,
          subtotal_bs: subtotal,
          iva_bs: 0,
          total_bs: total,
          estado: esCredito ? "CREDITO_PENDIENTE" : "COMPLETADA",
          monto_pendiente_usd: montoPendienteUsd,
          items: carrito.map((l) => ({
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
      return;
    }

    setRecibo({
      numero: numeroTicket,
      fechaHora,
      vendedor: vendedor?.nombre ?? "Sin especificar",
      lineas: carrito,
      pagos: pagosReales,
      subtotal,
      total,
      cliente: activo.clienteNombre ? `${activo.clienteNombre} (${activo.clienteCedula})` : "Consumidor final",
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
    onTasaVista();
    inputRef.current?.focus();
  }

  function confirmarVenta() {
    return procesarVenta(activo.pagos);
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
        <p className="ticket-empresa">{config.nombre_negocio}</p>
        <p className="ticket-meta">
          Ticket {recibo.numero} — {formatearFechaHora(recibo.fechaHora)}
          <br />
          Vendedor: {recibo.vendedor}
          <br />
          Cliente: {recibo.cliente}
        </p>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Cant.</th>
              <th>Precio Bs</th>
              <th>Precio USD</th>
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
          const { total: totalT } = calcularTotales(t.carrito);
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
                  <td colSpan={6} className="empty">
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
                      disabled={!activo.clienteCreditoAutorizado}
                      title={
                        activo.clienteCreditoAutorizado
                          ? ""
                          : "Este cliente no tiene crédito autorizado — actívalo en su ficha primero."
                      }
                      onClick={() => actualizarActivo({ avisoCreditoResuelto: true, bloquearCredito: false })}
                    >
                      Sumarla a su cuenta
                    </button>
                    <button
                      type="button"
                      onClick={() => actualizarActivo({ avisoCreditoResuelto: true, bloquearCredito: true })}
                    >
                      No, cobrar completo
                    </button>
                    <button
                      type="button"
                      disabled={!activo.clienteCreditoAutorizado}
                      title={
                        activo.clienteCreditoAutorizado
                          ? ""
                          : "Este cliente no tiene crédito autorizado — actívalo en su ficha primero."
                      }
                      onClick={() => actualizarActivo({ avisoCreditoResuelto: true, bloquearCredito: false })}
                    >
                      Cobra una parte, el resto a la cuenta
                    </button>
                  </div>
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
                <div className="form-row" style={{ marginTop: 8 }}>
                  <input
                    placeholder="Nombre del cliente nuevo"
                    value={clienteNuevoNombre}
                    onChange={(e) => setClienteNuevoNombre(e.target.value)}
                  />
                  <button type="button" onClick={crearClienteRapido}>
                    Crear y usar
                  </button>
                </div>
              )}
            </div>
          )}

          <h2 style={{ marginTop: 16 }}>Cobro</h2>

          {activo.carrito.length > 0 && restante > 0.01 && (
            <div className="cobro-rapido">
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
                onClick={() => cobrarRapido("PAGO_MOVIL")}
              >
                Pago móvil · Bs {restante.toFixed(2)}
              </button>
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
                        {p.codigo_barra} · stock {p.stock_actual}
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
    </div>
  );
}