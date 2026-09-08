// Campana de notificaciones del header — junta en un solo botón las
// alertas de "housekeeping" que antes eran botones sueltos (código de
// barras pendiente, stock bajo, actualización disponible). Los pedidos de
// delivery pendientes NO entran acá a propósito: es una alerta operativa
// urgente/accionable, no un aviso de mantenimiento — se queda como botón
// aparte en App.tsx.
import { useEffect, useRef, useState } from "react";

export type NotificacionItem = {
  key: string;
  texto: string;
  color?: string;
  disabled?: boolean;
  error?: string | null;
  onClick: () => void;
};

export default function Notificaciones({ items }: { items: NotificacionItem[] }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    function alHacerClicAfuera(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    }
    document.addEventListener("mousedown", alHacerClicAfuera);
    return () => document.removeEventListener("mousedown", alHacerClicAfuera);
  }, [abierto]);

  if (items.length === 0) return null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="link-btn" onClick={() => setAbierto((a) => !a)}>
        🔔 Notificaciones ({items.length})
      </button>
      {abierto && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            minWidth: 280,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            zIndex: 50,
            overflow: "hidden",
          }}
        >
          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              className="link-btn"
              disabled={it.disabled}
              onClick={() => {
                it.onClick();
                setAbierto(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 14px",
                color: it.color,
                borderBottom: i < items.length - 1 ? "1px solid var(--border-subtle)" : "none",
              }}
            >
              {it.texto}
              {it.error && (
                <div style={{ color: "var(--danger-text)", fontSize: 12, marginTop: 2 }}>{it.error}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
