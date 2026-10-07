import { useState } from "react";
import * as XLSX from "xlsx";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { exportarExcel } from "../exportarExcel";
import { Categoria, ConfigRow } from "../types";

// Mismas columnas (y mismo orden) que exportarInventario() en
// Inventario.tsx, para que un Excel exportado desde Kaxa se pueda volver a
// importar sin tocarle nada.
const COLUMNAS_PLANTILLA = ["Código", "Nombre", "Categoría", "Costo USD", "Margen %", "Venta USD", "Stock", "Stock mínimo"];

// Sinónimos reconocidos por columna — sin distinguir mayúsculas ni
// acentos, ignorando espacios de más (ver normalizar() abajo).
const SINONIMOS: Record<string, string[]> = {
  codigo: ["codigo", "código", "codigo de barras", "código de barras", "cod", "barcode"],
  nombre: ["nombre", "descripcion", "producto", "articulo"],
  categoria: ["categoria", "categoría"],
  costoUsd: ["costo usd", "costo", "costo $", "costo dolares"],
  margen: ["margen %", "margen", "margen porcentaje"],
  ventaUsd: ["venta usd", "precio", "precio venta", "pvp", "precio $"],
  precioBs: ["precio bs", "pvp bs", "venta bs"],
  stock: ["stock", "existencia", "cantidad", "inventario"],
  stockMinimo: ["stock minimo", "stock mínimo"],
};

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function detectarColumnas(encabezados: string[]): Partial<Record<string, number>> {
  const normalizados = encabezados.map(normalizar);
  const resultado: Partial<Record<string, number>> = {};
  for (const [clave, sinonimos] of Object.entries(SINONIMOS)) {
    const idx = normalizados.findIndex((h) => sinonimos.includes(h));
    if (idx >= 0) resultado[clave] = idx;
  }
  return resultado;
}

// Acepta "2,50" (coma decimal) igual que "2.50".
function numeroDesde(valor: unknown): number | null {
  if (valor == null || valor === "") return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).trim().replace(",", ".");
  if (texto === "") return null;
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

function textoDesde(valor: unknown): string {
  return valor == null ? "" : String(valor).trim();
}

export type FilaLista = {
  fila: number;
  codigoBarra: string;
  nombre: string;
  categoriaNombre: string | null;
  costoUsd: number;
  margenPorcentaje: number;
  precioVentaUsd: number;
  precioVentaBs: number;
  stockActual: number;
  stockMinimo: number | null;
  nota: string | null;
};

type FilaError = { fila: number; motivo: string };
type FilaDuplicada = { fila: number; codigoBarra: string; nombre: string };

type Resultado = {
  listas: FilaLista[];
  duplicadas: FilaDuplicada[];
  conError: FilaError[];
  columnasDetectadas: string[];
  columnasFaltantes: string[];
};

