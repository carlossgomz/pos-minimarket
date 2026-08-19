import { useState } from "react";
import { getDb } from "../db";
import { hashPassword } from "../auth";
import { ConfigRow, Usuario } from "../types";

export default function Login({ config, onLogin }: { config: ConfigRow; onLogin: (u: Usuario) => void }) {
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!usuario.trim() || !password) {
      setError("Ingresa usuario y contraseña.");
      return;
    }
    setEntrando(true);
    try {
      const db = await getDb();
      const rows = await db.select<(Usuario & { password_hash: string })[]>(
        "SELECT id, nombre, usuario, rol, activo, password_hash FROM usuarios WHERE usuario = $1 AND activo = 1",
        [usuario.trim()]
      );
      const hash = await hashPassword(password);
      const fila = rows[0];
      if (!fila || fila.password_hash !== hash) {
        setError("Usuario o contraseña incorrectos.");
        setEntrando(false);
        return;
      }
      onLogin({ id: fila.id, nombre: fila.nombre, usuario: fila.usuario, rol: fila.rol, activo: fila.activo });
    } catch (err) {
      setError(`No se pudo iniciar sesión: ${String(err)}`);
      setEntrando(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 380, paddingTop: 100 }}>
      <div className="card">
        <h1 style={{ fontSize: 20, color: "var(--accent-text)", marginTop: 0 }}>{config.nombre_negocio}</h1>
        <p className="hint">Inicia sesión para continuar.</p>
        <form onSubmit={entrar}>
          <div className="campo" style={{ marginBottom: 12 }}>
            <label>Usuario</label>
            <input value={usuario} onChange={(e) => setUsuario(e.target.value)} autoFocus />
          </div>
          <div className="campo" style={{ marginBottom: 12 }}>
            <label>Contraseña</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="cobrar-btn" disabled={entrando} style={{ marginTop: 4 }}>
            {entrando ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
