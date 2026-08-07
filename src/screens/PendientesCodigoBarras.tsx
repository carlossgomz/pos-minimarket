import { useEffect, useState } from "react";
import { getDb } from "../db";
import { Producto } from "../types";
import { formatearStock } from "../precios";

// Ventana temporal (no una pestaña fija) visible desde CUALQUIER sección
// para cualquier rol — el cajero no tiene acceso a Inventario, pero es
// quien está físicamente en la tienda con el escáner cuando llega
// mercancía nueva. Se abre desde el aviso del encabezado (ver App.tsx) y
// se cierra sola de contenido en cuanto no queda ningún producto
// pendiente de código de barras.
export default function PendientesCodigoBarras({
  onCerrar,
  onCambio,
}: {
  onCerrar: () => void;
  onCambio: () => void;
}) {
  const [pendientes, setPendientes] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function cargar() {
    const db = await getDb();
    const rows = await db.select<Producto[]>(
      "SELECT * FROM productos WHERE codigo_barra LIKE 'SINCOD-%' ORDER BY nombre"
    );
    setPendientes(rows);
    setCargando(false);
  }

  useEffect(() => {
    cargar();
  }, []);

  async function asignar(p: Producto, codigoEscaneado: string) {
    const codigo = codigoEscaneado.trim();
    if (!codigo) return;
    const db = await getDb();
    try {
      await db.execute("UPDATE productos SET codigo_barra = $1 WHERE id = $2", [codigo, p.id]);
    } catch (e) {
      setMensaje(`No se pudo asignar "${codigo}" a ${p.nombre}: ${String(e)}`);
      return;
    }
    setMensaje(null);
    await cargar();
    onCambio();
  }

  return (
    <div className="modal-fondo" onMouseDown={onCerrar}>
      <div className="modal-caja" onMouseDown={(e) => e.stopPropagation()}>
        <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Productos pendientes de código de barras</h2>
          <button type="button" className="link-btn" onClick={onCerrar}>
            cerrar
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Se crearon desde una factura de compra y todavía no tienen código de barras real — haz
          clic en la casilla de cada uno y escanea el código de la caja física, se asigna solo.
          Esta ventana se puede volver a abrir cuando quieras desde el aviso de arriba.
        </p>
        {mensaje && <p className="error">{mensaje}</p>}
        {cargando ? (
          <p className="hint">Cargando…</p>
        ) : pendientes.length === 0 ? (
          <p className="empty">No queda ningún producto pendiente ✅</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tabla-compacta">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Código del proveedor</th>
                  <th>Stock</th>
                  <th>Escanear código de barras</th>
                </tr>
              </thead>
              <tbody>
                {pendientes.map((p, i) => (
                  <tr key={p.id}>
                    <td>{p.nombre}</td>
                    <td>{p.codigo_proveedor ?? "—"}</td>
                    <td>{formatearStock(p.stock_actual)}</td>
                    <td>
                      <input
                        className="cant-input"
                        style={{ width: 180 }}
                        placeholder="Escanea aquí…"
                        autoFocus={i === 0}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          asignar(p, e.currentTarget.value);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