// Reconstruye exactamente las mismas reglas que agregarProducto() en
// Inventario.tsx (alta manual) — ver precios.ts para por qué el margen es
// bruto sobre el precio de venta, no markup sobre el costo.
function procesarFilas(
  filas: unknown[][],
  columnas: Partial<Record<string, number>>,
  categoriasPorNombre: Map<string, number>,
  codigosExistentes: Set<string>,
  tasaCambioDia: number
): Omit<Resultado, "columnasDetectadas" | "columnasFaltantes"> {
  const listas: FilaLista[] = [];
  const duplicadas: FilaDuplicada[] = [];
  const conError: FilaError[] = [];
  const codigosEnEsteArchivo = new Set<string>();

  filas.forEach((valores, i) => {
    const numeroFila = i + 2; // +1 por el encabezado, +1 porque Excel empieza en 1
    const get = (clave: string) => (columnas[clave] != null ? valores[columnas[clave]!] : undefined);

    const nombre = textoDesde(get("nombre"));
    const costoUsd = numeroDesde(get("costoUsd"));
    // Fila completamente vacía (a veces Excel deja filas en blanco al
    // final) — se ignora en silencio, no es un error del usuario.
    const filaVacia = valores.every((v) => v == null || String(v).trim() === "");
    if (filaVacia) return;

    if (!nombre) {
      conError.push({ fila: numeroFila, motivo: "falta el nombre" });
      return;
    }
    if (costoUsd == null) {
      conError.push({ fila: numeroFila, motivo: "el costo no es un número válido" });
      return;
    }
    if (costoUsd <= 0) {
      conError.push({ fila: numeroFila, motivo: "el costo debe ser mayor a 0" });
      return;
    }

    let codigoBarra = textoDesde(get("codigo"));
    if (!codigoBarra) {
      codigoBarra = `SINCOD-${crypto.randomUUID()}`;
    }
    const codigoClave = codigoBarra.toLowerCase();
    if (codigosExistentes.has(codigoClave) || codigosEnEsteArchivo.has(codigoClave)) {
      duplicadas.push({ fila: numeroFila, codigoBarra, nombre });
      return;
    }
    codigosEnEsteArchivo.add(codigoClave);

    const categoriaNombre = textoDesde(get("categoria")) || null;
    const margenDefectoCategoria = categoriaNombre ? categoriasPorNombre.get(categoriaNombre.toLowerCase()) : undefined;

    const ventaUsd = numeroDesde(get("ventaUsd"));
    const margenColumna = numeroDesde(get("margen"));
    const precioBs = numeroDesde(get("precioBs"));

    let margenPorcentaje: number;
    let nota: string | null = null;
    if (ventaUsd != null && ventaUsd > 0) {
      // Si vienen Venta USD y Margen a la vez, manda Venta USD (se
      // recalcula el margen) — así el precio final coincide con lo que el
      // cliente escribió, no con un margen que puede haber quedado viejo.
      margenPorcentaje = (1 - costoUsd / ventaUsd) * 100;
    } else if (margenColumna != null) {
      margenPorcentaje = margenColumna;
    } else if (precioBs != null && precioBs > 0) {
      const ventaUsdConvertido = precioBs / tasaCambioDia;
      margenPorcentaje = (1 - costoUsd / ventaUsdConvertido) * 100;
      nota = `convertido desde Precio Bs (Bs ${precioBs.toFixed(2)} a tasa ${tasaCambioDia.toFixed(2)})`;
    } else {
      margenPorcentaje = margenDefectoCategoria ?? 30;
      nota = categoriaNombre ? `margen por defecto de "${categoriaNombre}"` : "margen por defecto (30%)";
    }

    if (margenPorcentaje <= 0) {
      conError.push({ fila: numeroFila, motivo: "el precio de venta quedaría igual o por debajo del costo" });
      return;
    }
    if (margenPorcentaje >= 100) {
      conError.push({ fila: numeroFila, motivo: "el margen no puede ser 100% o más" });
      return;
    }

    const precioVentaUsdCalc = costoUsd / (1 - margenPorcentaje / 100);
    const precioVentaBsCalc = precioVentaUsdCalc * tasaCambioDia;

    const stockActual = numeroDesde(get("stock")) ?? 0;
    if (stockActual < 0) {
      conError.push({ fila: numeroFila, motivo: "el stock no puede ser negativo" });
      return;
    }
    const stockMinimo = numeroDesde(get("stockMinimo"));

    listas.push({
      fila: numeroFila,
      codigoBarra,
      nombre,
      categoriaNombre,
      costoUsd,
      margenPorcentaje,
      precioVentaUsd: precioVentaUsdCalc,
      precioVentaBs: precioVentaBsCalc,
      stockActual,
      stockMinimo: stockMinimo != null && stockMinimo >= 0 ? stockMinimo : null,
      nota,
    });
  });

  return { listas, duplicadas, conError };
}

