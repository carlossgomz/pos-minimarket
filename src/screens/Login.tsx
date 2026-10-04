import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getDb } from "../db";
import { hashPassword } from "../auth";
import { ConfigRow, Usuario } from "../types";
import { limpiarNotas } from "./Novedades";
import KaxMascota from "../KaxMascota";

export default function Login({ config, onLogin }: { config: ConfigRow; onLogin: (u: Usuario) => void }) {
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  // Decoración de la pantalla de inicio de sesión: versión instalada +
  // notas del último release que se instaló, a diferencia de la
  // "Novedades" de App.tsx (esa aparece UNA sola vez, después de entrar,
  // justo tras actualizar) — esto se ve siempre acá, como referencia de
  // qué trae la versión actual.
  const [version, setVersion] = useState<string | null>(null);
  const [notasVersion, setNotasVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelado = false;
    getVersion()
      .then(async (v) => {
        if (cancelado) return;
        setVersion(v);
        try {
          const resp = await fetch(`https://api.github.com/repos/carlossgomz/pos-minimarket/releases/tags/v${v}`);
          if (!resp.ok || cancelado) return;
          const data = await resp.json();
          setNotasVersion(limpiarNotas(data.body ?? ""));
        } catch {
          // sin red — la tarjeta de novedades simplemente no aparece
        }
      })
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, []);

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
    <div className="login-page">
      <div className="login-tarjetas">
        <div className="card login-card">
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

        <div className="card login-novedades">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <KaxMascota pose="neutral" size={44} />
            <div>
              <strong>Kaxa</strong>
              {version && (
                <p className="hint" style={{ margin: 0 }}>
                  versión {version}
                </p>
              )}
            </div>
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.5 }}>
            Kaxa es el sistema de punto de venta que lleva tu inventario, tus ventas, tus cuentas por cobrar y
            pagar, y tus reportes — todo en un solo lugar, con Kax, tu asistente, avisándote lo importante sin
            que tengas que ir a buscarlo.
          </p>
          {notasVersion && (
            <>
              <p className="hint" style={{ margin: "12px 0 4px" }}>Novedades de esta versión:</p>
              <p style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>{notasVersion}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
