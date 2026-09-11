// Ventana que aparece apenas hay una actualización disponible (a diferencia
// de Novedades, que aparece DESPUÉS de instalar una — ver App.tsx). No se
// puede cerrar haciendo clic afuera a propósito: hay que elegir una de las
// dos opciones.
import { limpiarNotas } from "./Novedades";

export default function ActualizacionDisponible({
  version,
  notas,
  instalando,
  progreso,
  error,
  onActualizar,
  onSaltar,
}: {
  version: string;
  notas: string;
  instalando: boolean;
  // Porcentaje de la descarga (0-100), o null si todavía no se sabe el
  // tamaño total del archivo — ver instalarActualizacion en App.tsx.
  progreso: number | null;
  error: string | null;
  onActualizar: () => void;
  onSaltar: () => void;
}) {
  const notasLimpias = limpiarNotas(notas);

  return (
    <div className="modal-fondo">
      <div className="modal-caja" style={{ maxWidth: 480 }}>
        <h2 style={{ margin: "0 0 12px" }}>⬆ Nueva actualización disponible: versión {version}</h2>
        {notasLimpias ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{notasLimpias}</p>
        ) : (
          <p className="hint">Sin detalle de los cambios de esta versión.</p>
        )}
        {instalando && (
          <div style={{ margin: "10px 0" }}>
            <div style={{ background: "var(--bg-input)", borderRadius: 6, overflow: "hidden", height: 10 }}>
              <div
                style={{
                  width: `${progreso ?? 0}%`,
                  background: "var(--accent, #3b82f6)",
                  height: "100%",
                  transition: "width 0.3s",
                }}
              />
            </div>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              {progreso !== null ? `Descargando… ${progreso}%` : "Descargando…"}
            </p>
          </div>
        )}
        {error && <p style={{ color: "var(--danger-text)" }}>{error}</p>}
        <div className="form-row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="link-btn" onClick={onSaltar} disabled={instalando}>
            Saltar versión
          </button>
          <button type="button" onClick={onActualizar} disabled={instalando}>
            {instalando ? "Instalando…" : error ? "Reintentar" : "Actualizar ahora"}
          </button>
        </div>
      </div>
    </div>
  );
}
