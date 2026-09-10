// Ventana que aparece apenas hay una actualización disponible (a diferencia
// de Novedades, que aparece DESPUÉS de instalar una — ver App.tsx). No se
// puede cerrar haciendo clic afuera a propósito: hay que elegir una de las
// dos opciones.
import { limpiarNotas } from "./Novedades";

export default function ActualizacionDisponible({
  version,
  notas,
  instalando,
  error,
  onActualizar,
  onSaltar,
}: {
  version: string;
  notas: string;
  instalando: boolean;
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
