import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { ConfigRow, MovimientoInventario, ProductoInventario } from "../types";
import { gananciaUnitariaUsd, precioVentaBsHoy, precioVentaUsd } from "../precios";
import { fechaHoraVenezuela } from "../fecha";

// Todo lo de acá es por producto individual — no hay ningún número que
// sume varios productos entre sí. Para ver el panorama general de precios
// y stock de todo el catálogo, esa es la pestaña Inventario.
export default function Movimientos({ config }: { config: ConfigRow }) {
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<ProductoInventario[]>([]);
  const [mostrarDropdown, setMostrarDropdown] = useState(false);
  const [productoSeleccionado, setProductoSeleccionado] = useState<ProductoInventario | null>(null);

  const [tipo, setTipo] = useState<"ENTRADA" | "SALIDA">("ENTRADA");
  const [cantidad, setCantidad] = useState("");
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const [movimientos, setMovimientos] = useState<MovimientoInventario[]>([]);
  const [totales, setTotales] = useState<{ entradas: number; salidas: number } | null>(null);

  // Búsqueda de producto en vivo, igual que en Venta.
  useEffect(() => {
    const term = busqueda.trim();
    if (term.length < 2) {
      setResultados([]);
      setMostrarDropdown(false);
      return;
    }
    const timer = setTimeout(async () => {
      const db = await getDb();
      const rows = await db.select<ProductoInventario[]>(
        `SELECT p.*, c.nombre as categoria_nombre
         FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
         WHERE p.nombre LIKE $1 OR p.codigo_barra LIKE $1
         ORDER BY p.nombre LIMIT 8`,
        [`%${term}%`]
      );
      setResultados(rows);
      setMostrarDropdown(rows.length > 0);
    }, 200);
    return () => clearTimeout(timer);
  }, [busqueda]);

  async function cargarMovimientos(productoId?: string) {
    const db = await getDb();
    const base = `SELECT m.id, m.producto_id, p.nombre as producto_nombre, m.tipo, m.cantidad, m.motivo, m.referencia, m.created_at
       FROM movimientos_inventario m JOIN productos p ON p.id = m.producto_id`;

    if (productoId) {
      const rows = await db.select<MovimientoInventario[]>(
        `${base} WHERE m.producto_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
        [productoId]
      );
      setMovimientos(rows);

      const totalesRows = await db.select<{ tipo: string; total: number }[]>(
        `SELECT tipo, SUM(cantidad) as total FROM movimientos_inventario WHERE producto_id = $1 GROUP BY tipo`,
        [productoId]
      );
      setTotales({
        entradas: totalesRows.find((r) => r.tipo === "ENTRADA")?.total ?? 0,
        salidas: totalesRows.find((r) => r.tipo === "SALIDA")?.total ?? 0,
      });
    } else {
      const rows = await db.select<MovimientoInventario[]>(`${base} ORDER BY m.created_at DESC LIMIT 50`);
      setMovimientos(rows);
      setTotales(null);
    }
  }

  useEffect(() => {
    cargarMovimientos(productoSeleccionado?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productoSeleccionado]);

  function seleccionarProducto(p: ProductoInventario) {
    setProductoSeleccionado(p);
    setBusqueda("");
    setResultados([]);
    setMostrarDropdown(false);
    setCantidad("");
    setMotivo("");
    setMensaje(null);
  }

  async function registrarMovimiento() {
    if (!productoSeleccionado) return;
    const cant = Number(cantidad);
    if (!cant || cant <= 0) {
      setMensaje("La cantidad debe ser mayor a 0.");
      return;
    }
    if (!motivo.trim()) {
      setMensaje("Indica un motivo para el movimiento.");
      return;
    }
    setGuardando(true);
    try {
      await invoke("ajustar_stock", {
        input: {
          producto_id: productoSeleccionado.id,
          tipo,
          cantidad: cant,
          motivo: motivo.trim(),
          fecha_hora: fechaHoraVenezuela(),
        },
      });
    } catch (e) {
      setMensaje(`No se pudo registrar el movimiento: ${String(e)}`);
      setGuardando(false);
      return;
    }

    // refrescar el stock del producto seleccionado (cambió) y su historial
    const db = await getDb();
    const rows = await db.select<ProductoInventario[]>(
      `SELECT p.*, c.nombre as categoria_nombre FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.id = $1`,
      [productoSeleccionado.id]
    );
    if (rows[0]) setProductoSeleccionado(rows[0]);
    await cargarMovimientos(productoSeleccionado.id);

    setCantidad("");
    setMotivo("");
    setMensaje(null);
    setGuardando(false);
  }

  const rentabilidadPct =
    productoSeleccionado && productoSeleccionado.costo_actual_usd > 0
      ? (gananciaUnitariaUsd(productoSeleccionado) / productoSeleccionado.costo_actual_usd) * 100
      : 0;

  return (
    <div>
      <section className="card" style={{ position: "relative" }}>
        <h2>Producto</h2>
        <div className="form-row" style={{ position: "relative" }}>
          <input
            placeholder="Buscar por nombre o código para ver su ficha y registrar un movimiento"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            onFocus={() => resultados.length > 0 && setMostrarDropdown(true)}
            onBlur={() => setTimeout(() => setMostrarDropdown(false), 150)}
          />
          {productoSeleccionado && (
            <button type="button" className="link-btn" onClick={() => setProductoSeleccionado(null)}>
              ver movimientos de todos los productos
            </button>
          )}
          {mostrarDropdown && (
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
              {resultados.map((p) => (
                <li
                  key={p.id}
                  onMouseDown={() => seleccionarProducto(p)}
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
                  <span style={{ color: "#5f5e5a" }}>{p.codigo_barra} · stock {p.stock_actual}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {productoSeleccionado && (
        <>
          <section className="card">
            <h2>{productoSeleccionado.nombre}</h2>
            <p className="hint">
              {productoSeleccionado.codigo_barra} · {productoSeleccionado.categoria_nombre ?? "sin categoría"}
            </p>
            <div className="stats-grid">
              <div className="card stat-card">
                <h2>Costo USD</h2>
                <p className="ticket-total">{productoSeleccionado.costo_actual_usd.toFixed(2)}</p>
              </div>
              <div className="card stat-card">
                <h2>Margen</h2>
                <p className="ticket-total">{(productoSeleccionado.margen_porcentaje ?? 0).toFixed(0)}%</p>
              </div>
              <div className="card stat-card">
                <h2>Venta USD</h2>
                <p className="ticket-total">{precioVentaUsd(productoSeleccionado).toFixed(2)}</p>
              </div>
              <div className="card stat-card">
                <h2>Venta Bs (hoy)</h2>
                <p className="ticket-total">{precioVentaBsHoy(productoSeleccionado, config.tasa_cambio_dia).toFixed(2)}</p>
              </div>
              <div className="card stat-card">
                <h2>Ganancia / unidad</h2>
                <p className="ticket-total">USD {gananciaUnitariaUsd(productoSeleccionado).toFixed(2)}</p>
              </div>
              <div className="card stat-card">
                <h2>Rentabilidad</h2>
                <p className="ticket-total">{rentabilidadPct.toFixed(1)}%</p>
              </div>
              <div className="card stat-card">
                <h2>Stock actual</h2>
                <p className="ticket-total">{productoSeleccionado.stock_actual}</p>
                <p className="hint">mínimo: {productoSeleccionado.stock_minimo}</p>
              </div>
              <div className="card stat-card">
                <h2>Valor en inventario</h2>
                <p className="ticket-total">
                  USD {(productoSeleccionado.costo_actual_usd * productoSeleccionado.stock_actual).toFixed(2)}
                </p>
              </div>
              <div className="card stat-card">
                <h2>Entradas totales</h2>
                <p className="ticket-total">{totales?.entradas ?? 0}</p>
              </div>
              <div className="card stat-card">
                <h2>Salidas totales</h2>
                <p className="ticket-total">{totales?.salidas ?? 0}</p>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Registrar entrada / salida</h2>
            <div className="form-row">
              <select value={tipo} onChange={(e) => setTipo(e.target.value as "ENTRADA" | "SALIDA")}>
                <option value="ENTRADA">Entrada</option>
                <option value="SALIDA">Salida</option>
              </select>
              <input
                placeholder="Cantidad"
                type="number"
                step="1"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
              />
              <input
                placeholder="Motivo (merma, donación, conteo físico...)"
                list="motivos-movimiento"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
              />
              <datalist id="motivos-movimiento">
                <option value="Merma" />
                <option value="Producto vencido" />
                <option value="Producto dañado" />
                <option value="Donación / obsequio" />
                <option value="Corrección de conteo físico" />
                <option value="Devolución de cliente" />
                <option value="Uso interno" />
              </datalist>
              <button type="button" onClick={registrarMovimiento} disabled={guardando}>
                {guardando ? "Guardando…" : "Registrar"}
              </button>
            </div>
            {mensaje && <p className="error">{mensaje}</p>}
          </section>
        </>
      )}

      <section className="card">
        <h2>{productoSeleccionado ? `Historial — ${productoSeleccionado.nombre}` : "Movimientos recientes (todos los productos)"}</h2>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Producto</th>
              <th>Tipo</th>
              <th>Cantidad</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {movimientos.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.created_at.replace(" ", "T")).toLocaleString("es-VE")}</td>
                <td>{m.producto_nombre}</td>
                <td>{m.tipo}</td>
                <td>
                  {m.tipo === "SALIDA" ? "-" : "+"}
                  {m.cantidad}
                </td>
                <td>{m.motivo ?? "—"}</td>
              </tr>
            ))}
            {movimientos.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Sin movimientos todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
