import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Se muestra UNA sola vez por dispositivo, antes de cualquier otra cosa
// (incluso antes del login) — sin esto la app no tiene cómo hablar con la
// base de datos compartida. El admin configura el primer equipo (crea la
// base en Turso); los siguientes solo pegan la misma URL y token.
export default function ConfiguracionSync({ onListo }: { onListo: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!url.trim() || !token.trim()) {
      setError("Completa la URL y el token.");
      return;
    }
    setGuardando(true);
    try {
      await invoke("guardar_config_sync", { tursoUrl: url.trim(), tursoAuthToken: token.trim() });
      onListo();
    } catch (err) {
      setError(`No se pudo conectar con esos datos: ${String(err)}`);
      setGuardando(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 460, paddingTop: 80 }}>
      <div className="card">
        <h1 style={{ fontSize: 20, color: "#0f6e56", marginTop: 0 }}>Configurar este equipo</h1>
        <p className="hint">
          Primera vez que se abre la app en esta PC. Pega la URL y el token de la base de datos
          compartida (Turso) — los mismos que usan los demás equipos. Solo se pide una vez.
        </p>
        <form onSubmit={guardar}>
          <div className="campo" style={{ marginBottom: 12 }}>
            <label>URL de la base (libsql://...)</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          </div>
          <div className="campo" style={{ marginBottom: 12 }}>
            <label>Auth token</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="cobrar-btn" disabled={guardando} style={{ marginTop: 4 }}>
            {guardando ? "Conectando…" : "Conectar y continuar"}
          </button>
        </form>
      </div>
    </div>
  );
}
