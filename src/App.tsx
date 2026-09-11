import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { getDb } from "./db";
import { ConfigRow, Usuario, Vendedor, VentaItemStockPendiente } from "./types";
import ConfiguracionSync from "./screens/ConfiguracionSync";
import Venta from "./screens/Venta";
import Inventario from "./screens/Inventario";
import Movimientos from "./screens/Movimientos";
import Compras from "./screens/Compras";
import Cuentas from "./screens/Cuentas";
import CuadreCaja from "./screens/CuadreCaja";
import Clientes from "./screens/Clientes";
import Proveedores from "./screens/Proveedores";
import Reportes from "./screens/Reportes";
import Estadisticas from "./screens/Estadisticas";
import Facturas from "./screens/Facturas";
import Usuarios from "./screens/Usuarios";
import Login from "./screens/Login";
import Novedades from "./screens/Novedades";
import ActualizacionDisponible from "./screens/ActualizacionDisponible";
import Notificaciones, { NotificacionItem } from "./screens/Notificaciones";
import PendientesCodigoBarras from "./screens/PendientesCodigoBarras";
import StockPendiente from "./screens/StockPendiente";
import logo from "./assets/logo.png";

type Tab =
  | "venta"
  | "inventario"
  | "movimientos"
  | "compras"
  | "cuentas"
  | "cuadre"
  | "clientes"
  | "proveedores"
  | "reportes"
  | "estadisticas"
  | "facturas"
  | "usuarios";

// El cajero solo ve estas secciones — compras, proveedores, reportes y
// usuarios siguen siendo solo para admin. Se filtra acá, en el frontend,
// no hay bases de datos separadas: es el mismo archivo .db para los dos
// roles.
const SECCIONES_CAJERO = new Set<Tab>(["venta", "facturas", "clientes", "cuentas", "inventario", "cuadre"]);

