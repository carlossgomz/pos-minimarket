import { useEffect, useState } from "react";
import { getDb } from "../db";
import { FacturaResumen, Proveedor } from "../types";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";

export default function Proveedores() {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [seleccionado, setSeleccionado] = useState<Proveedor | null>(null);
  const [saldoPendienteUsd, setSaldoPendienteUsd] = useState(0);
  const [historial, setHistorial] = useState<FacturaResumen[]>([]);

  const [nombre, setNombre] = useState("");
  const [rif, setRif] = useState("");
  const [direccion, setDireccion] = useState("");
  const [telefono, setTelefono] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function cargarProveedores() {
    const db = await getDb();
    const term = busqueda.trim();
    const rows = term
      ? await db.select<Proveedor[]>(
          `SELECT * FROM proveedores WHERE ${sqlSinAcentos("nombre")} LIKE $1 OR rif LIKE $2 ORDER BY nombre`,
          [`%${normalizarTexto(term)}%`, `%${term}%`]
        )
      : await db.select<Proveedor[]>("SELECT * FROM proveedores ORDER BY nombre");
    setProveedores(rows);
  }

  // Debounce — evita una consulta por cada letra tecleada.
  useEffect(() => {
    const timer = setTimeout(cargarProveedores, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);

  async function abrirFicha(p: Proveedor) {
    setSeleccionado(p);
    setMensaje(null);
    const db = await getDb();
    const saldo = await db.select<{ total: number }[]>(
      "SELECT COALESCE(SUM(monto_total_usd - monto_pagado_usd), 0) as total FROM facturas_compra WHERE proveedor_id = $1 AND estado != 'PAGADA'",
      [p.id]
    );
    setSaldoPendienteUsd(saldo[0]?.total ?? 0);
    const rows = await db.select<FacturaResumen[]>(
      "SELECT id, numero_factura, fecha, moneda, monto_total_usd, monto_pagado_usd, estado FROM facturas_compra WHERE proveedor_id = $1 ORDER BY fecha DESC LIMIT 50",
      [p.id]
    );
    setHistorial(rows);
  }

  async function guardarProveedor(e: React.FormEvent) {
    e.preventDefault();
    setMensaje(null);
    if (!nombre || !rif) {
      setMensaje("Nombre y RIF son obligatorios.");
      return;
    }
    const db = await getDb();
    try {
      await db.execute(
        "INSERT INTO proveedores (id, nombre, rif, direccion, telefono) VALUES ($1,$2,$3,$4,$5)",
        [crypto.randomUUID(), nombre, rif, direccion || null, telefono || null]
      );
    } catch (e) {
      setMensaje(`No se pudo crear el proveedor (¿RIF repetido?): ${String(e)}`);
      return;
    }
    setNombre("");
    setRif("");
    setDireccion("");
    setTelefono("");
    await cargarProveedores();
  }

  return (
    <div className="venta-layout">
      <div className="card">
        <h2>Nuevo proveedor</h2>
        <form className="form-row" onSubmit={guardarProveedor}>
          <input placeholder="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
          <input placeholder="RIF" value={rif} onChange={(e) => setRif(e.target.value)} required />
          <input placeholder="Dirección (opcional)" value={direccion} onChange={(e) => setDireccion(e.target.value)} />
          <input placeholder="Teléfono (opcional)" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
          <button type="submit">Guardar</button>
        </form>
        {mensaje && <p className="error">{mensaje}</p>}

        <h2>Proveedores</h2>
        <input
          placeholder="Buscar por nombre o RIF"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          style={{ marginBottom: 10, width: "100%", padding: "8px 10px", border: "1px solid #b4b2a9", borderRadius: 6 }}
        />
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>RIF</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {proveedores.map((p) => (
              <tr key={p.id}>
                <td>{p.nombre}</td>
                <td>{p.rif}</td>
                <td>
                  <button className="link-btn" onClick={() => abrirFicha(p)}>
                    ver ficha
                  </button>
                </td>
              </tr>
            ))}
            {proveedores.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  Sin proveedores todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        {!seleccionado ? (
          <p className="hint">Selecciona un proveedor para ver su ficha.</p>
        ) : (
          <>
            <h2>{seleccionado.nombre}</h2>
            <p className="hint">
              RIF: {seleccionado.rif}
              {seleccionado.direccion ? ` · ${seleccionado.direccion}` : ""}
              {seleccionado.telefono ? ` · Tel: ${seleccionado.telefono}` : ""}
            </p>

            <div className="totales">
              <strong className={saldoPendienteUsd > 0 ? "restante-pendiente" : ""}>
                Saldo pendiente: USD {saldoPendienteUsd.toFixed(2)}
              </strong>
            </div>

            <h2>Historial de facturas</h2>
            <table>
              <thead>
                <tr>
                  <th>Factura</th>
                  <th>Fecha</th>
                  <th>Total USD</th>
                  <th>Pagado USD</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((f) => (
                  <tr key={f.id}>
                    <td>{f.numero_factura}</td>
                    <td>{new Date(f.fecha).toLocaleDateString("es-VE")}</td>
                    <td>{f.monto_total_usd.toFixed(2)}</td>
                    <td>{f.monto_pagado_usd.toFixed(2)}</td>
                    <td>{f.estado}</td>
                  </tr>
                ))}
                {historial.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      Sin facturas registradas todavía.
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
