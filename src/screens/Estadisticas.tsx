import { useEffect, useState } from "react";
import { getDb } from "../db";
import { ConfigRow } from "../types";
import { hoyVenezuela } from "../fecha";
import { GraficoTorta, BarraHorizontal, HistogramaHoras, COLORES } from "../graficos";
import KaxMascota, { PoseKax } from "../KaxMascota";
import { obtenerConclusiones } from "../asistente";

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

// Producto "placeholder" del recargo de delivery (código de barra 1111111,
// legado de antes de la integración) — no es un producto real, así que se
// excluye de todos los rankings de Estadísticas.
const PRODUCTO_DELIVERY_ID = "f195fbac-103d-48fa-a27a-28371fba7745";

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
  const [totalBs, setTotalBs] = useState(0);
  const [gananciaBs, setGananciaBs] = useState(0);
  const [numVentas, setNumVentas] = useState(0);

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      const db = await getDb();

      // Un producto por peso (ej. ají dulce) cuenta como 1 producto
      // vendido por línea, no como los kilos que pesó esa venta — mezclar
      // kilos con unidades da un número sin sentido en este ranking. Solo
      // afecta este conteo; el monto en Bs sigue siendo el real.
      setProductosPorCantidad(
        await db.select<ProductoTop[]>(
          `SELECT vi.producto_id, p.nombre,
                  SUM(CASE WHEN p.por_peso = 1 THEN 1 ELSE vi.cantidad END) as cantidad,
                  SUM(vi.subtotal_bs) as monto_bs
           FROM venta_items vi
           JOIN ventas v ON v.id = vi.venta_id
           JOIN productos p ON p.id = vi.producto_id
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2 AND p.id <> $3
           GROUP BY vi.producto_id
           ORDER BY cantidad DESC
           LIMIT 10`,
          [desde, hasta, PRODUCTO_DELIVERY_ID]
        )
      );

      setProductosPorGanancia(
        await db.select<ProductoGanancia[]>(
          `SELECT vi.producto_id, p.nombre,
                  SUM(vi.cantidad * (vi.precio_unit_bs - p.costo_actual_usd * v.tasa_cambio_dia)) as ganancia_bs
           FROM venta_items vi
           JOIN ventas v ON v.id = vi.venta_id
           JOIN productos p ON p.id = vi.producto_id
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2 AND p.id <> $3
           GROUP BY vi.producto_id
           ORDER BY ganancia_bs DESC
           LIMIT 10`,
          [desde, hasta, PRODUCTO_DELIVERY_ID]
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
           WHERE date(v.fecha_hora) BETWEEN $1 AND $2 AND p.id <> $3
           GROUP BY categoria
           ORDER BY monto_bs DESC
           LIMIT 5`,
          [desde, hasta, PRODUCTO_DELIVERY_ID]
        )
      );

      // Sin LIMIT/ORDER BY acá — se completan las 24 horas del día más
      // abajo (con 0 en las que no hubo ventas) para el histograma
      // completo, no solo las puntas.
      setHorasPico(
        await db.select<HoraPico[]>(
          `SELECT strftime('%H', fecha_hora) as hora, COUNT(*) as num_ventas
           FROM ventas
           WHERE date(fecha_hora) BETWEEN $1 AND $2
           GROUP BY hora`,
          [desde, hasta]
        )
      );

      const nuevos = await db.select<{ n: number }[]>(
        `SELECT COUNT(*) as n FROM clientes WHERE date(created_at) BETWEEN $1 AND $2`,
        [desde, hasta]
      );
      setClientesNuevos(nuevos[0]?.n ?? 0);

      // Total vendido y ganancia del mismo rango — para que el Asistente
      // Kax pueda comentar el margen general, igual que en Reportes.
      const totales = await db.select<{ total_bs: number; num_ventas: number }[]>(
        `SELECT COALESCE(SUM(total_bs), 0) as total_bs, COUNT(*) as num_ventas
         FROM ventas WHERE date(fecha_hora) BETWEEN $1 AND $2`,
        [desde, hasta]
      );
      setTotalBs(totales[0]?.total_bs ?? 0);
      setNumVentas(totales[0]?.num_ventas ?? 0);
      const ganancia = await db.select<{ ganancia_bs: number }[]>(
        `SELECT COALESCE(SUM(vi.cantidad * (vi.precio_unit_bs - p.costo_actual_usd * v.tasa_cambio_dia)), 0) as ganancia_bs
         FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id
         WHERE date(v.fecha_hora) BETWEEN $1 AND $2`,
        [desde, hasta]
      );
      setGananciaBs(ganancia[0]?.ganancia_bs ?? 0);
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

  const maxCantidad = Math.max(1, ...productosPorCantidad.map((p) => p.cantidad));
  const maxGananciaProducto = Math.max(1, ...productosPorGanancia.map((p) => p.ganancia_bs));
  const maxGasto = Math.max(1, ...clientesFrecuentes.map((c) => c.total_gastado_bs));

  const horasPorHora: Record<string, number> = {};
  for (const h of horasPico) horasPorHora[h.hora] = h.num_ventas;
  const horas24 = Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, "0");
    return { hora: hh, num_ventas: horasPorHora[hh] ?? 0 };
  });
  const horaPicoTop = horas24.reduce((a, b) => (b.num_ventas > a.num_ventas ? b : a), horas24[0]);

  const conclusiones = obtenerConclusiones({
    totalBs,
    gananciaBs,
    numVentas,
    metodosPago,
    productosPorCantidad,
    categorias,
    clientesFrecuentes,
    horaPicoTop,
  });
  const poseKax: PoseKax = conclusiones.some((c) => c.prioridad === "atencion")
    ? "alerta"
    : conclusiones.some((c) => c.prioridad === "positivo")
      ? "celebrando"
      : "neutral";

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

      {conclusiones.length > 0 && (
        <div className="card">
          <div className="form-row" style={{ alignItems: "center", marginBottom: 10 }}>
            <KaxMascota pose={poseKax} size={40} />
            <h2 style={{ margin: 0 }}>Asistente Kax</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {conclusiones.map((c, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  borderRadius: 10,
                  padding: 10,
                  fontSize: 14,
                  background:
                    c.prioridad === "atencion" ? "var(--warn-bg)" : c.prioridad === "positivo" ? "var(--accent-soft-bg)" : "var(--border-subtle)",
                }}
              >
                <span style={{ flexShrink: 0 }}>{c.icono}</span>
                <span>{c.texto}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="venta-layout">
        <div className="card">
          <h2>Productos más vendidos</h2>
          {productosPorCantidad.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {productosPorCantidad.slice(0, 5).map((p, i) => (
                <BarraHorizontal
                  key={p.producto_id}
                  etiqueta={p.nombre}
                  valor={p.cantidad}
                  max={maxCantidad}
                  color={COLORES[i % COLORES.length]}
                  sufijo={`${p.cantidad} vendidos`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2>Productos que más ganancia generan</h2>
          {productosPorGanancia.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {productosPorGanancia.slice(0, 5).map((p, i) => (
                <BarraHorizontal
                  key={p.producto_id}
                  etiqueta={p.nombre}
                  valor={p.ganancia_bs}
                  max={maxGananciaProducto}
                  color={COLORES[i % COLORES.length]}
                  sufijo={`Bs ${p.ganancia_bs.toLocaleString("es-VE", { maximumFractionDigits: 0 })}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="venta-layout">
        <div className="card">
          <h2>Clientes frecuentes</h2>
          {clientesFrecuentes.length === 0 ? (
            <p className="empty">Sin compras con cliente identificado en ese rango.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {clientesFrecuentes.slice(0, 5).map((c, i) => (
                <BarraHorizontal
                  key={c.cliente_id}
                  etiqueta={`${c.nombre ?? "—"} (${c.num_compras})`}
                  valor={c.total_gastado_bs}
                  max={maxGasto}
                  color={COLORES[i % COLORES.length]}
                  sufijo={`Bs ${c.total_gastado_bs.toLocaleString("es-VE", { maximumFractionDigits: 0 })}`}
                />
              ))}
            </div>
          )}
          <p className="hint">Clientes nuevos registrados en el rango: {clientesNuevos}</p>
        </div>

        <div className="card">
          <h2>Métodos de pago</h2>
          {metodosPago.length === 0 ? (
            <p className="empty">Sin pagos en ese rango de fechas.</p>
          ) : (
            <GraficoTorta datos={metodosPago.map((m) => ({ etiqueta: m.metodo.split("_").join(" "), valor: m.monto_bs }))} />
          )}
        </div>
      </div>

      <div className="venta-layout">
        <div className="card">
          <h2>Categorías más vendidas</h2>
          {categorias.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <GraficoTorta datos={categorias.map((c) => ({ etiqueta: c.categoria, valor: c.monto_bs }))} />
          )}
        </div>

        <div className="card">
          <h2>Horas de mayor venta</h2>
          {horasPico.length === 0 ? (
            <p className="empty">Sin ventas en ese rango de fechas.</p>
          ) : (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                La hora más movida es <strong style={{ color: "var(--accent-text)" }}>{horaPicoTop.hora}:00</strong>, con{" "}
                {horaPicoTop.num_ventas} venta{horaPicoTop.num_ventas === 1 ? "" : "s"}.
              </p>
              <HistogramaHoras horas24={horas24} horaPico={horaPicoTop.hora} />
            </>
          )}
          <p className="hint">Hora local de Venezuela.</p>
        </div>
      </div>
    </div>
  );
}
