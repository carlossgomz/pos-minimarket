import { useState } from "react";
import { RevisionFactura } from "../types";

// Ventana temporal (no una pestaña fija), igual que StockPendiente.tsx — se
// abre desde el aviso del encabezado (ver App.tsx). Solo la ve un admin:
// el cajero que pidió la revisión no tiene nada más que hacer acá, ya dejó
// su nota al enviarla desde Facturas.tsx.
export default function RevisionesFactura({
  items,
  onCerrar,
  onVerFactura,
  onResolver,
}: {
  items: RevisionFactura[];
  onCerrar: () => void;
  onVerFactura: (ventaId: string) => void;
  onResolver: (id: string) => Promise<void>;
}) {
  const [resolviendo, setResolviendo] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function resolver(item: RevisionFactura) {
    if (!confirm(`¿Ya revisaste la factura ${item.numero_ticket}? Esto cierra el caso y deja de avisar.`)) {
      return;
    }
    setResolviendo(item.id);
    setMensaje(null);
    try {
      await onResolver(item.id);
    } catch (e) {
      setMensaje(`No se pudo cerrar el caso: ${String(e)}`);
    } finally {
      setResolviendo(null);
    }
  }

  return (
    <div className="modal-fondo" onMouseDown={onCerrar}>
      <div className="modal-caja" style={{ maxWidth: 720 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Facturas por revisar</h2>
          <button type="button" className="link-btn" onClick={onCerrar}>
            cerrar
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Un cajero marcó estas facturas para que las revises. Revísalas y marca cada una como resuelta.
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
                  <th>Cliente</th>
                  <th>Nota</th>
                  <th>Enviada por</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.fecha_hora}</td>
                    <td>{item.numero_ticket}</td>
                    <td>{item.cliente_nombre ?? "Consumidor final"}</td>
                    <td>{item.nota}</td>
                    <td>{item.usuario}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => onVerFactura(item.venta_id)}>
                        ver factura
                      </button>{" "}
                      <button type="button" onClick={() => resolver(item)} disabled={resolviendo === item.id}>
                        {resolviendo === item.id ? "…" : "Marcar resuelta"}
                      </button>
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