export default function ImportarProductosExcel({
  config,
  avisoCache,
  onCerrar,
  onImportado,
}: {
  config: ConfigRow;
  // Las ediciones con Turso tienen una caché local que se refresca sola
  // cada ~60s (ver offline.rs) — el buscador de Venta lee de ahí, así que
  // los productos recién importados pueden tardar hasta 1 minuto en
  // aparecer.
  avisoCache?: string;
  onCerrar: () => void;
  onImportado: () => void;
}) {
  const [cargandoArchivo, setCargandoArchivo] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);
  const [hecho, setHecho] = useState<number | null>(null);

  async function descargarPlantilla() {
    await exportarExcel("plantilla-productos.xlsx", [
      {
        nombre: "Productos",
        columnas: COLUMNAS_PLANTILLA,
        filas: [
          ["7591234567890", "Harina de maíz 1kg", "Alimentos", 0.9, 30, "", 50, 10],
          ["", "Refresco cola 2L (sin código todavía)", "Bebidas", 1.2, "", 1.8, 24, 5],
        ],
      },
      {
        nombre: "Instrucciones",
        columnas: ["Instrucciones para llenar la plantilla"],
        filas: [
          ["Código: déjalo vacío si el producto todavía no tiene código de barras."],
          ["Nombre y Costo USD son obligatorios; el resto es opcional."],
          ["Si pones Venta USD, el margen se calcula solo (y manda sobre la columna Margen %)."],
          ["Si no pones ni Margen % ni Venta USD, se usa el margen de la categoría o 30% por defecto."],
          ["Categoría: si no existe todavía, se crea sola al importar."],
          ["Stock mínimo: si lo dejas vacío, queda en 5."],
        ],
      },
    ]);
  }

  async function elegirArchivo(archivo: File) {
    setCargandoArchivo(true);
    setMensaje(null);
    setResultado(null);
    setHecho(null);
    try {
      const buffer = await archivo.arrayBuffer();
      const libro = XLSX.read(buffer, { type: "array" });
      const hoja = libro.Sheets[libro.SheetNames[0]];
      const filasCrudas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, defval: null });
      if (filasCrudas.length === 0) {
        setMensaje("El archivo está vacío.");
        return;
      }
      const encabezados = (filasCrudas[0] as unknown[]).map((h) => textoDesde(h));
      const columnas = detectarColumnas(encabezados);

      const columnasFaltantes: string[] = [];
      if (columnas.nombre == null) columnasFaltantes.push("Nombre");
      if (columnas.costoUsd == null) columnasFaltantes.push("Costo USD");
      if (columnasFaltantes.length > 0) {
        setResultado({
          listas: [],
          duplicadas: [],
          conError: [],
          columnasDetectadas: Object.keys(columnas),
          columnasFaltantes,
        });
        return;
      }

      const db = await getDb();
      const categoriasRows = await db.select<Categoria[]>("SELECT id, nombre, margen_defecto FROM categorias");
      const categoriasPorNombre = new Map(categoriasRows.map((c) => [c.nombre.toLowerCase(), c.margen_defecto]));
      const productosRows = await db.select<{ codigo_barra: string }[]>("SELECT codigo_barra FROM productos");
      const codigosExistentes = new Set(productosRows.map((p) => p.codigo_barra.toLowerCase()));

      const filasDatos = filasCrudas.slice(1);
      const procesado = procesarFilas(filasDatos, columnas, categoriasPorNombre, codigosExistentes, config.tasa_cambio_dia);
      setResultado({ ...procesado, columnasDetectadas: Object.keys(columnas), columnasFaltantes: [] });
      setNombreArchivo(archivo.name);
    } catch (e) {
      setMensaje(`No se pudo leer el archivo: ${String(e)}`);
    } finally {
      setCargandoArchivo(false);
    }
  }

  async function confirmarImportacion() {
    if (!resultado || resultado.listas.length === 0) return;
    setImportando(true);
    setMensaje(null);
    try {
      const { creados } = await invoke<{ creados: number }>("importar_productos", {
        input: {
          items: resultado.listas.map((f) => ({
            codigo_barra: f.codigoBarra,
            nombre: f.nombre,
            categoria_nombre: f.categoriaNombre,
            costo_actual_usd: f.costoUsd,
            margen_porcentaje: f.margenPorcentaje,
            precio_venta_bs: f.precioVentaBs,
            stock_actual: f.stockActual,
            stock_minimo: f.stockMinimo,
          })),
        },
      });
      setHecho(creados);
      setResultado(null);
      await onImportado();
    } catch (e) {
      setMensaje(`No se pudo completar la importación (no se creó ningún producto): ${String(e)}`);
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="modal-fondo" onMouseDown={onCerrar}>
      <div className="modal-caja" style={{ maxWidth: 820 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Importar productos desde Excel</h2>
          <button type="button" className="link-btn" onClick={onCerrar}>
            cerrar
          </button>
        </div>

        {hecho != null ? (
          <div>
            <p className="hint" style={{ marginTop: 0 }}>
              Se importaron {hecho} producto{hecho === 1 ? "" : "s"} ✅
            </p>
            {avisoCache && <p className="hint">{avisoCache}</p>}
            <button type="button" onClick={onCerrar}>
              Listo
            </button>
          </div>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Para cargar tu catálogo completo de una vez: descarga la plantilla, llénala con tus
              productos y luego elige el archivo acá.
            </p>
            <div className="form-row">
              <button type="button" onClick={descargarPlantilla}>
                Descargar plantilla
              </button>
              <label className="link-btn" style={{ cursor: cargandoArchivo ? "default" : "pointer" }}>
                {cargandoArchivo ? "Leyendo…" : "Elegir archivo"}
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  disabled={cargandoArchivo}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const archivo = e.target.files?.[0];
                    if (archivo) elegirArchivo(archivo);
                    e.target.value = "";
                  }}
                />
              </label>
              {nombreArchivo && <span className="hint">{nombreArchivo}</span>}
            </div>

            {mensaje && <p className="error">{mensaje}</p>}

            {resultado && resultado.columnasFaltantes.length > 0 && (
              <p className="error">
                Falta la columna {resultado.columnasFaltantes.join(" y ")} — revisa los encabezados
                de la primera fila.
              </p>
            )}

            {resultado && resultado.columnasFaltantes.length === 0 && (
              <>
                <div className="totales" style={{ marginTop: 12, marginBottom: 12 }}>
                  <span>
                    <strong>{resultado.listas.length}</strong> listos para crear
                  </span>
                  <span>
                    <strong>{resultado.duplicadas.length}</strong> ya existen (se van a saltar)
                  </span>
                  <span>
                    <strong>{resultado.conError.length}</strong> con error
                  </span>
                </div>

                {resultado.conError.length > 0 && (
                  <div style={{ maxHeight: 120, overflowY: "auto", marginBottom: 12 }}>
                    <table className="tabla-compacta">
                      <thead>
                        <tr>
                          <th>Fila</th>
                          <th>Motivo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultado.conError.map((f) => (
                          <tr key={f.fila}>
                            <td>{f.fila}</td>
                            <td>{f.motivo}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {resultado.listas.length > 0 && (
                  <div style={{ maxHeight: 260, overflowY: "auto" }}>
                    <table className="tabla-compacta">
                      <thead>
                        <tr>
                          <th>Fila</th>
                          <th>Código</th>
                          <th>Nombre</th>
                          <th>Costo USD</th>
                          <th>Margen %</th>
                          <th>Venta USD</th>
                          <th>Venta Bs (hoy)</th>
                          <th>Stock</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultado.listas.slice(0, 20).map((f) => (
                          <tr key={f.fila}>
                            <td>{f.fila}</td>
                            <td>{f.codigoBarra.startsWith("SINCOD-") ? <span className="hint">sin código</span> : f.codigoBarra}</td>
                            <td>
                              {f.nombre}
                              {f.nota && (
                                <>
                                  <br />
                                  <span className="hint">{f.nota}</span>
                                </>
                              )}
                            </td>
                            <td>{f.costoUsd.toFixed(2)}</td>
                            <td>{f.margenPorcentaje.toFixed(1)}</td>
                            <td>{f.precioVentaUsd.toFixed(2)}</td>
                            <td>{f.precioVentaBs.toFixed(2)}</td>
                            <td>{f.stockActual}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {resultado.listas.length > 20 && (
                      <p className="hint">… y {resultado.listas.length - 20} más.</p>
                    )}
                  </div>
                )}

                <div className="form-row" style={{ marginTop: 12 }}>
                  <button type="button" onClick={confirmarImportacion} disabled={importando || resultado.listas.length === 0}>
                    {importando ? "Importando…" : `Importar ${resultado.listas.length} producto${resultado.listas.length === 1 ? "" : "s"}`}
                  </button>
                  <button type="button" className="link-btn" onClick={() => setResultado(null)} disabled={importando}>
                    cancelar
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
