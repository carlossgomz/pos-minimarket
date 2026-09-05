// Ventanita de "qué hay de nuevo" — aparece UNA sola vez, justo en el
// primer arranque después de instalar una actualización (ver
// instalarActualizacion en App.tsx, que guarda esto en localStorage antes
// de reiniciar). El contenido sale de las notas del release en GitHub,
// generadas solas a partir de los commits (ver .github/workflows/release.yml).

// GitHub arma las notas como "## What's Changed", una lista de commits
// ("* mensaje del commit by @usuario in #123") y un link de comparación al
// final — acá se limpia lo que no aporta nada dentro de la app (el
// encabezado ya está en el título de esta ventana, el link no sirve sin
// navegador, y "by @usuario in #123" siempre es Carlos mismo).
export function limpiarNotas(body: string): string {
  return body
    .split("\n")
    .filter((linea) => !linea.startsWith("## What's Changed") && !linea.startsWith("**Full Changelog**"))
    .join("\n")
    .replace(/ by @\S+ in #\d+/g, "")
    .replace(/^\* /gm, "• ")
    .trim();
}

export default function Novedades({
  novedades,
  onCerrar,
}: {
  novedades: { version: string; body: string };
  onCerrar: () => void;
}) {
  const notas = limpiarNotas(novedades.body);

  return (
    <div className="modal-fondo" onMouseDown={onCerrar}>
      <div className="modal-caja" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>🎉 Se actualizó a la versión {novedades.version}</h2>
          <button type="button" className="link-btn" onClick={onCerrar}>
            cerrar
          </button>
        </div>
        {notas ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{notas}</p>
        ) : (
          <p className="hint">Sin detalle de los cambios de esta versión.</p>
        )}
        <button type="button" onClick={onCerrar} style={{ marginTop: 8 }}>
          Entendido
        </button>
      </div>
    </div>
  );
}
