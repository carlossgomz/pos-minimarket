import { useState } from "react";
import { VentaItemStockPendiente } from "../types";
import { formatearStock } from "../precios";

// Ventana temporal (no una pestaña fija), igual que
// PendientesCodigoBarras.tsx — se abre desde el aviso del encabezado (ver
// App.tsx). Muestra ventas que se cobraron con más cantidad de un
// producto de la que había en stock (ver comandos::confirmar_venta_interna
// y la migración 0027_stock_insuficiente.sql).
//
// El cajero ve solo SUS PROPIAS ventas marcadas (App.tsx ya filtra `items`
// antes de pasarlos acá) y puede dejar una nota explicando qué pasó, pero
// no tiene forma de cerrar el caso — eso es a propósito, para que no lo
// pueda tapar él mismo. El admin ve TODAS (de cualquier cajero), lee la
// nota, y recién después de corregir el inventario real (a mano, o
// editando la venta desde Facturas) lo marca como resuelto acá.
export default function StockPendiente({
  items,
  esAdmin,
  onCerrar,
  onGuardarNota,
  onResolver,
}: {
  items: VentaItemStockPendiente[];
  esAdmin: boolean;
  onCerrar: () => void;
  onGuardarNota: (id: string, nota: string) => Promise<void>;
  onResolver: (id: string) => Promise<void>;
}) {
  const [notas, setNotas] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  function notaDe(item: VentaItemStockPendiente) {
    return notas[item.id] ?? item.nota_cajero ?? "";
  }

  async function guardarNota(item: VentaItemStockPendiente) {
    setGuardando(item.id);
    setMensaje(null);
    try {
      await onGuardarNota(item.id, notaDe(item).trim());
    } catch (e) {
      setMensaje(`No se pudo guardar la nota: ${String(e)}`);
    } finally {
      setGuardando(null);
    }
  }

  async function resolver(item: VentaItemStockPendiente) {
    if (!confirm(`¿Ya corregiste el inventario real de "${item.producto_nombre}"? Esto cierra el caso y deja de avisar.`)) {
      return;
    }
    setGuardando(item.id);
    setMensaje(null);
    try {
      await onResolver(item.id);
    } catch (e) {
      setMensaje(`No se pudo cerrar el caso: ${String(e)}`);
    } finally {
      setGuardando(null);
    }
  }

  return (
    <div className="modal-fondo" onMouseDown={onCerrar}>
      <div className="modal-caja" style={{ maxWidth: 720 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Ventas con stock por revisar</h2>
          <button type="button" className="link-btn" onClick={onCerrar}>
            cerrar
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          {esAdmin
            ? "Se cobraron con más cantidad de un producto de la que había en stock. Corrige el inventario real (a mano, o editando la venta desde Facturas) y después marcá cada una como resuelta."
            : "Se cobraron con más cantidad de un producto de la que había en stock. Contá acá qué pasó — un admin va a revisar y corregir el inventario."}
        </p>
        {mensaje && <p className="error">{mensaje}</p>}
        {items.length === 0 ? (
          <p className="empty">No queda ninguna por revisar ✅</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tabla-compacta">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Ticket</th>
                  {esAdmin && <th>Vendedor</th>}
                  <th>Producto</th>
                  <th>Vendió / Había</th>
                  <th>{esAdmin ? "Nota del cajero" : "Tu nota"}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.fecha_hora}</td>
                    <td>{item.numero_ticket}</td>
                    {esAdmin && <td>{item.vendedor_nombre ?? "—"}</td>}
                    <td>{item.producto_nombre}</td>
                    <td>
                      {formatearStock(item.cantidad_vendida)} / {formatearStock(item.stock_disponible_al_vender ?? 0)}
                    </td>
                    <td>
                      {esAdmin ? (
                        item.nota_cajero?.trim() || <span className="hint">(sin nota)</span>
                      ) : (
                        <textarea
                          className="cant-input"
                          style={{ width: 220, minHeight: 40 }}
                          placeholder="¿Qué pasó con este producto?"
                          value={notaDe(item)}
                          onChange={(e) => setNotas((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        />
                      )}
                    </td>
                    <td>
                      {esAdmin ? (
                        <button type="button" onClick={() => resolver(item)} disabled={guardando === item.id}>
                          {guardando === item.id ? "…" : "Marcar resuelto"}
                        </button>
                      ) : (
                        <button type="button" onClick={() => guardarNota(item)} disabled={guardando === item.id}>
                          {guardando === item.id ? "…" : "Guardar nota"}
                        </button>
                      )}
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
