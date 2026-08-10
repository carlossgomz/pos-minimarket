import { useEffect, useState } from "react";
import { getDb } from "../db";
import { Cliente, VentaResumen } from "../types";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";

export default function Clientes() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [seleccionado, setSeleccionado] = useState<Cliente | null>(null);
  const [saldoPendienteUsd, setSaldoPendienteUsd] = useState(0);
  const [historial, setHistorial] = useState<VentaResumen[]>([]);

  const [nombre, setNombre] = useState("");
  const [cedula, setCedula] = useState("");
  const [telefono, setTelefono] = useState("");
  const [direccion, setDireccion] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [mensajeFicha, setMensajeFicha] = useState<string | null>(null);

  async function cargarClientes() {
    const db = await getDb();
    const term = busqueda.trim();
    const rows = term
      ? await db.select<Cliente[]>(
          `SELECT * FROM clientes WHERE ${sqlSinAcentos("nombre")} LIKE $1 OR cedula LIKE $2 ORDER BY nombre`,
          [`%${normalizarTexto(term)}%`, `%${term}%`]
        )
      : await db.select<Cliente[]>("SELECT * FROM clientes ORDER BY nombre");
    setClientes(rows);
  }

  // Debounce — evita una consulta por cada letra tecleada.
  useEffect(() => {
    const timer = setTimeout(cargarClientes, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);

  async function abrirFicha(c: Cliente) {
    setSeleccionado(c);
    setMensaje(null);
    setMensajeFicha(null);
    const db = await getDb();
    const saldo = await db.select<{ total: number }[]>(
      "SELECT COALESCE(SUM(monto_pendiente_usd), 0) as total FROM ventas WHERE cliente_cedula = $1 AND estado = 'CREDITO_PENDIENTE'",
      [c.cedula]
    );
    setSaldoPendienteUsd(saldo[0]?.total ?? 0);
    const rows = await db.select<VentaResumen[]>(
      "SELECT id, numero_ticket, fecha_hora, total_bs, estado FROM ventas WHERE cliente_cedula = $1 ORDER BY fecha_hora DESC LIMIT 50",
      [c.cedula]
    );
    setHistorial(rows);
  }

  async function guardarCliente(e: React.FormEvent) {
    e.preventDefault();
    setMensaje(null);
    if (!nombre || !cedula) {
      setMensaje("Nombre y cédula son obligatorios.");
      return;
    }
    const db = await getDb();
    try {
      await db.execute(
        "INSERT INTO clientes (id, nombre, cedula, telefono, direccion) VALUES ($1,$2,$3,$4,$5)",
        [crypto.randomUUID(), nombre, cedula, telefono || null, direccion || null]
      );
    } catch (e) {
      setMensaje(`No se pudo crear el cliente (¿cédula repetida?): ${String(e)}`);
      return;
    }
    setNombre("");
    setCedula("");
    setTelefono("");
    setDireccion("");
    await cargarClientes();
  }

  async function toggleCredito(c: Cliente) {
    const db = await getDb();
    const nuevo = c.credito_autorizado ? 0 : 1;
    await db.execute("UPDATE clientes SET credito_autorizado = $1 WHERE id = $2", [nuevo, c.id]);
    await cargarClientes();
    if (seleccionado?.id === c.id) setSeleccionado({ ...c, credito_autorizado: nuevo });
  }

  async function actualizarDireccion(c: Cliente, nuevaDireccion: string) {
    const valor = nuevaDireccion.trim();
    if (valor === (c.direccion ?? "")) return;
    const db = await getDb();
    await db.execute("UPDATE clientes SET direccion = $1 WHERE id = $2", [valor || null, c.id]);
    setSeleccionado({ ...c, direccion: valor || null });
    await cargarClientes();
  }

  async function actualizarNombre(c: Cliente, nuevoNombre: string) {
    const valor = nuevoNombre.trim();
    if (!valor || valor === c.nombre) return;
    const db = await getDb();
    await db.execute("UPDATE clientes SET nombre = $1 WHERE id = $2", [valor, c.id]);
    setSeleccionado({ ...c, nombre: valor });
    await cargarClientes();
  }

  async function actualizarTelefono(c: Cliente, nuevoTelefono: string) {
    const valor = nuevoTelefono.trim();
    if (valor === (c.telefono ?? "")) return;
    const db = await getDb();
    await db.execute("UPDATE clientes SET telefono = $1 WHERE id = $2", [valor || null, c.id]);
    setSeleccionado({ ...c, telefono: valor || null });
    await cargarClientes();
  }

  // La cédula es la clave con la que se buscan las compras de un cliente
  // (ventas.cliente_cedula es una "foto" del momento, no una referencia
  // viva) — así que al corregirla también hay que actualizar sus ventas ya
  // registradas, o se perdería el historial de este cliente. El nombre y
  // el teléfono NO se propagan a ventas viejas a propósito: esas quedan
  // como estaban en el momento de cada compra.
  async function actualizarCedula(c: Cliente, nuevaCedula: string) {
    const valor = nuevaCedula.trim();
    if (!valor || valor === c.cedula) return;
    const db = await getDb();
    try {
      await db.execute("UPDATE clientes SET cedula = $1 WHERE id = $2", [valor, c.id]);
    } catch (e) {
      setMensajeFicha(`No se pudo cambiar la cédula (¿ya hay otro cliente con esa cédula?): ${String(e)}`);
      return;
    }
    await db.execute("UPDATE ventas SET cliente_cedula = $1 WHERE cliente_cedula = $2", [valor, c.cedula]);
    setMensajeFicha(null);
    const actualizado = { ...c, cedula: valor };
    await cargarClientes();
    await abrirFicha(actualizado);
  }

  return (
    <div className="venta-layout">
      <div className="card">
        <h2>Nuevo cliente</h2>
        <form className="form-row" onSubmit={guardarCliente}>
          <input placeholder="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
          <input placeholder="Cédula" value={cedula} onChange={(e) => setCedula(e.target.value)} required />
          <input placeholder="Teléfono (opcional)" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
          <input placeholder="Dirección (opcional)" value={direccion} onChange={(e) => setDireccion(e.target.value)} />
          <button type="submit">Guardar</button>
        </form>
        {mensaje && <p className="error">{mensaje}</p>}

        <h2>Clientes</h2>
        <input
          placeholder="Buscar por nombre o cédula"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          style={{ marginBottom: 10, width: "100%", padding: "8px 10px", border: "1px solid #b4b2a9", borderRadius: 6 }}
        />
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Cédula</th>
              <th>Crédito</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => (
              <tr key={c.id}>
                <td>{c.nombre}</td>
                <td>{c.cedula}</td>
                <td>{c.credito_autorizado ? "Autorizado" : "No"}</td>
                <td>{c.cliente_app_id && <span className="badge badge-ok">📱 App</span>}</td>
                <td>
                  <button className="link-btn" onClick={() => abrirFicha(c)}>
                    ver ficha
                  </button>
                </td>
              </tr>
            ))}
            {clientes.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Sin clientes todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        {!seleccionado ? (
          <p className="hint">Selecciona un cliente para ver su ficha.</p>
        ) : (
          <>
            <h2>
              {seleccionado.nombre} {seleccionado.cliente_app_id && <span className="badge badge-ok">📱 App</span>}
            </h2>
            {mensajeFicha && <p className="error">{mensajeFicha}</p>}
            <div className="form-row" style={{ alignItems: "center" }}>
              <label style={{ alignSelf: "center" }}>Nombre</label>
              <input
                key={`nombre-${seleccionado.id}`}
                defaultValue={seleccionado.nombre}
                onBlur={(e) => actualizarNombre(seleccionado, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <div className="form-row" style={{ alignItems: "center" }}>
              <label style={{ alignSelf: "center" }}>Cédula</label>
              <input
                key={`cedula-${seleccionado.id}`}
                defaultValue={seleccionado.cedula}
                onBlur={(e) => actualizarCedula(seleccionado, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <div className="form-row" style={{ alignItems: "center" }}>
              <label style={{ alignSelf: "center" }}>Teléfono</label>
              <input
                key={`telefono-${seleccionado.id}`}
                placeholder="Sin teléfono registrado"
                defaultValue={seleccionado.telefono ?? ""}
                onBlur={(e) => actualizarTelefono(seleccionado, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <div className="form-row" style={{ alignItems: "center" }}>
              <label style={{ alignSelf: "center" }}>Dirección</label>
              <input
                key={`direccion-${seleccionado.id}`}
                placeholder="Sin dirección registrada"
                defaultValue={seleccionado.direccion ?? ""}
                onBlur={(e) => actualizarDireccion(seleccionado, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <div className="form-row">
              <label>
                <input
                  type="checkbox"
                  checked={!!seleccionado.credito_autorizado}
                  onChange={() => toggleCredito(seleccionado)}
                />{" "}
                Crédito autorizado
              </label>
            </div>

            <div className="totales">
              <strong className={saldoPendienteUsd > 0 ? "restante-pendiente" : ""}>
                Saldo pendiente: USD {saldoPendienteUsd.toFixed(2)}
              </strong>
            </div>

            <h2>Historial de compras</h2>
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Fecha</th>
                  <th>Total Bs</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((v) => (
                  <tr key={v.id}>
                    <td>{v.numero_ticket}</td>
                    <td>{new Date(v.fecha_hora).toLocaleDateString("es-VE")}</td>
                    <td>{v.total_bs.toFixed(2)}</td>
                    <td>{v.estado}</td>
                  </tr>
                ))}
                {historial.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      Sin compras registradas todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
