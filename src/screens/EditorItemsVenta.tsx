import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { FacturaVentaItemEditable, Producto } from "../types";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";
import { precioVentaBsHoy } from "../precios";

type LineaEditable = {
  producto_id: string;
  nombre: string;
  cantidad: number;
  precio_unit_bs: number;
};

// Editor de los productos de una venta ya registrada — solo para admin,
// para cuando la caja se equivocó de producto o cantidad. El precio
// unitario de las líneas que ya estaban se mantiene igual a como se
// vendió; a un producto agregado de nuevo se le calcula el precio de hoy
// con la MISMA tasa con que se registró la venta original (no la del día
// de hoy), para que toda la factura quede a una sola tasa coherente.
export default function EditorItemsVenta({
  ventaId,
  itemsIniciales,
  tasaCambioDia,
  onGuardado,
  onCancelar,
}: {
  ventaId: string;
  itemsIniciales: FacturaVentaItemEditable[];
  tasaCambioDia: number;
  onGuardado: () => void;
  onCancelar: () => void;
}) {
  const [lineas, setLineas] = useState<LineaEditable[]>(
    itemsIniciales.map((it) => ({
      producto_id: it.producto_id,
      nombre: it.producto_nombre,
      cantidad: it.cantidad,
      precio_unit_bs: it.precio_unit_bs,
    }))
  );
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<Producto[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function buscar(texto: string) {
    setBusqueda(texto);
    if (!texto.trim()) {
      setResultados([]);
      return;
    }
    const db = await getDb();
    const term = `%${texto.trim()}%`;
    const termSinAcentos = `%${normalizarTexto(texto.trim())}%`;
    const rows = await db.select<Producto[]>(
      `SELECT * FROM productos WHERE activo = 1 AND (codigo_barra LIKE $1 OR ${sqlSinAcentos("nombre")} LIKE $2)
       ORDER BY nombre LIMIT 20`,
      [term, termSinAcentos]
    );
    setResultados(rows);
  }

  function agregarLinea(p: Producto) {
    setLineas((prev) => {
      const existe = prev.find((l) => l.producto_id === p.id);
      if (existe) {
        return prev.map((l) => (l.producto_id === p.id ? { ...l, cantidad: l.cantidad + 1 } : l));
      }
      return [
        ...prev,
        { producto_id: p.id, nombre: p.nombre, cantidad: 1, precio_unit_bs: precioVentaBsHoy(p, tasaCambioDia) },
      ];
    });
    setBusqueda("");
    setResultados([]);
  }

  function quitarLinea(producto_id: string) {
    setLineas((prev) => prev.filter((l) => l.producto_id !== producto_id));
  }

  function cambiarCantidad(producto_id: string, cantidad: number) {
    setLineas((prev) => prev.map((l) => (l.producto_id === producto_id ? { ...l, cantidad } : l)));
  }

  async function guardar() {
    if (lineas.length === 0) {
      setMensaje("La venta debe tener al menos un producto.");
      return;
    }
    if (lineas.some((l) => !l.cantidad || l.cantidad <= 0)) {
      setMensaje("Todas las líneas deben tener una cantidad mayor a 0.");
      return;
    }
    setGuardando(true);
    setMensaje(null);
    try {
      await invoke("editar_venta_items", {
        ventaId,
        items: lineas.map((l) => ({
          producto_id: l.producto_id,
          cantidad: l.cantidad,
          precio_unit_bs: l.precio_unit_bs,
        })),
      });
      onGuardado();
    } catch (e) {
      setMensaje(`No se pudo guardar: ${String(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  const total = lineas.reduce((a, l) => a + l.cantidad * l.precio_unit_bs, 0);

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Editar productos de la venta</h3>
      <p className="hint">
        Corrige cantidades, quita un producto que no correspondía, o agrega uno que faltó. El total
        y el saldo pendiente (si es a crédito) se recalculan solos al guardar; el stock se ajusta
        automáticamente por la diferencia.
      </p>
      <table>
        <thead>
          <tr>
            <th>Producto</th>
            <th>Cant.</th>
            <th>Precio Bs</th>
            <th>Subtotal Bs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lineas.map((l) => (
            <tr key={l.producto_id}>
              <td>{l.nombre}</td>
              <td>
                <input
                  className="cant-input"
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={l.cantidad}
                  onChange={(e) => cambiarCantidad(l.producto_id, Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </td>
              <td>{l.precio_unit_bs.toFixed(2)}</td>
              <td>{(l.cantidad * l.precio_unit_bs).toFixed(2)}</td>
              <td>
                <button className="link-btn link-btn-danger" onClick={() => quitarLinea(l.producto_id)}>
                  quitar
                </button>
              </td>
            </tr>
          ))}
          {lineas.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                Sin productos — agrega al menos uno.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p style={{ fontWeight: 700 }}>Nuevo total: Bs {total.toFixed(2)}</p>

      <div className="form-row" style={{ position: "relative" }}>
        <input
          placeholder="Buscar producto para agregar…"
          value={busqueda}
          onChange={(e) => buscar(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      {resultados.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: "4px 0 0",
            padding: 4,
            maxHeight: 200,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {resultados.map((p) => (
            <li
              key={p.id}
              onMouseDown={() => agregarLinea(p)}
              style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 14 }}
            >
              {p.nombre} <span className="hint">({p.codigo_barra})</span>
            </li>
          ))}
        </ul>
      )}

      {mensaje && <p className="error">{mensaje}</p>}
      <div className="form-row" style={{ marginTop: 12 }}>
        <button onClick={guardar} disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar cambios"}
        </button>
        <button className="link-btn" onClick={onCancelar}>
          cancelar
        </button>
      </div>
    </div>
  );
}
