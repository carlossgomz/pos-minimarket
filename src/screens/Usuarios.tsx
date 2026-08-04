import { useEffect, useState } from "react";
import { getDb } from "../db";
import { Rol, Usuario } from "../types";
import { hashPassword } from "../auth";

export default function Usuarios() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [nombre, setNombre] = useState("");
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [rol, setRol] = useState<Rol>("CAJERO");
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function cargar() {
    const db = await getDb();
    const rows = await db.select<Usuario[]>(
      "SELECT id, nombre, usuario, rol, activo FROM usuarios ORDER BY nombre"
    );
    setUsuarios(rows);
  }

  useEffect(() => {
    cargar();
  }, []);

  async function crearUsuario(e: React.FormEvent) {
    e.preventDefault();
    setMensaje(null);
    if (!nombre.trim() || !usuario.trim() || !password) {
      setMensaje("Completa nombre, usuario y contraseña.");
      return;
    }
    if (password.length < 4) {
      setMensaje("La contraseña debe tener al menos 4 caracteres.");
      return;
    }
    const db = await getDb();
    const hash = await hashPassword(password);
    try {
      await db.execute(
        "INSERT INTO usuarios (id, nombre, usuario, password_hash, rol) VALUES ($1,$2,$3,$4,$5)",
        [crypto.randomUUID(), nombre.trim(), usuario.trim(), hash, rol]
      );
    } catch (err) {
      setMensaje(`No se pudo crear el usuario (¿nombre de usuario repetido?): ${String(err)}`);
      return;
    }
    setNombre("");
    setUsuario("");
    setPassword("");
    setRol("CAJERO");
    await cargar();
  }

  async function toggleActivo(u: Usuario) {
    const db = await getDb();
    await db.execute("UPDATE usuarios SET activo = $1 WHERE id = $2", [u.activo ? 0 : 1, u.id]);
    await cargar();
  }

  async function cambiarRol(u: Usuario, nuevoRol: Rol) {
    const db = await getDb();
    await db.execute("UPDATE usuarios SET rol = $1 WHERE id = $2", [nuevoRol, u.id]);
    await cargar();
  }

  async function resetearPassword(u: Usuario) {
    const nueva = prompt(`Nueva contraseña para ${u.nombre}:`);
    if (!nueva) return;
    if (nueva.length < 4) {
      alert("La contraseña debe tener al menos 4 caracteres.");
      return;
    }
    const db = await getDb();
    const hash = await hashPassword(nueva);
    await db.execute("UPDATE usuarios SET password_hash = $1 WHERE id = $2", [hash, u.id]);
    alert("Contraseña actualizada.");
  }

  return (
    <div>
      <section className="card">
        <h2>Nuevo usuario</h2>
        <p className="hint">
          Administrador ve todas las secciones. Cajero solo ve Venta, Facturas, Clientes y
          Cuentas.
        </p>
        <form className="form-row" onSubmit={crearUsuario}>
          <input placeholder="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <input placeholder="Usuario (para entrar)" value={usuario} onChange={(e) => setUsuario(e.target.value)} />
          <input
            placeholder="Contraseña"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
            <option value="CAJERO">Cajero</option>
            <option value="ADMIN">Administrador</option>
          </select>
          <button type="submit">Crear</button>
        </form>
        {mensaje && <p className="error">{mensaje}</p>}
      </section>

      <section className="card">
        <h2>Usuarios</h2>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((u) => (
              <tr key={u.id}>
                <td>{u.nombre}</td>
                <td>{u.usuario}</td>
                <td>
                  <select value={u.rol} onChange={(e) => cambiarRol(u, e.target.value as Rol)}>
                    <option value="CAJERO">Cajero</option>
                    <option value="ADMIN">Administrador</option>
                  </select>
                </td>
                <td>
                  <span className={`badge ${u.activo ? "badge-ok" : "badge-agotado"}`}>
                    {u.activo ? "Activo" : "Inactivo"}
                  </span>
                </td>
                <td>
                  <button
                    className={`link-btn ${u.activo ? "link-btn-danger" : ""}`}
                    onClick={() => toggleActivo(u)}
                  >
                    {u.activo ? "desactivar" : "activar"}
                  </button>{" "}
                  <button className="link-btn" onClick={() => resetearPassword(u)}>
                    cambiar contraseña
                  </button>
                </td>
              </tr>
            ))}
            {usuarios.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Sin usuarios.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
