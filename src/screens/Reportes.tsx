import { useEffect, useMemo, useState } from "react";
import { getDb } from "../db";
import { ConfigRow } from "../types";
import { fechaHoraVenezuela } from "../fecha";

type FilaReporte = {
  fecha: string; // YYYY-MM-DD
  total_bs: number;
  num_ventas: number;
  ganancia_bs: number;
};

function fechaISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hoy() {
  return fechaHoraVenezuela().slice(0, 10);
}

// Ancla en el mediodía de "hoy" (hora Venezuela) para que sumar/restar meses
// o días con los setters locales del Date no cruce un límite de día por el
// desfase entre la zona horaria del sistema operativo y America/Caracas.
function hoyComoDate(): Date {
  return new Date(`${hoy()}T12:00:00`);
}

function primerDiaMes(offsetMeses = 0) {
  const d = hoyComoDate();
  d.setMonth(d.getMonth() + offsetMeses, 1);
  return fechaISO(d);
}

function ultimoDiaMes(offsetMeses = 0) {
  const d = hoyComoDate();
  d.setMonth(d.getMonth() + offsetMeses + 1, 0);
  return fechaISO(d);
}

function inicioSemana() {
  const d = hoyComoDate();
  const dia = d.getDay(); // 0=domingo
  d.setDate(d.getDate() - dia);
  return fechaISO(d);
}

// Antes de esta fecha no hay ventas en el sistema (o si las hay, no
// importa perderlas del rango "Todo") — sirve como límite inferior fijo
// para armar un reporte histórico completo sin tener que calcularlo.
const INICIO_HISTORICO = "2020-01-01";

