import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { Categoria, ConfigRow, ProductoInventario } from "../types";
import { estadoStock, formatearStock, gananciaUnitariaUsd, precioVentaBsHoy, precioVentaUsd } from "../precios";
import { fechaHoraVenezuela } from "../fecha";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";

// Solo el total histórico de entradas/salidas, como referencia rápida en
// el catálogo — sin botones ni edición acá; para registrar un movimiento
// nuevo o ver el detalle fecha por fecha está la pestaña Movimientos.
type ProductoConMovimientos = ProductoInventario & {
  entradas_totales: number;
  salidas_totales: number;
};

// Valor especial para el filtro de categoría — distinto de "" (que
// significa "todas") y de cualquier id real de categoria.
const SIN_CATEGORIA = "__SIN_CATEGORIA__";

export default function Inventario({
  config,
  soloProblemasInicial,
}: {
  config: ConfigRow;
  soloProblemasInicial?: boolean;
}) {
  const [productos, setProductos] = useState<ProductoConMovimientos[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [categoriaFiltro, setCategoriaFiltro] = useState("");
  const [soloProblemas, setSoloProblemas] = useState(soloProblemasInicial ?? false);
  // El catálogo completo puede ser cientos de productos — sin paginar,
  // cada uno con varios <input>/<select> editables, la tabla entera se
  // vuelve muchísimos nodos del DOM de una sola vez, y eso es justo lo
  // que se siente pesado en una PC vieja. Paginar acá (solo la tabla
  // editable en pantalla, no la lista para imprimir de más abajo, que
  // necesita salir completa) es la optimización con más impacto de toda
  // esta pantalla.
  const [pagina, setPagina] = useState(0);
  const TAMANO_PAGINA = 50;

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
      const termCrudo = busqueda.trim();
      const rows = await db.select<ProductoConMovimientos[]>(
        `SELECT p.*, c.nombre as categoria_nombre,
                COALESCE((SELECT SUM(m.cantidad) FROM movimientos_inventario m
                          WHERE m.producto_id = p.id AND m.tipo = 'ENTRADA'), 0) as entradas_totales,
                COALESCE((SELECT SUM(m.cantidad) FROM movimientos_inventario m
                          WHERE m.producto_id = p.id AND m.tipo = 'SALIDA'), 0) as salidas_totales
         FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
         WHERE ${sqlSinAcentos("p.nombre")} LIKE $1 OR p.codigo_barra LIKE $2
         ORDER BY p.nombre`,
        [`%${normalizarTexto(termCrudo)}%`, `%${termCrudo}%`]
      );
      setProductos(rows);
    } catch (e) {
      setError(String(e));
    }
  }

  async function cargarCategorias() {
    const db = await getDb();
    setCategorias(await db.select<Categoria[]>("SELECT * FROM categorias ORDER BY nombre"));
  }

  useEffect(() => {
    cargarCategorias();
  }, []);

  // Debounce — sin esto, cada letra tecleada dispara una consulta contra
  // la base remota de una (esta pantalla no puede usar la caché local
  // rápida porque su consulta también suma entradas/salidas desde
  // movimientos_inventario, que la caché no espeja). En una PC vieja,
  // encadenar varias de estas consultas sin esperar es justo el tipo de
  // trabajo de fondo que se siente como que la app se traba al escribir.
  useEffect(() => {
    const timer = setTimeout(cargar, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);

  // "Problema" acá son solo los casos duros (agotado o 1 sola unidad) — el
  // "stock bajo" por mínimo configurable ya no cuenta como advertencia,
  // a pedido explícito (generaba demasiado ruido con cientos de productos).
  const productosFiltrados = useMemo(() => {
    let base = productos;
    if (soloProblemas) {
      base = base.filter((p) => estadoStock(p) === "agotado" || estadoStock(p) === "critico");
    }
    if (categoriaFiltro === SIN_CATEGORIA) {
      base = base.filter((p) => !p.categoria_id);
    } else if (categoriaFiltro) {
      base = base.filter((p) => p.categoria_id === categoriaFiltro);
    }
    return base;
  }, [productos, soloProblemas, categoriaFiltro]);

  const totalPaginas = Math.max(1, Math.ceil(productosFiltrados.length / TAMANO_PAGINA));

  useEffect(() => {
    setPagina(0);
  }, [busqueda, soloProblemas, categoriaFiltro]);

  useEffect(() => {
    if (pagina > totalPaginas - 1) setPagina(totalPaginas - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPaginas]);

  const productosPagina = useMemo(
    () => productosFiltrados.slice(pagina * TAMANO_PAGINA, (pagina + 1) * TAMANO_PAGINA),
    [productosFiltrados, pagina]
  );

  async function agregarProducto(e: React.FormEvent) {
    e.preventDefault();
    setMensaje(null);
    if (!codigo || !nombre || !costoUsd) return;

    const db = await getDb();
    const costo = Number(costoUsd);
    const margenPct = Number(margen || "30");
    // Margen bruto sobre el precio de venta (ver precios.ts): costo 2.99 +
    // margen 30% -> precio 4.27, no 3.89. Topado en 99.99 para no dividir
    // por cero o un número negativo.
    const margenClamp = Math.min(Math.max(margenPct, 0), 99.99);
    const precioBs = (costo / (1 - margenClamp / 100)) * config.tasa_cambio_dia;
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
    const margenClamp = Math.min(Math.max(nuevoMargen, 0), 99.99);
    const nuevoPrecioBs = (nuevoCosto / (1 - margenClamp / 100)) * config.tasa_cambio_dia;
    const db = await getDb();
    await db.execute(
      "UPDATE productos SET costo_actual_usd = $1, margen_porcentaje = $2, precio_venta_bs = $3 WHERE id = $4",
      [nuevoCosto, nuevoMargen, nuevoPrecioBs, p.id]
    );
    await cargar();
  }

  async function actualizarCodigo(p: ProductoInventario, nuevoCodigo: string) {
    const codigo = nuevoCodigo.trim();
    if (!codigo || codigo === p.codigo_barra) return;
    const db = await getDb();
    try {
      await db.execute("UPDATE productos SET codigo_barra = $1 WHERE id = $2", [codigo, p.id]);
    } catch (e) {
      setMensaje(`No se pudo cambiar el código (¿ya existe en otro producto?): ${String(e)}`);
      return;
    }
    setMensaje(null);
    await cargar();
  }

  async function actualizarNombre(p: ProductoInventario, nuevoNombre: string) {
    const valor = nuevoNombre.trim();
    if (!valor || valor === p.nombre) return;
    const db = await getDb();
    await db.execute("UPDATE productos SET nombre = $1 WHERE id = $2", [valor, p.id]);
    await cargar();
  }

  async function actualizarCategoria(p: ProductoInventario, categoriaId: string) {
    const db = await getDb();
    await db.execute("UPDATE productos SET categoria_id = $1 WHERE id = $2", [categoriaId || null, p.id]);
    await cargar();
  }

  async function activarProducto(p: ProductoInventario) {
    const db = await getDb();
    await db.execute("UPDATE productos SET activo = 1 WHERE id = $1", [p.id]);
    await cargar();
  }

  async function actualizarDisponibleDelivery(p: ProductoInventario, disponible: boolean) {
    const db = await getDb();
    await db.execute("UPDATE productos SET disponible_delivery = $1 WHERE id = $2", [
      disponible ? 1 : 0,
      p.id,
    ]);
    await cargar();
  }

  const [sincronizandoDelivery, setSincronizandoDelivery] = useState(false);

  async function sincronizarDelivery() {
    setSincronizandoDelivery(true);
    setMensaje(null);
    try {
      const n = await invoke<number>("sincronizar_catalogo_delivery");
      setMensaje(`Catálogo sincronizado con la app de delivery (${n} productos).`);
    } catch (e) {
      setMensaje(`No se pudo sincronizar con delivery: ${String(e)}`);
    } finally {
      setSincronizandoDelivery(false);
    }
  }

  // Un producto solo se puede borrar del todo si nunca se vendió, compró
  // ni tuvo ningún movimiento — si tiene historia, borrarlo dejaría huecos
  // en ventas/facturas viejas (el nombre desaparecería de esos registros),
  // así que en ese caso se ofrece desactivarlo en su lugar: deja de
  // aparecer para vender pero conserva todo su historial.
  async function eliminarProducto(p: ProductoInventario) {
    setMensaje(null);
    const db = await getDb();
    const [conteo] = await db.select<{ total: number }[]>(
      `SELECT
         (SELECT COUNT(*) FROM venta_items WHERE producto_id = $1) +
         (SELECT COUNT(*) FROM items_factura_compra WHERE producto_id = $1) +
         (SELECT COUNT(*) FROM movimientos_inventario WHERE producto_id = $1) +
         (SELECT COUNT(*) FROM lotes_producto WHERE producto_id = $1) as total`,
      [p.id]
    );

    if (conteo.total > 0) {
      if (
        !window.confirm(
          `"${p.nombre}" ya tiene historial (ventas, compras o movimientos), así que no se puede borrar del todo sin perder esos registros. ¿Lo desactivo en su lugar? Deja de poder venderse, pero conserva su historial.`
        )
      ) {
        return;
      }
      await db.execute("UPDATE productos SET activo = 0 WHERE id = $1", [p.id]);
      await cargar();
      return;
    }

    if (!window.confirm(`¿Eliminar "${p.nombre}" del catálogo? No tiene historial, así que se borra por completo.`)) {
      return;
    }
    await db.execute("DELETE FROM productos WHERE id = $1", [p.id]);
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
            <select value={categoriaFiltro} onChange={(e) => setCategoriaFiltro(e.target.value)}>
              <option value="">Todas las categorías</option>
              <option value={SIN_CATEGORIA}>Sin categoría</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={soloProblemas}
                onChange={(e) => setSoloProblemas(e.target.checked)}
              />
              Solo crítico (1 unidad) o agotado
            </label>
          </div>

          <div className="form-row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <h2 style={{ marginTop: 16 }}>
              Catálogo ({productosFiltrados.length}
              {soloProblemas || categoriaFiltro ? ` de ${productos.length}` : ""})
            </h2>
            <button
              type="button"
              className="no-print"
              onClick={sincronizarDelivery}
              disabled={sincronizandoDelivery}
            >
              {sincronizandoDelivery ? "Sincronizando…" : "Sincronizar con delivery ahora"}
            </button>
            <button type="button" className="no-print" onClick={() => window.print()}>
              Imprimir lista para conteo
            </button>
          </div>
          {totalPaginas > 1 && (
            <div className="form-row no-print" style={{ alignItems: "center", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
                ← Anterior
              </button>
              <span className="hint" style={{ margin: 0 }}>
                Página {pagina + 1} de {totalPaginas}
              </span>
              <button type="button" disabled={pagina >= totalPaginas - 1} onClick={() => setPagina((p) => p + 1)}>
                Siguiente →
              </button>
            </div>
          )}
          <p className="hint" style={{ marginTop: totalPaginas > 1 ? 10 : -8 }}>
            Código, nombre, categoría, costo y margen se editan directo en la tabla — escribe y
            sal del campo (o cambia el desplegable) para guardar. El resto de las columnas se
            recalculan solas con la tasa del día. Cuando a un producto le queda 1 sola unidad, se
            marca como advertencia aunque no se haya configurado un mínimo.
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
                  <th>Delivery</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {productosPagina.map((p) => {
                  const estado = estadoStock(p);
                  const rentabilidadPct = p.costo_actual_usd > 0 ? (gananciaUnitariaUsd(p) / p.costo_actual_usd) * 100 : 0;
                  return (
                    <tr key={p.id}>
                      <td>
                        <input
                          className="cant-input"
                          style={{ width: 82 }}
                          defaultValue={p.codigo_barra}
                          onBlur={(e) => actualizarCodigo(p, e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="cant-input"
                          style={{ width: 250 }}
                          defaultValue={p.nombre}
                          onBlur={(e) => actualizarNombre(p, e.target.value)}
                        />
                      </td>
                      <td>
                        <select
                          value={p.categoria_id ?? ""}
                          onChange={(e) => actualizarCategoria(p, e.target.value)}
                          style={{ width: 105, fontSize: 12 }}
                        >
                          <option value="">Sin categoría</option>
                          {categorias.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="cant-input"
                          style={{ width: 68 }}
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
                          style={{ width: 48 }}
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
                      <td>{formatearStock(p.stock_actual)}</td>
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
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={!!p.disponible_delivery}
                          onChange={(e) => actualizarDisponibleDelivery(p, e.target.checked)}
                          title="Se ofrece en la app de delivery"
                        />
                      </td>
                      <td>
                        {!p.activo && (
                          <button type="button" className="link-btn" onClick={() => activarProducto(p)}>
                            activar
                          </button>
                        )}
                        <button
                          type="button"
                          className="link-btn link-btn-danger"
                          onClick={() => eliminarProducto(p)}
                        >
                          eliminar
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {productosFiltrados.length === 0 && (
                  <tr>
                    <td colSpan={15} className="empty">
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
