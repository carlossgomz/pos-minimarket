import { useEffect, useState } from "react";
import { getDb } from "../db";
import { ConfigRow } from "../types";
import { hoyVenezuela } from "../fecha";

function fechaISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hoyComoDate(): Date {
  return new Date(`${hoyVenezuela()}T12:00:00`);
}

function primerDiaMes(offsetMeses = 0) {
  const d = hoyComoDate();
  d.setMonth(d.getMonth() + offsetMeses, 1);
  return fechaISO(d);
}

const INICIO_HISTORICO = "2020-01-01";

type ProductoTop = { producto_id: string; nombre: string; cantidad: number; monto_bs: number };
type ProductoGanancia = { producto_id: string; nombre: string; ganancia_bs: number };
type ClienteFrecuente = { cliente_id: string; nombre: string; num_compras: number; total_gastado_bs: number };
type MetodoPago = { metodo: string; monto_bs: number };
type CategoriaTop = { categoria: string; monto_bs: number };
type HoraPico = { hora: string; num_ventas: number };

export default function Estadisticas({ config }: { config: ConfigRow }) {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyVenezuela());
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [productosPorCantidad, setProductosPorCantidad] = useState<ProductoTop[]>([]);
  const [productosPorGanancia, setProductosPorGanancia] = useState<ProductoGanancia[]>([]);
  const [clientesFrecuentes, setClientesFrecuentes] = useState<ClienteFrecuente[]>([]);
  const [metodosPago, setMetodosPago] = useState<MetodoPago[]>([]);
  const [categorias, setCategorias] = useState<CategoriaTop[]>([]);
  const [horasPico, setHorasPico] = useState<HoraPico[]>([]);
  const [clientesNuevos, setClientesNuevos] = useState(0);

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      const db = await getDb();

      setProductosPorCantidad(
        await db.select<ProductoTop[]>(
          `SELECT vi.producto_id, p.nombre, SUM(vi.cantidad) as cantidad, SUM(vi.subtotal_bs) as monto_bs
           FROM venta_items vi
           JOIN ventas v ON v.id = vi.venta_id
           JOIN productos p ON p.id = vi.producto_id
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2
           GROUP BY vi.producto_id
           ORDER BY cantidad DESC
           LIMIT 10`,
          [desde, hasta]
        )
      );

      setProductosPorGanancia(
        await db.select<ProductoGanancia[]>(
          `SELECT vi.producto_id, p.nombre,
                  SUM(vi.cantidad * (vi.precio_unit_bs - p.costo_actual_usd * v.tasa_cambio_dia)) as ganancia_bs
           FROM venta_items vi
           JOIN ventas v ON v.id = vi.venta_id
           JOIN productos p ON p.id = vi.producto_id
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2
           GROUP BY vi.producto_id
           ORDER BY ganancia_bs DESC
           LIMIT 10`,
          [desde, hasta]
        )
      );

      setClientesFrecuentes(
        await db.select<ClienteFrecuente[]>(
          `SELECT v.cliente_id, v.cliente_nombre as nombre, COUNT(*) as num_compras, SUM(v.total_bs) as total_gastado_bs
           FROM ventas v
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2 AND v.cliente_id IS NOT NULL
           GROUP BY v.cliente_id
           ORDER BY total_gastado_bs DESC
           LIMIT 10`,
          [desde, hasta]
        )
      );

      setMetodosPago(
        await db.select<MetodoPago[]>(
          `SELECT p.metodo, SUM(p.monto_bs) as monto_bs
           FROM pagos p
           JOIN ventas v ON v.id = p.venta_id
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2
           GROUP BY p.metodo
           ORDER BY monto_bs DESC`,
          [desde, hasta]
        )
      );

      setCategorias(
        await db.select<CategoriaTop[]>(
          `SELECT COALESCE(c.nombre, 'Sin categoría') as categoria, SUM(vi.subtotal_bs) as monto_bs
           FROM venta_items vi
           JOIN ventas v ON v.id = vi.venta_id
           JOIN productos p ON p.id = vi.producto_id
           LEFT JOIN categorias c ON c.id = p.categoria_id
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2
           GROUP BY categoria
           ORDER BY monto_bs DESC
           LIMIT 5`,
          [desde, hasta]
        )
      );

      setHorasPico(
        await db.select<HoraPico[]>(
          `SELECT strftime('%H', fecha_hora) as hora, COUNT(*) as num_ventas
           FROM ventas
           WHERE date(fecha_hora) BETWEEN $1 AND $2
           GROUP BY hora
           ORDER BY num_ventas DESC
           LIMIT 3`,
          [desde, hasta]
        )
      );

      const nuevos = await db.select<{ n: number }[]>(
        `SELECT COUNT(*) as n FROM clientes WHERE date(created_at) BETWEEN $1 AND $2`,
        [desde, hasta]
      );
      setClientesNuevos(nuevos[0]?.n ?? 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desde, hasta]);

  function aplicarAtajo(tipo: "hoy" | "mes" | "mesPasado" | "todo") {
    if (tipo === "hoy") {
      setDesde(hoyVenezuela());
      setHasta(hoyVenezuela());
    } else if (tipo === "mes") {
      setDesde(primerDiaMes());
      setHasta(hoyVenezuela());
    } else if (tipo === "mesPasado") {
      setDesde(primerDiaMes(-1));
      setHasta(primerDiaMes());
    } else {
      setDesde(INICIO_HISTORICO);
      setHasta(hoyVenezuela());
    }
  }

  const totalPagos = metodosPago.reduce((a, m) => a + m.monto_bs, 0);
  const maxCantidad = Math.max(1, ...productosPorCantidad.map((p) => p.cantidad));
  const maxGasto = Math.max(1, ...clientesFrecuentes.map((c) => c.total_gastado_bs));

  return (
    <div>
      <div className="card">
        <div className="form-row">
          <label style={{ alignSelf: "center" }}>Desde</label>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          <label style={{ alignSelf: "center" }}>Hasta</label>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          <button type="button" onClick={() => aplicarAtajo("hoy")}>Hoy</button>
          <button type="button" onClick={() => aplicarAtajo("mes")}>Este mes</button>
          <button type="button" onClick={() => aplicarAtajo("mesPasado")}>Mes pasado</button>
          <button type="button" onClick={() => aplicarAtajo("todo")}>Todo (histórico)</button>
        </div>
      </div>

      {error && <p className="error">Error: {error}</p>}
      {cargando && <p className="hint">Cargando…</p>}

      <div className="venta-layout">
        <div className="card">
          <h2>Productos más vendidos</h2>
          {productosPorCantidad.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cantidad</th>
                  <th>Total Bs</th>
                </tr>
              </thead>
              <tbody>
                {productosPorCantidad.map((p) => (
                  <tr key={p.producto_id}>
                    <td>
                      {p.nombre}
                      <div style={{ background: "#eee", height: 4, borderRadius: 2, marginTop: 3 }}>
                        <div
                          style={{
                            background: "#0f6e56",
                            height: 4,
                            borderRadius: 2,
                            width: `${(p.cantidad / maxCantidad) * 100}%`,
                          }}
                        />
                      </div>
                    </td>
                    <td>{p.cantidad}</td>
                    <td>{p.monto_bs.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Productos que más ganancia generan</h2>
          {productosPorGanancia.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Ganancia Bs</th>
                  <th>Ganancia USD</th>
                </tr>
              </thead>
              <tbody>
                {productosPorGanancia.map((p) => (
                  <tr key={p.producto_id}>
                    <td>{p.nombre}</td>
                    <td>{p.ganancia_bs.toFixed(2)}</td>
                    <td>{(p.ganancia_bs / config.tasa_cambio_dia).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="venta-layout">
        <div className="card">
          <h2>Clientes frecuentes</h2>
          {clientesFrecuentes.length === 0 ? (
            <p className="empty">Sin compras con cliente identificado en ese rango.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>N° compras</th>
                  <th>Total gastado Bs</th>
                </tr>
              </thead>
              <tbody>
                {clientesFrecuentes.map((c) => (
                  <tr key={c.cliente_id}>
                    <td>
                      {c.nombre ?? "—"}
                      <div style={{ background: "#eee", height: 4, borderRadius: 2, marginTop: 3 }}>
                        <div
                          style={{
                            background: "#0f6e56",
                            height: 4,
                            borderRadius: 2,
                            width: `${(c.total_gastado_bs / maxGasto) * 100}%`,
                          }}
                        />
                      </div>
                    </td>
                    <td>{c.num_compras}</td>
                    <td>{c.total_gastado_bs.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">Clientes nuevos registrados en el rango: {clientesNuevos}</p>
        </div>

        <div className="card">
          <h2>Métodos de pago</h2>
          {metodosPago.length === 0 ? (
            <p className="empty">Sin pagos en ese rango de fechas.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Método</th>
                  <th>Total Bs</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {metodosPago.map((m) => (
                  <tr key={m.metodo}>
                    <td>{m.metodo}</td>
                    <td>{m.monto_bs.toFixed(2)}</td>
                    <td>{totalPagos > 0 ? ((m.monto_bs / totalPagos) * 100).toFixed(1) : "0.0"}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="venta-layout">
        <div className="card">
          <h2>Categorías más vendidas</h2>
          {categorias.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th>Total Bs</th>
                </tr>
              </thead>
              <tbody>
                {categorias.map((c) => (
                  <tr key={c.categoria}>
                    <td>{c.categoria}</td>
                    <td>{c.monto_bs.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Horas de mayor venta</h2>
          {horasPico.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>N° ventas</th>
                </tr>
              </thead>
              <tbody>
                {horasPico.map((h) => (
                  <tr key={h.hora}>
                    <td>{h.hora}:00 - {h.hora}:59</td>
                    <td>{h.num_ventas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">Hora local de Venezuela.</p>
        </div>
      </div>
    </div>
  );
}