// Tema claro/oscuro — se guarda en localStorage (por PC, no por usuario:
// no tiene sentido que cambie de tema al cerrar sesión). Por defecto queda
// en oscuro: la pantalla clara resultó demasiado brillante para uso
// prolongado en la tienda.
const TEMA_KEY = "pos-tema";
function temaGuardado(): "claro" | "oscuro" {
  const v = localStorage.getItem(TEMA_KEY);
  return v === "claro" ? "claro" : "oscuro";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("venta");
  const [tema, setTema] = useState<"claro" | "oscuro">(temaGuardado);
  useEffect(() => {
    document.documentElement.dataset.theme = tema;
    localStorage.setItem(TEMA_KEY, tema);
  }, [tema]);

  const [config, setConfig] = useState<ConfigRow | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // null = todavía no se sabe; false = falta configurar este dispositivo
  // (primera vez en esta PC); true = ya tiene sync-config.json y puede
  // hablar con la base compartida.
  const [configSyncLista, setConfigSyncLista] = useState<boolean | null>(null);

  // Sin persistir entre reinicios de la app a propósito — como un POS
  // físico, cada quien entra con su usuario al empezar su turno.
  const [usuarioActual, setUsuarioActual] = useState<Usuario | null>(null);

  const [vendedores, setVendedores] = useState<Vendedor[]>([]);
  const [mostrarNuevoVendedor, setMostrarNuevoVendedor] = useState(false);
  const [nombreNuevoVendedor, setNombreNuevoVendedor] = useState("");

  // Indicador de conexión: se consulta cada 10s. null mientras no se ha
  // podido preguntar todavía (recién arrancando).
  const [estadoConexion, setEstadoConexion] = useState<{ en_linea: boolean; pendientes: number } | null>(null);

  // Aviso de productos sin código de barras real (creados desde una
  // factura de compra) — visible en el encabezado desde CUALQUIER
  // sección, para cualquier rol, porque el cajero (quien está físicamente
  // en la tienda con el escáner) no tiene acceso a Inventario.
  const [pendientesCodigo, setPendientesCodigo] = useState(0);
  const [mostrarPendientesCodigo, setMostrarPendientesCodigo] = useState(false);

  // Actualización de la app (ver .github/workflows/release.yml): se
  // revisa una vez al arrancar — el momento natural para aplicarla es
  // cuando se reabre la app, no hace falta revisar en caliente todo el
  // rato mientras está abierta.
  const [actualizacion, setActualizacion] = useState<Update | null>(null);
  const [instalando, setInstalando] = useState(false);
  const [errorActualizacion, setErrorActualizacion] = useState<string | null>(null);

  // Versión que el usuario eligió saltar en la ventana de "actualización
  // disponible" — se guarda para no volver a interrumpirlo con la misma
  // versión, pero el botoncito del header sigue disponible por si cambia
  // de opinión más tarde.
  const ACTUALIZACION_SALTADA_KEY = "pos-actualizacion-saltada";
  const [actualizacionSaltada, setActualizacionSaltada] = useState<string | null>(() =>
    localStorage.getItem(ACTUALIZACION_SALTADA_KEY)
  );
  function saltarActualizacion() {
    if (!actualizacion) return;
    localStorage.setItem(ACTUALIZACION_SALTADA_KEY, actualizacion.version);
    setActualizacionSaltada(actualizacion.version);
  }

  // "Qué hay de nuevo": antes se guardaba un aviso en localStorage justo
  // antes de reiniciar para instalar, y solo se mostraba si ESE reinicio
  // en particular salía bien — si el admin instalaba el .exe a mano (sin
  // pasar por el botón de acá adentro), o si el proceso se cerraba de
  // una forma que no dejaba terminar ese paso, la ventanita simplemente
  // no aparecía nunca para esa versión. Ahora en cambio compara la
  // versión que está corriendo AHORA contra la última que ya se mostró
  // (guardada en localStorage) - no importa cómo se instaló la
  // actualización, si difieren busca las notas de esa versión en GitHub
  // y las muestra. Se revisa una vez al entrar y de nuevo cada 30
  // minutos (igual que el chequeo de actualizaciones de arriba), así una
  // instalación que quedó abierta mucho tiempo también se entera.
  const NOVEDADES_VISTAS_KEY = "pos-novedades-version-vista";
  const [novedades, setNovedades] = useState<{ version: string; body: string } | null>(null);
  useEffect(() => {
    if (!configSyncLista) return;
    let cancelado = false;
    async function revisarNovedades() {
      try {
        const versionActual = await getVersion();
        if (localStorage.getItem(NOVEDADES_VISTAS_KEY) === versionActual) return;
        const resp = await fetch(`https://api.github.com/repos/carlossgomz/pos-minimarket/releases/tags/v${versionActual}`);
        if (!resp.ok) return; // sin red, o el release de esta versión no está publicado (todavía) con ese tag
        const data = await resp.json();
        if (!cancelado) {
          setNovedades({ version: versionActual, body: data.body ?? "" });
        }
      } catch {
        // sin red - se reintenta solo en el próximo ciclo de 30 minutos
      }
    }
    revisarNovedades();
    const id = setInterval(revisarNovedades, 30 * 60 * 1000);
    return () => {
      cancelado = true;
      clearInterval(id);
    };
  }, [configSyncLista]);
  function cerrarNovedades() {
    if (novedades) localStorage.setItem(NOVEDADES_VISTAS_KEY, novedades.version);
    setNovedades(null);
  }

  async function cargarConfig() {
    try {
      const db = await getDb();
      const rows = await db.select<ConfigRow[]>(
        "SELECT tasa_cambio_dia, nombre_negocio, rif_negocio, prefijo_caja, proximo_numero_ticket, vendedor_actual_id, gemini_api_key, delivery_api_url FROM config WHERE id = 1"
      );
      setConfig(rows[0] ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }

  async function cargarVendedores() {
    const db = await getDb();
    const rows = await db.select<Vendedor[]>(
      "SELECT id, nombre, activo FROM vendedores WHERE activo = 1 ORDER BY nombre"
    );
    setVendedores(rows);
  }

  useEffect(() => {
    invoke<boolean>("tiene_config_sync").then((lista) => {
      setConfigSyncLista(lista);
      if (lista) {
        cargarConfig();
        cargarVendedores();
      } else {
        setCargando(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function alTerminarConfigSync() {
    setConfigSyncLista(true);
    setCargando(true);
    await cargarConfig();
    await cargarVendedores();
  }

  useEffect(() => {
    if (!configSyncLista) return;
    let cancelado = false;
    async function consultar() {
      try {
        const r = await invoke<{ en_linea: boolean; pendientes: number }>("estado_conexion");
        if (!cancelado) setEstadoConexion(r);
      } catch {
        // el comando en sí falló (no la conexión a Turso) — se reintenta
        // en el próximo ciclo, no vale la pena mostrar un error acá.
      }
    }
    consultar();
    const id = setInterval(consultar, 10_000);
    return () => {
      cancelado = true;
      clearInterval(id);
    };
  }, [configSyncLista]);

  async function cargarPendientesCodigo() {
    try {
      const db = await getDb();
      const rows = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM productos WHERE codigo_barra LIKE 'SINCOD-%'"
      );
      setPendientesCodigo(rows[0]?.n ?? 0);
    } catch {
      // si falla (ej. sin conexión y todavía sin caché), se reintenta solo
    }
  }

  useEffect(() => {
    if (!configSyncLista) return;
    cargarPendientesCodigo();
    const id = setInterval(cargarPendientesCodigo, 20_000);
    return () => clearInterval(id);
  }, [configSyncLista]);

  // Aviso de productos en 1 unidad o agotados — solo para admins (el
  // cajero no tiene acceso a Inventario para hacer algo con esto). A
  // pedido explícito, ya no cuenta el "stock bajo" por mínimo configurable
  // (generaba demasiado ruido) — solo los casos duros: 0 o 1 unidad.
  const [productosStockBajo, setProductosStockBajo] = useState(0);
  const [abrirInventarioFiltrado, setAbrirInventarioFiltrado] = useState(false);

  async function cargarProductosStockBajo() {
    try {
      const db = await getDb();
      const rows = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM productos WHERE activo = 1 AND stock_actual <= 1"
      );
      setProductosStockBajo(rows[0]?.n ?? 0);
    } catch {
      // si falla, se reintenta solo en el próximo ciclo
    }
  }

  useEffect(() => {
    if (!configSyncLista || usuarioActual?.rol !== "ADMIN") return;
    cargarProductosStockBajo();
    const id = setInterval(cargarProductosStockBajo, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSyncLista, usuarioActual]);

  // Ventas cobradas con más cantidad de un producto de la que había en
  // stock (ver comandos::listar_ventas_stock_pendiente) — a diferencia del
  // aviso de "stock bajo" de arriba, este SÍ es visible para el cajero
  // (filtrado a sus propias ventas más abajo, junto a esAdmin): tiene que
  // enterarse de que quedó algo pendiente de explicar, aunque no pueda
  // cerrarlo él mismo.
  const [stockPendiente, setStockPendiente] = useState<VentaItemStockPendiente[]>([]);
  const [mostrarStockPendiente, setMostrarStockPendiente] = useState(false);

  async function cargarStockPendiente() {
    try {
      setStockPendiente(await invoke<VentaItemStockPendiente[]>("listar_ventas_stock_pendiente"));
    } catch {
      // si falla, se reintenta solo en el próximo ciclo
    }
  }

  useEffect(() => {
    if (!configSyncLista || !usuarioActual) return;
    cargarStockPendiente();
    const id = setInterval(cargarStockPendiente, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSyncLista, usuarioActual]);

  // Pedidos de delivery recién llegados sin revisar (ver delivery.rs, tarea
  // de fondo cada ~30s) — visible para CUALQUIER rol logueado (admin y
  // cajero): quien esté físicamente en la tienda tiene que enterarse,
  // aunque solo el admin pueda entrar al panel de la delivery-app a
  // resolverlo desde ahí.
  const [pedidosDeliveryPendientes, setPedidosDeliveryPendientes] = useState(0);

  // Alarma de tres tonos agudos con Web Audio (sin archivo de audio que
  // empaquetar) — más urgente que un simple beep para que se note en el
  // ruido de la tienda.
  function reproducirAlarmaPedido() {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const ahora = ctx.currentTime;
      [0, 0.22, 0.44].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = 1046.5; // C6 — agudo, corta bien el ruido de fondo
        gain.gain.setValueAtTime(0.0001, ahora + offset);
        gain.gain.exponentialRampToValueAtTime(0.4, ahora + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, ahora + offset + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ahora + offset);
        osc.stop(ahora + offset + 0.2);
      });
    } catch {
      // si el navegador bloquea audio (ej. sin interacción previa), no pasa nada
    }
  }

  async function cargarPedidosDeliveryPendientes() {
    try {
      setPedidosDeliveryPendientes(await invoke<number>("obtener_pedidos_delivery_pendientes"));
    } catch {
      // si falla, se reintenta solo en el próximo ciclo
    }
  }

  useEffect(() => {
    if (!configSyncLista || !usuarioActual) return;
    cargarPedidosDeliveryPendientes();
    // Cada 5s, igual que la tarea de fondo en Rust que llena este dato —
    // el aviso de pedido pendiente tiene que sentirse casi inmediato.
    const id = setInterval(cargarPedidosDeliveryPendientes, 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSyncLista, usuarioActual]);

  // Repite la alarma cada ~4s MIENTRAS haya al menos un pedido pendiente
  // (no una sola vez) — se calla sola en cuanto el conteo vuelve a 0, que
  // es exactamente cuando el pedido pasó de PENDIENTE_VERIFICACION a
  // ESPERANDO_PAGO (o se descartó) del lado de la delivery-app. Depende
  // del booleano ">0", no del número exacto, para no reiniciar el
  // intervalo (y el beep inmediato) cada vez que cambia la cantidad
  // mientras sigue sonando.
  const hayPedidosPendientes = pedidosDeliveryPendientes > 0;
  useEffect(() => {
    if (!hayPedidosPendientes) return;
    reproducirAlarmaPedido();
    const id = setInterval(reproducirAlarmaPedido, 4_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hayPedidosPendientes]);

  useEffect(() => {
    if (!configSyncLista) return;
    // Antes se revisaba una sola vez al arrancar — si publicabas una
    // versión nueva con la caja ya abierta, no se enteraba hasta cerrar y
    // volver a abrir. Ahora revisa de nuevo cada rato mientras sigue
    // abierta, así el aviso de actualización aparece solo.
    function verificarActualizacion() {
      check()
        .then((update) => setActualizacion(update))
        .catch(() => {
          // sin internet o el endpoint no respondió — no es un error para
          // mostrarle al usuario, simplemente no hay forma de saber si hay
          // una versión nueva en este momento
        });
    }
    verificarActualizacion();
    const id = setInterval(verificarActualizacion, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [configSyncLista]);

  // El instalador baja el archivo entero (~290MB) de una sola pasada, sin
  // reanudar - un corte breve de la conexión en cualquier punto de esos
  // varios minutos alcanza para que falle con un error de "no se pudo
  // decodificar la respuesta". La mayoría de esos cortes son momentáneos,
  // así que antes de rendirse y pedirle al usuario que reintente a mano,
  // se reintenta solo unas pocas veces con una pausa corta entre cada una.
  const MAX_INTENTOS_INSTALAR = 3;
  async function instalarActualizacion(intento = 1) {
    if (!actualizacion) return;
    setInstalando(true);
    setErrorActualizacion(null);
    try {
      await actualizacion.downloadAndInstall();
      await relaunch();
    } catch (e) {
      if (intento < MAX_INTENTOS_INSTALAR) {
        setTimeout(() => instalarActualizacion(intento + 1), 5_000);
        return;
      }
      setErrorActualizacion(`No se pudo instalar la actualización después de ${MAX_INTENTOS_INSTALAR} intentos: ${String(e)}`);
      setInstalando(false);
    }
  }

  async function actualizarTasa(nuevaTasa: number) {
    const db = await getDb();
    await db.execute("UPDATE config SET tasa_cambio_dia = $1 WHERE id = 1", [nuevaTasa]);
    await cargarConfig();
  }

  async function seleccionarVendedor(id: string) {
    const db = await getDb();
    await db.execute("UPDATE config SET vendedor_actual_id = $1 WHERE id = 1", [id || null]);
    await cargarConfig();
  }

  async function crearVendedor() {
    if (!nombreNuevoVendedor.trim()) return;
    const db = await getDb();
    const id = crypto.randomUUID();
    await db.execute("INSERT INTO vendedores (id, nombre) VALUES ($1,$2)", [id, nombreNuevoVendedor.trim()]);
    setNombreNuevoVendedor("");
    setMostrarNuevoVendedor(false);
    await cargarVendedores();
    await seleccionarVendedor(id);
  }

  if (configSyncLista === null) {
    return <div className="page">Cargando…</div>;
  }

  if (!configSyncLista) {
    return <ConfiguracionSync onListo={alTerminarConfigSync} />;
  }

  if (cargando) {
    return <div className="page">Conectando con la base de datos…</div>;
  }

  if (error || !config) {
    return <div className="page error">Error al cargar la configuración: {error}</div>;
  }

  if (!usuarioActual) {
    return (
      <>
        <Login config={config} onLogin={setUsuarioActual} />
        {novedades && <Novedades novedades={novedades} onCerrar={cerrarNovedades} />}
        {actualizacion && actualizacion.version !== actualizacionSaltada && (
          <ActualizacionDisponible
            version={actualizacion.version}
            notas={actualizacion.body ?? ""}
            instalando={instalando}
            error={errorActualizacion}
            onActualizar={instalarActualizacion}
            onSaltar={saltarActualizacion}
          />
        )}
        <div className="marca-dev">hecho por Carloscode_</div>
      </>
    );
  }

  const vendedorActual = vendedores.find((v) => v.id === config.vendedor_actual_id) ?? null;
  const esAdmin = usuarioActual.rol === "ADMIN";

  const TODAS_LAS_PESTANAS: { key: Tab; label: string }[] = [
    { key: "venta", label: "Venta" },
    { key: "cuentas", label: "Cuentas" },
    { key: "facturas", label: "Facturas" },
    { key: "movimientos", label: "Movimientos" },
    { key: "inventario", label: "Inventario" },
    { key: "cuadre", label: "Cuadre de caja" },
    { key: "compras", label: "Compras" },
    { key: "clientes", label: "Clientes" },
    { key: "proveedores", label: "Proveedores" },
    { key: "reportes", label: "Reportes" },
    { key: "estadisticas", label: "Estadísticas" },
    { key: "usuarios", label: "Usuarios" },
  ];
  const pestanasVisibles = esAdmin
    ? TODAS_LAS_PESTANAS
    : TODAS_LAS_PESTANAS.filter((p) => SECCIONES_CAJERO.has(p.key));
  // Si el usuario anterior (antes de cerrar sesión) se quedó en una
  // pestaña que este rol no puede ver — p. ej. un cajero entra justo
  // después de que un admin estuvo en "Usuarios" — cae a "venta" en vez de
  // dejar la pantalla en blanco sin ninguna pestaña resaltada.
  const tabEfectivo = pestanasVisibles.some((p) => p.key === tab) ? tab : "venta";

  // Alertas de "housekeeping" agrupadas en la campana de notificaciones —
  // ver Notificaciones.tsx. Los pedidos de delivery pendientes se quedan
  // como botón aparte, son una alerta operativa distinta.
  // El cajero solo ve SUS PROPIAS ventas marcadas (para poder explicar qué
  // pasó); el admin las ve todas (para corregir el inventario y cerrarlas).
  const stockPendienteVisible = esAdmin
    ? stockPendiente
    : stockPendiente.filter((it) => it.vendedor_nombre === usuarioActual.nombre);

  const notificaciones: NotificacionItem[] = [];
  if (pendientesCodigo > 0) {
    notificaciones.push({
      key: "sin-codigo",
      texto: `🏷 ${pendientesCodigo} sin código de barras`,
      color: "var(--warn-text)",
      onClick: () => setMostrarPendientesCodigo(true),
    });
  }
  if (esAdmin && productosStockBajo > 0) {
    notificaciones.push({
      key: "stock-bajo",
      texto: `⚠ ${productosStockBajo} en 1 unidad o agotados`,
      color: "var(--danger-text)",
      onClick: () => {
        setAbrirInventarioFiltrado(true);
        setTab("inventario");
      },
    });
  }
  if (stockPendienteVisible.length > 0) {
    notificaciones.push({
      key: "stock-pendiente",
      texto: `📦 ${stockPendienteVisible.length} venta${stockPendienteVisible.length === 1 ? "" : "s"} con stock por revisar`,
      color: "var(--danger-text)",
      onClick: () => setMostrarStockPendiente(true),
    });
  }
  if (actualizacion) {
    notificaciones.push({
      key: "actualizacion",
      texto: instalando ? "Instalando…" : `⬆ Actualización disponible: v${actualizacion.version}`,
      disabled: instalando,
      error: errorActualizacion,
      onClick: instalarActualizacion,
    });
  }

  return (
    <div className="page">
      <header className="header">
        <img src={logo} alt={config.nombre_negocio} className="logo-header" />
        <div className="tasa">
          <label>Vendedor</label>
          {!mostrarNuevoVendedor ? (
            <>
              <select
                value={config.vendedor_actual_id ?? ""}
                onChange={(e) =>
                  e.target.value === "__nuevo__" ? setMostrarNuevoVendedor(true) : seleccionarVendedor(e.target.value)
                }
              >
                <option value="">Sin seleccionar</option>
                {vendedores.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.nombre}
                  </option>
                ))}
                <option value="__nuevo__">+ Nuevo vendedor…</option>
              </select>
            </>
          ) : (
            <>
              <input
                placeholder="Nombre del vendedor"
                value={nombreNuevoVendedor}
                onChange={(e) => setNombreNuevoVendedor(e.target.value)}
                style={{ width: 160 }}
                autoFocus
              />
              <button onClick={crearVendedor}>Guardar</button>
              <button className="link-btn" onClick={() => setMostrarNuevoVendedor(false)}>
                cancelar
              </button>
            </>
          )}
          <label>Tasa del día (Bs/$)</label>
          <input
            type="number"
            step="0.01"
            defaultValue={config.tasa_cambio_dia}
            onBlur={(e) => actualizarTasa(Number(e.target.value))}
          />
          <span style={{ color: "var(--text-secondary)" }}>
            {usuarioActual.nombre} · {esAdmin ? "Admin" : "Cajero"}
          </span>
          {estadoConexion && (
            <span style={{ color: estadoConexion.en_linea ? "#2e7d32" : "#c62828", fontWeight: 600 }}>
              ● {estadoConexion.en_linea ? "En línea" : "Sin conexión"}
              {estadoConexion.pendientes > 0 ? ` (${estadoConexion.pendientes} pendiente${estadoConexion.pendientes === 1 ? "" : "s"})` : ""}
            </span>
          )}
          {pedidosDeliveryPendientes > 0 && (
            <button
              type="button"
              className="link-btn"
              style={{ color: "#1a6b8f", fontWeight: 700 }}
              onClick={() => {
                if (esAdmin && config?.delivery_api_url) open(`${config.delivery_api_url}/admin/pedidos`);
              }}
              title={
                esAdmin
                  ? "Abrir los pedidos en la app de delivery"
                  : "Avisa a un admin para que lo revise en la app de delivery"
              }
            >
              📦 {pedidosDeliveryPendientes} pedido{pedidosDeliveryPendientes === 1 ? "" : "s"} de
              delivery pendiente{pedidosDeliveryPendientes === 1 ? "" : "s"}
            </button>
          )}
          <button
            type="button"
            className="tema-btn"
            onClick={() => setTema((t) => (t === "oscuro" ? "claro" : "oscuro"))}
            title="Cambiar entre tema claro y oscuro"
          >
            {tema === "oscuro" ? "☀ Claro" : "🌙 Oscuro"}
          </button>
        </div>
        <div className="header-acciones">
          <Notificaciones items={notificaciones} />
          <button
            className="link-btn boton-cerrar-sesion"
            onClick={() => {
              setUsuarioActual(null);
              setTab("venta");
            }}
          >
            cerrar sesión
          </button>
        </div>
      </header>

      <nav className="tabs">
        {pestanasVisibles.map((p) => (
          <button
            key={p.key}
            className={tabEfectivo === p.key ? "tab-activo" : ""}
            onClick={() => {
              if (p.key !== "inventario") setAbrirInventarioFiltrado(false);
              setTab(p.key);
            }}
          >
            {p.label}
          </button>
        ))}
      </nav>

      {/* Venta se mantiene siempre montado (solo se oculta con CSS) para
          que los tickets abiertos y el consumo interno del día no se
          pierdan al pasar a otra pestaña — si se desmontara como el resto,
          React tira todo su estado en memoria cada vez que se cambia de
          sección. */}
      <div style={{ display: tabEfectivo === "venta" ? "block" : "none" }}>
        <Venta config={config} vendedor={vendedorActual} onTasaVista={cargarConfig} visible={tabEfectivo === "venta"} />
      </div>
      {tabEfectivo === "inventario" && (
        <Inventario config={config} soloProblemasInicial={abrirInventarioFiltrado} />
      )}
      {esAdmin && tabEfectivo === "movimientos" && <Movimientos config={config} />}
      {esAdmin && tabEfectivo === "compras" && <Compras config={config} onConfigActualizado={cargarConfig} />}
      {tabEfectivo === "cuentas" && <Cuentas config={config} esAdmin={esAdmin} />}
      {tabEfectivo === "cuadre" && <CuadreCaja config={config} />}
      {tabEfectivo === "clientes" && <Clientes />}
      {esAdmin && tabEfectivo === "proveedores" && <Proveedores />}
      {esAdmin && tabEfectivo === "usuarios" && <Usuarios usuarioActual={usuarioActual} />}
      {esAdmin && tabEfectivo === "reportes" && <Reportes config={config} />}
      {esAdmin && tabEfectivo === "estadisticas" && <Estadisticas config={config} />}
      {tabEfectivo === "facturas" && <Facturas config={config} esAdmin={esAdmin} />}

      {mostrarPendientesCodigo && (
        <PendientesCodigoBarras
          onCerrar={() => setMostrarPendientesCodigo(false)}
          onCambio={cargarPendientesCodigo}
        />
      )}
      {mostrarStockPendiente && (
        <StockPendiente
          items={stockPendienteVisible}
          esAdmin={esAdmin}
          onCerrar={() => setMostrarStockPendiente(false)}
          onGuardarNota={async (id, nota) => {
            await invoke("guardar_nota_cajero_stock", { ventaItemId: id, nota });
            await cargarStockPendiente();
          }}
          onResolver={async (id) => {
            await invoke("resolver_stock_pendiente", {
              ventaItemId: id,
              adminUsuario: usuarioActual.nombre,
              fechaHora: new Date().toISOString(),
            });
            await cargarStockPendiente();
          }}
        />
      )}
      {actualizacion && actualizacion.version !== actualizacionSaltada && (
        <ActualizacionDisponible
          version={actualizacion.version}
          notas={actualizacion.body ?? ""}
          instalando={instalando}
          error={errorActualizacion}
          onActualizar={instalarActualizacion}
          onSaltar={saltarActualizacion}
        />
      )}
      <div className="marca-dev">hecho por Carloscode_</div>
    </div>
  );
}