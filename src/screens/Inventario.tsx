import { useEffect, useMemo, useState } from "react";
import { getDb } from "../db";
import { ConfigRow, ProductoInventario } from "../types";
import { estadoStock, gananciaUnitariaUsd, precioVentaBsHoy, precioVentaUsd } from "../precios";
import { fechaHoraVenezuela } from "../fecha";

// Solo el total histórico de entradas/salidas, como referencia rápida en
// el catálogo — sin botones ni edición acá; para registrar un movimiento
// nuevo o ver el detalle fecha por fecha está la pestaña Movimientos.
type ProductoConMovimientos = ProductoInventario & {
  entradas_totales: number;
  salidas_totales: number;
};

export default function Inventario({ config }: { config: ConfigRow }) {
  const [productos, setProductos] = useState<ProductoConMovimientos[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [soloProblemas, setSoloProblemas] = useState(false);

  // --- Alta rápida ---
  const [codigo, setCodigo] = useState("");
  const [nombre, setNombre] = useState("");
  const [costoUsd, setCostoUsd] = useState("");
  const [margen, setMargen] = useState("30");
  const [stockInicial, setStockInicial] = useState("0");

  async function cargar() {
    setError(null);
    try {
      const db = await getDb();
      const term = `%${busqueda.trim()}%`;
      const rows = await db.select<ProductoConMovimientos[]>(
        `SELECT p.*, c.nombre as categoria_nombre,
                COALESCE((SELECT SUM(m.cantidad) FROM movimientos_inventario m
                          WHERE m.producto_id = p.id AND m.tipo = 'ENTRADA'), 0) as entradas_totales,
                COALESCE((SELECT SUM(m.cantidad) FROM movimientos_inventario m
                          WHERE m.producto_id = p.id AND m.tipo = 'SALIDA'), 0) as salidas_totales
         FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
         WHERE p.nombre LIKE $1 OR p.codigo_barra LIKE $1
         ORDER BY p.nombre`,
        [term]
      );
      setProductos(rows);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);

  const productosFiltrados = useMemo(
    () => (soloProblemas ? productos.filter((p) => estadoStock(p) !== "ok") : productos),
    [productos, soloProblemas]
  );

  async function agregarProducto(e: React.FormEvent) {
    e.preventDefault();
    setMensaje(null);
    if (!codigo || !nombre || !costoUsd) return;

    const db = await getDb();
    const costo = Number(costoUsd);
    const margenPct = Number(margen || "30");
    const precioBs = costo * config.tasa_cambio_dia * (1 + margenPct / 100);
    const stock = Number(stockInicial || "0");

    const id = crypto.randomUUID();
    try {
      // stock_minimo no se pide acá — queda en su valor por defecto (5,
      // definido en la base) y se puede seguir viendo/ajustando desde la
      // ficha del producto en Movimientos.
      await db.execute(
        `INSERT INTO productos (id, codigo_barra, nombre, costo_actual_usd, margen_porcentaje, precio_venta_bs, stock_actual)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, codigo, nombre, costo, margenPct, precioBs, stock]
      );
    } catch (err) {
      setMensaje(`No se pudo crear el producto (¿código repetido?): ${String(err)}`);
      return;
    }

    if (stock > 0) {
      await db.execute(
        `INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, created_at)
         VALUES ($1,$2,'ENTRADA',$3,'Inventario inicial',$4)`,
        [crypto.randomUUID(), id, stock, fechaHoraVenezuela()]
      );
    }

    setCodigo("");
    setNombre("");
    setCostoUsd("");
    setMargen("30");
    setStockInicial("0");
    await cargar();
  }

  // Costo, margen y stock mínimo son un solo UPDATE cada uno — a
  // diferencia de una venta o un ajuste de stock, una sola sentencia SQL
  // ya es atómica de por sí, así que no hace falta pasar por un comando
  // de Rust para esto.
  async function actualizarCostoYMargen(
    p: ProductoInventario,
    cambios: { costo_actual_usd?: number; margen_porcentaje?: number }
  ) {
    const nuevoCosto = cambios.costo_actual_usd ?? p.costo_actual_usd;
    const nuevoMargen = cambios.margen_porcentaje ?? p.margen_porcentaje ?? 0;
    if (nuevoCosto < 0 || nuevoMargen < 0) {
      setMensaje("El costo y el margen no pueden ser negativos.");
      return;
    }
    const nuevoPrecioBs = nuevoCosto * config.tasa_cambio_dia * (1 + nuevoMargen / 100);
    const db = await getDb();
    await db.execute(
      "UPDATE productos SET costo_actual_usd = $1, margen_porcentaje = $2, precio_venta_bs = $3 WHERE id = $4",
      [nuevoCosto, nuevoMargen, nuevoPrecioBs, p.id]
    );
    await cargar();
  }

  return (
    <div>
      {error && <p className="error">Error: {error}</p>}
      {mensaje && <p className="error">{mensaje}</p>}

      <section className="card">
        <h2>Agregar producto</h2>
        <p className="hint">
          Esta es un alta rápida para pruebas o casos sueltos. El flujo real de reposición va
          por el módulo de Compras (factura de proveedor → carga automática).
        </p>
        <form className="form-row" onSubmit={agregarProducto}>
          <input placeholder="Código de barra" value={codigo} onChange={(e) => setCodigo(e.target.value)} required />
          <input placeholder="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
          <input
            placeholder="Costo USD"
            type="number"
            step="0.01"
            value={costoUsd}
            onChange={(e) => setCostoUsd(e.target.value)}
            required
          />
          <input placeholder="Margen %" type="number" step="1" value={margen} onChange={(e) => setMargen(e.target.value)} />
          <input
            placeholder="Stock inicial"
            type="number"
            step="1"
            value={stockInicial}
            onChange={(e) => setStockInicial(e.target.value)}
          />
          <button type="submit">Guardar</button>
        </form>
      </section>

      <div className="seccion-ancha">
        <section className="card">
          <div className="form-row" style={{ alignItems: "center" }}>
            <input
              placeholder="Buscar por nombre o código"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              style={{ flex: 2 }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={soloProblemas}
                onChange={(e) => setSoloProblemas(e.target.checked)}
              />
              Solo stock bajo, crítico o agotado
            </label>
          </div>

          <div className="form-row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <h2 style={{ marginTop: 16 }}>
              Catálogo ({productosFiltrados.length}
              {soloProblemas ? ` de ${productos.length}` : ""})
            </h2>
            <button type="button" className="no-print" onClick={() => window.print()}>
              Imprimir lista para conteo
            </button>
          </div>
          <p className="hint">
            Costo y margen se editan directo en la tabla — escribe y sal del campo para guardar.
            El resto de las columnas se recalculan solas con la tasa del día. Cuando a un producto
            le queda 1 sola unidad, se marca como advertencia aunque no se haya configurado un
            mínimo.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="tabla-compacta">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Nombre</th>
                  <th>Categoría</th>
                  <th>Costo USD</th>
                  <th>Margen %</th>
                  <th>Venta USD</th>
                  <th>Venta Bs (hoy)</th>
                  <th>Ganancia USD/u.</th>
                  <th>Rentabilidad</th>
                  <th>Entradas</th>
                  <th>Salidas</th>
                  <th>Stock</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {productosFiltrados.map((p) => {
                  const estado = estadoStock(p);
                  const rentabilidadPct = p.costo_actual_usd > 0 ? (gananciaUnitariaUsd(p) / p.costo_actual_usd) * 100 : 0;
                  return (
                    <tr key={p.id}>
                      <td>{p.codigo_barra}</td>
                      <td>{p.nombre}</td>
                      <td>{p.categoria_nombre ?? "—"}</td>
                      <td>
                        <input
                          className="cant-input"
                          style={{ width: 90 }}
                          type="number"
                          step="0.01"
                          defaultValue={p.costo_actual_usd}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v >= 0 && v !== p.costo_actual_usd) actualizarCostoYMargen(p, { costo_actual_usd: v });
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="cant-input"
                          style={{ width: 65 }}
                          type="number"
                          step="1"
                          defaultValue={p.margen_porcentaje ?? 0}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v >= 0 && v !== (p.margen_porcentaje ?? 0)) actualizarCostoYMargen(p, { margen_porcentaje: v });
                          }}
                        />
                      </td>
                      <td>{precioVentaUsd(p).toFixed(2)}</td>
                      <td>{precioVentaBsHoy(p, config.tasa_cambio_dia).toFixed(2)}</td>
                      <td>{gananciaUnitariaUsd(p).toFixed(2)}</td>
                      <td>{rentabilidadPct.toFixed(1)}%</td>
                      <td>{p.entradas_totales}</td>
                      <td>{p.salidas_totales}</td>
                      <td>{p.stock_actual}</td>
                      <td>
                        {estado === "agotado" && <span className="badge badge-agotado">Agotado</span>}
                        {estado === "critico" && <span className="badge badge-critico">¡Última unidad!</span>}
                        {estado === "bajo" && <span className="badge badge-bajo">Stock bajo</span>}
                        {estado === "ok" && <span className="badge badge-ok">OK</span>}
                        {!p.activo && (
                          <span className="badge badge-agotado" style={{ marginLeft: 4 }}>
                            Inactivo
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {productosFiltrados.length === 0 && (
                  <tr>
                    <td colSpan={13} className="empty">
                      {productos.length === 0 ? "Sin productos todavía. Agrega el primero arriba." : "Nada que coincida con el filtro."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            ¿Necesitas registrar una entrada, salida o ver el historial de un producto? Eso está
            en la pestaña <strong>Movimientos</strong>.
          </p>

          {/* Solo aparece al imprimir (ver .imprimible en styles.css) — una
              lista simple para recorrer la tienda y contar a mano, con una
              columna en blanco para anotar lo contado y compararlo con el
              stock del sistema. */}
          <div className="imprimible">
            <h2>{config.nombre_negocio} — Conteo de stock</h2>
            <p>
              Impreso el {new Date().toLocaleString("es-VE")}
              {soloProblemas ? " — solo productos con stock bajo, crítico o agotado" : ""}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Nombre</th>
                  <th>Categoría</th>
                  <th>Stock sistema</th>
                  <th>Stock contado</th>
                </tr>
              </thead>
              <tbody>
                {productosFiltrados.map((p) => (
                  <tr key={p.id}>
                    <td>{p.codigo_barra}</td>
                    <td>{p.nombre}</td>
                    <td>{p.categoria_nombre ?? "—"}</td>
                    <td>{p.stock_actual}</td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
