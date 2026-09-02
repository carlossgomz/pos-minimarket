import { useEffect, useRef, useState } from "react";
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
  const [editando, setEditando] = useState<Proveedor | null>(null);

  // Scroll automático a la ficha/formulario correspondiente al elegir
  // "ver ficha" o "editar" en la lista — mismo patrón que el abono en
  // Cuentas.tsx.
  const formularioRef = useRef<HTMLDivElement>(null);
  const fichaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editando) formularioRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [editando]);
  useEffect(() => {
    if (seleccionado) fichaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [seleccionado]);

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

  function editarProveedor(p: Proveedor) {
    setEditando(p);
    setMensaje(null);
    setNombre(p.nombre);
    setRif(p.rif);
    setDireccion(p.direccion ?? "");
    setTelefono(p.telefono ?? "");
  }

  function cancelarEdicion() {
    setEditando(null);
    setNombre("");
    setRif("");
    setDireccion("");
    setTelefono("");
    setMensaje(null);
  }

  async function eliminarProveedor(p: Proveedor) {
    setMensaje(null);
    if (!window.confirm(`¿Eliminar a "${p.nombre}" del todo? No se puede deshacer.`)) return;
    const db = await getDb();
    await db.execute("DELETE FROM proveedores WHERE id = $1", [p.id]);
    if (seleccionado?.id === p.id) setSeleccionado(null);
    if (editando?.id === p.id) cancelarEdicion();
    await cargarProveedores();
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
      "SELECT id, numero_factura, fecha, moneda, monto_total_usd, monto_pagado_usd, tasa_cambio_dia, estado FROM facturas_compra WHERE proveedor_id = $1 ORDER BY fecha DESC LIMIT 50",
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
      if (editando) {
        await db.execute("UPDATE proveedores SET nombre = $1, rif = $2, direccion = $3, telefono = $4 WHERE id = $5", [
          nombre,
          rif,
          direccion || null,
          telefono || null,
          editando.id,
        ]);
        if (seleccionado?.id === editando.id) {
          setSeleccionado({ ...seleccionado, nombre, rif, direccion: direccion || null, telefono: telefono || null });
        }
      } else {
        await db.execute(
          "INSERT INTO proveedores (id, nombre, rif, direccion, telefono) VALUES ($1,$2,$3,$4,$5)",
          [crypto.randomUUID(), nombre, rif, direccion || null, telefono || null]
        );
      }
    } catch (e) {
      setMensaje(`No se pudo guardar el proveedor (¿RIF repetido?): ${String(e)}`);
      return;
    }
    cancelarEdicion();
    await cargarProveedores();
  }

  return (
    <div className="venta-layout">
      <div className="card" ref={formularioRef}>
        <h2>{editando ? `Editar proveedor` : "Nuevo proveedor"}</h2>
        <form className="form-row" onSubmit={guardarProveedor}>
          <input placeholder="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
          <input placeholder="RIF" value={rif} onChange={(e) => setRif(e.target.value)} required />
          <input placeholder="Dirección (opcional)" value={direccion} onChange={(e) => setDireccion(e.target.value)} />
          <input placeholder="Teléfono (opcional)" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
          <button type="submit">{editando ? "Guardar cambios" : "Guardar"}</button>
          {editando && (
            <button type="button" className="link-btn" onClick={cancelarEdicion}>
              cancelar
            </button>
          )}
        </form>
        {mensaje && <p className="error">{mensaje}</p>}

        <h2>Proveedores</h2>
        <input
          placeholder="Buscar por nombre o RIF"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          style={{ marginBottom: 10, width: "100%", padding: "8px 10px", border: "1px solid var(--border-input)", borderRadius: 6 }}
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
                  </button>{" "}
                  <button className="link-btn" onClick={() => editarProveedor(p)}>
                    editar
                  </button>{" "}
                  <button className="link-btn link-btn-danger" onClick={() => eliminarProveedor(p)}>
                    eliminar
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

      <div className="card" ref={fichaRef}>
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
                  <th>Total Bs</th>
                  <th>Pagado USD</th>
                  <th>Pagado Bs</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((f) => (
                  <tr key={f.id}>
                    <td>{f.numero_factura}</td>
                    <td>{new Date(f.fecha).toLocaleDateString("es-VE")}</td>
                    <td>{f.monto_total_usd.toFixed(2)}</td>
                    <td>{(f.monto_total_usd * f.tasa_cambio_dia).toFixed(2)}</td>
                    <td>{f.monto_pagado_usd.toFixed(2)}</td>
                    <td>{(f.monto_pagado_usd * f.tasa_cambio_dia).toFixed(2)}</td>
                    <td>{f.estado}</td>
                  </tr>
                ))}
                {historial.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
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
