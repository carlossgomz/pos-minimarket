import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getDb } from "./db";
import { ConfigRow, Usuario, Vendedor } from "./types";
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
import PendientesCodigoBarras from "./screens/PendientesCodigoBarras";

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

export default function App() {
  const [tab, setTab] = useState<Tab>("venta");
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

  async function cargarConfig() {
    try {
      const db = await getDb();
      const rows = await db.select<ConfigRow[]>(
        "SELECT tasa_cambio_dia, nombre_negocio, rif_negocio, prefijo_caja, proximo_numero_ticket, vendedor_actual_id, gemini_api_key FROM config WHERE id = 1"
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

  // Aviso de productos con stock bajo, crítico o agotado — solo para
  // admins (el cajero no tiene acceso a Inventario para hacer algo con
  // esto). Mismo criterio que estadoStock() en precios.ts, en SQL: 1
  // unidad o menos es "crítico", o por debajo del mínimo configurado.
  const [productosStockBajo, setProductosStockBajo] = useState(0);
  const [abrirInventarioFiltrado, setAbrirInventarioFiltrado] = useState(false);

  async function cargarProductosStockBajo() {
    try {
      const db = await getDb();
      const rows = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM productos WHERE activo = 1 AND (stock_actual <= 1 OR stock_actual <= stock_minimo)"
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

  useEffect(() => {
    if (!configSyncLista) return;
    check()
      .then((update) => setActualizacion(update))
      .catch(() => {
        // sin internet o el endpoint no respondió — no es un error para
        // mostrarle al usuario, simplemente no hay forma de saber si hay
        // una versión nueva en este momento
      });
  }, [configSyncLista]);

  async function instalarActualizacion() {
    if (!actualizacion) return;
    setInstalando(true);
    setErrorActualizacion(null);
    try {
      await actualizacion.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setErrorActualizacion(`No se pudo instalar la actualización: ${String(e)}`);
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
    return <Login config={config} onLogin={setUsuarioActual} />;
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

  return (
    <div className="page">
      <header className="header">
        <h1>{config.nombre_negocio}</h1>
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
          <span style={{ color: "#5f5e5a" }}>
            {usuarioActual.nombre} · {esAdmin ? "Admin" : "Cajero"}
          </span>
          {estadoConexion && (
            <span style={{ color: estadoConexion.en_linea ? "#2e7d32" : "#c62828", fontWeight: 600 }}>
              ● {estadoConexion.en_linea ? "En línea" : "Sin conexión"}
              {estadoConexion.pendientes > 0 ? ` (${estadoConexion.pendientes} pendiente${estadoConexion.pendientes === 1 ? "" : "s"})` : ""}
            </span>
          )}
          {pendientesCodigo > 0 && (
            <button
              type="button"
              className="link-btn"
              style={{ color: "#b9770e" }}
              onClick={() => setMostrarPendientesCodigo(true)}
            >
              🏷 {pendientesCodigo} sin código de barras
            </button>
          )}
          {esAdmin && productosStockBajo > 0 && (
            <button
              type="button"
              className="link-btn"
              style={{ color: "#a32d2d" }}
              onClick={() => {
                setAbrirInventarioFiltrado(true);
                setTab("inventario");
              }}
            >
              ⚠ {productosStockBajo} con stock bajo
            </button>
          )}
          {actualizacion && (
            <button type="button" className="link-btn" onClick={instalarActualizacion} disabled={instalando}>
              {instalando ? "Instalando…" : `⬆ Actualizar a ${actualizacion.version}`}
            </button>
          )}
          {errorActualizacion && (
            <span style={{ color: "#a32d2d", fontSize: 12 }}>{errorActualizacion}</span>
          )}
          <button
            className="link-btn"
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
      {tabEfectivo === "cuadre" && <CuadreCaja />}
      {tabEfectivo === "clientes" && <Clientes />}
      {esAdmin && tabEfectivo === "proveedores" && <Proveedores />}
      {esAdmin && tabEfectivo === "usuarios" && <Usuarios />}
      {esAdmin && tabEfectivo === "reportes" && <Reportes config={config} />}
      {esAdmin && tabEfectivo === "estadisticas" && <Estadisticas config={config} />}
      {tabEfectivo === "facturas" && <Facturas config={config} />}

      {mostrarPendientesCodigo && (
        <PendientesCodigoBarras
          onCerrar={() => setMostrarPendientesCodigo(false)}
          onCambio={cargarPendientesCodigo}
        />
      )}
    </div>
  );
}