export default function Reportes({ config }: { config: ConfigRow }) {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoy());
  const [filas, setFilas] = useState<FilaReporte[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      const db = await getDb();

      const ventasPorDia = await db.select<{ fecha: string; total_bs: number; num_ventas: number }[]>(
        `SELECT date(fecha_hora) as fecha, SUM(total_bs) as total_bs, COUNT(*) as num_ventas
         FROM ventas
         WHERE date(fecha_hora) BETWEEN $1 AND $2
         GROUP BY date(fecha_hora)
         ORDER BY fecha`,
        [desde, hasta]
      );

      const gananciaPorDia = await db.select<{ fecha: string; ganancia_bs: number }[]>(
        `SELECT date(v.fecha_hora) as fecha,
                SUM(vi.cantidad * (vi.precio_unit_bs - p.costo_actual_usd * v.tasa_cambio_dia)) as ganancia_bs
         FROM venta_items vi
         JOIN ventas v ON v.id = vi.venta_id
         JOIN productos p ON p.id = vi.producto_id
         WHERE date(v.fecha_hora) BETWEEN $1 AND $2
         GROUP BY date(v.fecha_hora)`,
        [desde, hasta]
      );

      const gananciaPorFecha: Record<string, number> = {};
      for (const g of gananciaPorDia) gananciaPorFecha[g.fecha] = g.ganancia_bs;

      const combinado: FilaReporte[] = ventasPorDia.map((v) => ({
        fecha: v.fecha,
        total_bs: v.total_bs,
        num_ventas: v.num_ventas,
        ganancia_bs: gananciaPorFecha[v.fecha] ?? 0,
      }));

      setFilas(combinado);
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

  const resumen = useMemo(() => {
    const totalVentas = filas.reduce((a, f) => a + f.total_bs, 0);
    const totalGanancia = filas.reduce((a, f) => a + f.ganancia_bs, 0);
    const numVentas = filas.reduce((a, f) => a + f.num_ventas, 0);
    const ticketPromedio = numVentas > 0 ? totalVentas / numVentas : 0;
    return { totalVentas, totalGanancia, numVentas, ticketPromedio };
  }, [filas]);

  const maxValor = Math.max(1, ...filas.map((f) => Math.max(f.total_bs, f.ganancia_bs)));

  function aplicarAtajo(tipo: "hoy" | "semana" | "mes" | "mesPasado" | "todo") {
    if (tipo === "hoy") {
      setDesde(hoy());
      setHasta(hoy());
    } else if (tipo === "semana") {
      setDesde(inicioSemana());
      setHasta(hoy());
    } else if (tipo === "mes") {
      setDesde(primerDiaMes());
      setHasta(hoy());
    } else if (tipo === "mesPasado") {
      setDesde(primerDiaMes(-1));
      setHasta(ultimoDiaMes(-1));
    } else {
      setDesde(INICIO_HISTORICO);
      setHasta(hoy());
    }
  }

  return (
    <div>
      <div className="card">
        <div className="form-row">
          <label style={{ alignSelf: "center" }}>Desde</label>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          <label style={{ alignSelf: "center" }}>Hasta</label>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          <button type="button" onClick={() => aplicarAtajo("hoy")}>Hoy</button>
          <button type="button" onClick={() => aplicarAtajo("semana")}>Esta semana</button>
          <button type="button" onClick={() => aplicarAtajo("mes")}>Este mes</button>
          <button type="button" onClick={() => aplicarAtajo("mesPasado")}>Mes pasado</button>
          <button type="button" onClick={() => aplicarAtajo("todo")}>Todo (histórico)</button>
          <button type="button" style={{ marginLeft: "auto" }} onClick={() => window.print()}>
            Imprimir reporte
          </button>
        </div>
      </div>

      {error && <p className="error">Error: {error}</p>}

      <div className="venta-layout">
        <div className="card">
          <h2>Total vendido</h2>
          <p className="ticket-total">
            Bs {resumen.totalVentas.toFixed(2)}{" "}
            <span className="hint" style={{ margin: 0 }}>
              (USD {(resumen.totalVentas / config.tasa_cambio_dia).toFixed(2)})
            </span>
          </p>
        </div>
        <div className="card">
          <h2>Ganancia estimada</h2>
          <p className="ticket-total">
            Bs {resumen.totalGanancia.toFixed(2)}{" "}
            <span className="hint" style={{ margin: 0 }}>
              (USD {(resumen.totalGanancia / config.tasa_cambio_dia).toFixed(2)})
            </span>
          </p>
          <p className="hint">Basada en el costo actual del producto, no en el costo histórico.</p>
        </div>
        <div className="card">
          <h2>N° de ventas</h2>
          <p className="ticket-total">{resumen.numVentas}</p>
        </div>
        <div className="card">
          <h2>Ticket promedio</h2>
          <p className="ticket-total">
            Bs {resumen.ticketPromedio.toFixed(2)}{" "}
            <span className="hint" style={{ margin: 0 }}>
              (USD {(resumen.ticketPromedio / config.tasa_cambio_dia).toFixed(2)})
            </span>
          </p>
        </div>
      </div>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        Conversión a USD con la tasa del día de hoy ({config.tasa_cambio_dia.toFixed(2)} Bs/$) — no la tasa de
        cada venta individual.
      </p>

      <div className="card">
        <h2>Ventas y ganancia por día</h2>
        {cargando ? (
          <p className="hint">Cargando…</p>
        ) : filas.length === 0 ? (
          <p className="empty">Sin ventas en ese rango de fechas.</p>
        ) : (
          <svg
            viewBox={`0 0 ${Math.max(400, filas.length * 70)} 260`}
            width="100%"
            height="260"
            style={{ overflow: "visible" }}
          >
            {filas.map((f, i) => {
              const grupoAncho = 60;
              const barraAncho = 22;
              const x = i * 70 + 10;
              const altoMax = 200;
              const alturaVenta = (f.total_bs / maxValor) * altoMax;
              const alturaGanancia = (Math.max(f.ganancia_bs, 0) / maxValor) * altoMax;
              return (
                <g key={f.fecha}>
                  <rect
                    x={x}
                    y={220 - alturaVenta}
                    width={barraAncho}
                    height={alturaVenta}
                    fill="#0f6e56"
                    rx={3}
                  />
                  <rect
                    x={x + barraAncho + 4}
                    y={220 - alturaGanancia}
                    width={barraAncho}
                    height={alturaGanancia}
                    fill="#b9770e"
                    rx={3}
                  />
                  <text x={x + grupoAncho / 2 - 6} y={238} fontSize="10" textAnchor="middle" fill="#5f5e5a">
                    {f.fecha.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        <div className="form-row" style={{ marginTop: 8 }}>
          <span style={{ fontSize: 13 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, background: "#0f6e56", marginRight: 6, borderRadius: 2 }} />
            Ventas Bs
          </span>
          <span style={{ fontSize: 13 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, background: "#b9770e", marginRight: 6, borderRadius: 2 }} />
            Ganancia Bs
          </span>
        </div>
      </div>

      <div className="card">
        <h2>Detalle por día</h2>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>N° ventas</th>
              <th>Total Bs</th>
              <th>Total USD</th>
              <th>Ganancia Bs</th>
              <th>Ganancia USD</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.fecha}>
                <td>{new Date(f.fecha + "T00:00:00").toLocaleDateString("es-VE")}</td>
                <td>{f.num_ventas}</td>
                <td>{f.total_bs.toFixed(2)}</td>
                <td>{(f.total_bs / config.tasa_cambio_dia).toFixed(2)}</td>
                <td>{f.ganancia_bs.toFixed(2)}</td>
                <td>{(f.ganancia_bs / config.tasa_cambio_dia).toFixed(2)}</td>
              </tr>
            ))}
            {filas.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  Sin ventas en ese rango de fechas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Solo aparece al imprimir (ver .imprimible en styles.css). */}
      <div className="imprimible">
        <h2>{config.nombre_negocio} — Reporte de ventas</h2>
        <p>
          Del {new Date(desde + "T00:00:00").toLocaleDateString("es-VE")} al{" "}
          {new Date(hasta + "T00:00:00").toLocaleDateString("es-VE")} — impreso el{" "}
          {new Date().toLocaleString("es-VE")}
        </p>
        <p>
          <strong>Total vendido:</strong> Bs {resumen.totalVentas.toFixed(2)} (USD{" "}
          {(resumen.totalVentas / config.tasa_cambio_dia).toFixed(2)}) &nbsp;·&nbsp;
          <strong>Ganancia estimada:</strong> Bs {resumen.totalGanancia.toFixed(2)} (USD{" "}
          {(resumen.totalGanancia / config.tasa_cambio_dia).toFixed(2)}) &nbsp;·&nbsp;
          <strong>N° de ventas:</strong> {resumen.numVentas} &nbsp;·&nbsp;
          <strong>Ticket promedio:</strong> Bs {resumen.ticketPromedio.toFixed(2)} (USD{" "}
          {(resumen.ticketPromedio / config.tasa_cambio_dia).toFixed(2)}) &nbsp;·&nbsp;
          <strong>Tasa del día:</strong> {config.tasa_cambio_dia.toFixed(2)} Bs/$
        </p>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>N° ventas</th>
              <th>Total Bs</th>
              <th>Total USD</th>
              <th>Ganancia Bs</th>
              <th>Ganancia USD</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.fecha}>
                <td>{new Date(f.fecha + "T00:00:00").toLocaleDateString("es-VE")}</td>
                <td>{f.num_ventas}</td>
                <td>{f.total_bs.toFixed(2)}</td>
                <td>{(f.total_bs / config.tasa_cambio_dia).toFixed(2)}</td>
                <td>{f.ganancia_bs.toFixed(2)}</td>
                <td>{(f.ganancia_bs / config.tasa_cambio_dia).toFixed(2)}</td>
              </tr>
            ))}
            {filas.length === 0 && (
              <tr>
                <td colSpan={6}>Sin ventas en ese rango de fechas.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
