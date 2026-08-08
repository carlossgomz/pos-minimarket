import { useEffect, useState } from "react";
import { getDb } from "../db";
import { Rol, Usuario, Vendedor } from "../types";
import { hashPassword } from "../auth";

export default function Usuarios({ usuarioActual }: { usuarioActual: Usuario }) {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [nombre, setNombre] = useState("");
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [rol, setRol] = useState<Rol>("CAJERO");
  const [mensaje, setMensaje] = useState<string | null>(null);

  const [vendedores, setVendedores] = useState<Vendedor[]>([]);
  const [nombreVendedor, setNombreVendedor] = useState("");

  const [deliveryApiUrl, setDeliveryApiUrl] = useState("");
  const [deliverySyncToken, setDeliverySyncToken] = useState("");
  const [deliverySyncAutomatico, setDeliverySyncAutomatico] = useState(true);
  const [mensajeDelivery, setMensajeDelivery] = useState<string | null>(null);

  async function cargarConfigDelivery() {
    const db = await getDb();
    const rows = await db.select<
      { delivery_api_url: string | null; delivery_sync_token: string | null; delivery_sync_automatico: number }[]
    >("SELECT delivery_api_url, delivery_sync_token, delivery_sync_automatico FROM config WHERE id = 1");
    setDeliveryApiUrl(rows[0]?.delivery_api_url ?? "");
    setDeliverySyncToken(rows[0]?.delivery_sync_token ?? "");
    setDeliverySyncAutomatico((rows[0]?.delivery_sync_automatico ?? 1) !== 0);
  }

  async function cargar() {
    const db = await getDb();
    const rows = await db.select<Usuario[]>(
      "SELECT id, nombre, usuario, rol, activo FROM usuarios ORDER BY nombre"
    );
    setUsuarios(rows);
  }

  async function cargarVendedores() {
    const db = await getDb();
    const rows = await db.select<Vendedor[]>("SELECT id, nombre, activo FROM vendedores ORDER BY nombre");
    setVendedores(rows);
  }

  useEffect(() => {
    cargar();
    cargarVendedores();
    cargarConfigDelivery();
  }, []);

  async function guardarConfigDelivery(e: React.FormEvent) {
    e.preventDefault();
    setMensajeDelivery(null);
    const db = await getDb();
    await db.execute(
      "UPDATE config SET delivery_api_url = $1, delivery_sync_token = $2, delivery_sync_automatico = $3 WHERE id = 1",
      [deliveryApiUrl.trim() || null, deliverySyncToken.trim() || null, deliverySyncAutomatico ? 1 : 0]
    );
    setMensajeDelivery("Guardado.");
  }

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

  async function eliminarUsuario(u: Usuario) {
    setMensaje(null);
    if (u.id === usuarioActual.id) {
      setMensaje("No puedes eliminar tu propio usuario mientras tienes la sesión abierta.");
      return;
    }
    if (u.rol === "ADMIN" && usuarios.filter((x) => x.rol === "ADMIN" && x.activo).length <= 1) {
      setMensaje("No puedes eliminar el único administrador activo.");
      return;
    }
    if (!window.confirm(`¿Eliminar el usuario "${u.nombre}" (${u.usuario})? No se puede deshacer.`)) return;
    const db = await getDb();
    await db.execute("DELETE FROM usuarios WHERE id = $1", [u.id]);
    await cargar();
  }

  async function crearVendedor(e: React.FormEvent) {
    e.preventDefault();
    if (!nombreVendedor.trim()) return;
    const db = await getDb();
    await db.execute("INSERT INTO vendedores (id, nombre) VALUES ($1,$2)", [
      crypto.randomUUID(),
      nombreVendedor.trim(),
    ]);
    setNombreVendedor("");
    await cargarVendedores();
  }

  async function toggleActivoVendedor(v: Vendedor) {
    if (v.activo && !window.confirm(`¿Eliminar al vendedor "${v.nombre}"? Deja de aparecer para elegir en Venta, pero las ventas ya hechas conservan su nombre.`)) {
      return;
    }
    const db = await getDb();
    await db.execute("UPDATE vendedores SET activo = $1 WHERE id = $2", [v.activo ? 0 : 1, v.id]);
    await cargarVendedores();
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
                  </button>{" "}
                  <button className="link-btn link-btn-danger" onClick={() => eliminarUsuario(u)}>
                    eliminar
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

      <section className="card">
        <h2>Vendedores</h2>
        <p className="hint">
          Son los nombres que aparecen para elegir "Vendedor" arriba en Venta — no tienen usuario
          ni contraseña propia, solo sirven para atribuir cada venta a quien atendió.
        </p>
        <form className="form-row" onSubmit={crearVendedor}>
          <input
            placeholder="Nombre del vendedor"
            value={nombreVendedor}
            onChange={(e) => setNombreVendedor(e.target.value)}
          />
          <button type="submit">Agregar</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vendedores.map((v) => (
              <tr key={v.id}>
                <td>{v.nombre}</td>
                <td>
                  <span className={`badge ${v.activo ? "badge-ok" : "badge-agotado"}`}>
                    {v.activo ? "Activo" : "Inactivo"}
                  </span>
                </td>
                <td>
                  <button
                    className={`link-btn ${v.activo ? "link-btn-danger" : ""}`}
                    onClick={() => toggleActivoVendedor(v)}
                  >
                    {v.activo ? "eliminar" : "reactivar"}
                  </button>
                </td>
              </tr>
            ))}
            {vendedores.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  Sin vendedores.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>App de delivery</h2>
        <p className="hint">
          Conecta este POS con la app de delivery (Next.js aparte) — con esto configurado, el
          catálogo se sincroniza solo cada pocos minutos, aparece el aviso de pedidos pendientes
          en el encabezado, y los pedidos entregados se registran solos como venta acá, con
          etiqueta "Delivery". La URL y el token deben coincidir con la variable{" "}
          <code>POS_SYNC_TOKEN</code> configurada del lado de la delivery-app.
        </p>
        <form className="form-row" onSubmit={guardarConfigDelivery}>
          <input
            placeholder="https://tu-delivery-app.vercel.app"
            value={deliveryApiUrl}
            onChange={(e) => setDeliveryApiUrl(e.target.value)}
            style={{ flex: 2 }}
          />
          <input
            placeholder="Token compartido (POS_SYNC_TOKEN)"
            type="password"
            value={deliverySyncToken}
            onChange={(e) => setDeliverySyncToken(e.target.value)}
            style={{ flex: 2 }}
          />
          <button type="submit">Guardar</button>
        </form>
        <label className="form-row" style={{ alignItems: "center", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={deliverySyncAutomatico}
            onChange={(e) => setDeliverySyncAutomatico(e.target.checked)}
          />
          Sincronizar precios/stock con delivery automáticamente cada 5 min
        </label>
        <p className="hint" style={{ marginTop: 4 }}>
          Si lo desmarcas, el catálogo solo se actualiza en la delivery-app cuando toques
          "Sincronizar con delivery ahora" en Inventario — útil mientras estás ajustando precios a
          mano y no quieres que se empujen todavía. Recuerda guardar.
        </p>
        {mensajeDelivery && <p className="hint">{mensajeDelivery}</p>}
      </section>
    </div>
  );
}
