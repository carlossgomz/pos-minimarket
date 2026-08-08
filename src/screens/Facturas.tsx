import { useEffect, useState } from "react";
import { getDb } from "../db";
import {
  ConfigRow,
  FacturaVentaCompleta,
  FacturaVentaItemDetalle,
  FacturaVentaItemEditable,
  FacturaVentaPagoDetalle,
  FacturaVentaResumen,
  METODOS_PAGO,
} from "../types";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";
import { fechaHoraVenezuela } from "../fecha";
import logo from "../assets/logo.png";
import EditorItemsVenta from "./EditorItemsVenta";

function hoyISO() {
  return fechaHoraVenezuela().slice(0, 10);
}

function haceNDias(n: number) {
  const d = new Date(`${hoyISO()}T00:00:00`);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Facturas({ config, esAdmin }: { config: ConfigRow; esAdmin: boolean }) {
  const [desde, setDesde] = useState(haceNDias(30));
  const [hasta, setHasta] = useState(hoyISO());
  const [busqueda, setBusqueda] = useState("");
  const [metodoFiltro, setMetodoFiltro] = useState("");
  const [facturas, setFacturas] = useState<FacturaVentaResumen[]>([]);

  const [seleccionada, setSeleccionada] = useState<FacturaVentaCompleta | null>(null);
  const [items, setItems] = useState<FacturaVentaItemDetalle[]>([]);
  const [itemsEditables, setItemsEditables] = useState<FacturaVentaItemEditable[]>([]);
  const [pagos, setPagos] = useState<FacturaVentaPagoDetalle[]>([]);
  const [editandoItems, setEditandoItems] = useState(false);

  async function cargarLista() {
    const db = await getDb();
    const termCrudo = busqueda.trim();
    const term = termCrudo ? `%${termCrudo}%` : "%";
    const termSinAcentos = termCrudo ? `%${normalizarTexto(termCrudo)}%` : "%";
    const filtroMetodo = metodoFiltro
      ? "AND id IN (SELECT venta_id FROM pagos WHERE metodo = $5)"
      : "";
    const params: (string | number)[] = [desde, hasta, term, termSinAcentos];
    if (metodoFiltro) params.push(metodoFiltro);
    const rows = await db.select<FacturaVentaResumen[]>(
      `SELECT id, numero_ticket, fecha_hora, cliente_nombre, cliente_cedula, vendedor_nombre, total_bs, estado, canal
       FROM ventas
       WHERE date(fecha_hora) BETWEEN $1 AND $2
         AND (numero_ticket LIKE $3 OR ${sqlSinAcentos("cliente_nombre")} LIKE $4 OR cliente_cedula LIKE $3)
         ${filtroMetodo}
       ORDER BY fecha_hora DESC
       LIMIT 200`,
      params
    );
    setFacturas(rows);
  }

  // Debounce — evita una consulta por cada letra tecleada en la búsqueda.
  useEffect(() => {
    const timer = setTimeout(cargarLista, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desde, hasta, busqueda, metodoFiltro]);

  async function abrirFactura(id: string) {
    const db = await getDb();
    const completa = await db.select<FacturaVentaCompleta[]>(
      `SELECT id, numero_ticket, fecha_hora, cliente_nombre, cliente_cedula, cliente_direccion, vendedor_nombre,
              tasa_cambio_dia, subtotal_bs, iva_bs, total_bs, estado, monto_pendiente_usd
       FROM ventas WHERE id = $1`,
      [id]
    );
    setSeleccionada(completa[0] ?? null);
    setEditandoItems(false);

    const itemRows = await db.select<FacturaVentaItemDetalle[]>(
      `SELECT p.nombre as producto_nombre, vi.cantidad, vi.precio_unit_bs, vi.subtotal_bs
       FROM venta_items vi JOIN productos p ON p.id = vi.producto_id
       WHERE vi.venta_id = $1`,
      [id]
    );
    setItems(itemRows);

    const itemsEditablesRows = await db.select<FacturaVentaItemEditable[]>(
      `SELECT vi.producto_id, p.nombre as producto_nombre, vi.cantidad, vi.precio_unit_bs
       FROM venta_items vi JOIN productos p ON p.id = vi.producto_id
       WHERE vi.venta_id = $1`,
      [id]
    );
    setItemsEditables(itemsEditablesRows);

    const pagoRows = await db.select<FacturaVentaPagoDetalle[]>(
      "SELECT id, metodo, monto_bs, referencia, verificado_admin FROM pagos WHERE venta_id = $1",
      [id]
    );
    setPagos(pagoRows);
  }

  // Corrige el método de pago (y la referencia) de una venta ya
  // registrada — el caso típico es la caja que por un clic apurado marcó
  // "punto de venta" cuando en realidad fue biopago. El monto no se toca
  // acá: si hace falta cambiar montos, es una venta distinta, no un typo.
  // Solo admin (ver el filtro esAdmin en el render).
  async function actualizarPago(pagoId: string, metodo: string, referencia: string) {
    const db = await getDb();
    await db.execute("UPDATE pagos SET metodo = $1, referencia = $2 WHERE id = $3", [
      metodo,
      referencia.trim() || null,
      pagoId,
    ]);
    if (seleccionada) await abrirFactura(seleccionada.id);
  }

  // Check de "el admin confirmó que este pago móvil sí llegó" — solo
  // aplica a pagos con metodo PAGO_MOVIL, para el cuadre de caja.
  async function marcarVerificado(pagoId: string, verificado: boolean) {
    const db = await getDb();
    await db.execute("UPDATE pagos SET verificado_admin = $1 WHERE id = $2", [verificado ? 1 : 0, pagoId]);
    if (seleccionada) await abrirFactura(seleccionada.id);
  }

  function formatearFechaHora(fh: string) {
    const [fecha, hora] = fh.split(" ");
    const [y, m, d] = fecha.split("-");
    const [hh, mm] = (hora ?? "00:00").split(":");
    return `${d}/${m}/${y} ${hh}:${mm}`;
  }

  return (
    <div className="venta-layout">
      <div className="card">
        <h2>Buscar facturas</h2>
        <div className="form-row">
          <label style={{ alignSelf: "center" }}>Desde</label>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          <label style={{ alignSelf: "center" }}>Hasta</label>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </div>
        <div className="form-row">
          <input
            placeholder="Buscar por N° de ticket, cliente o cédula"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            style={{ flex: 1 }}
          />
          <select value={metodoFiltro} onChange={(e) => setMetodoFiltro(e.target.value)}>
            <option value="">Todos los métodos de pago</option>
            {METODOS_PAGO.map((m) => (
              <option key={m} value={m}>
                {m.split("_").join(" ")}
              </option>
            ))}
            <option value="CREDITO">Crédito</option>
          </select>
        </div>

        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Vendedor</th>
              <th>Total Bs</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {facturas.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.numero_ticket}
                  {f.canal === "DELIVERY" && (
                    <span className="badge badge-ok" style={{ marginLeft: 6 }}>
                      Delivery
                    </span>
                  )}
                </td>
                <td>{formatearFechaHora(f.fecha_hora)}</td>
                <td>{f.cliente_nombre ?? "Consumidor final"}</td>
                <td>{f.vendedor_nombre ?? "—"}</td>
                <td>{f.total_bs.toFixed(2)}</td>
                <td>{f.estado}</td>
                <td>
                  <button className="link-btn" onClick={() => abrirFactura(f.id)}>
                    ver
                  </button>
                </td>
              </tr>
            ))}
            {facturas.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Sin facturas en este rango/búsqueda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        {!seleccionada ? (
          <p className="hint">Selecciona una factura para ver el detalle.</p>
        ) : (
          <div className="ticket">
            <h2>Factura {seleccionada.numero_ticket}</h2>
            <img src={logo} alt={config.nombre_negocio} className="ticket-logo" />
            <p className="ticket-meta">
              {formatearFechaHora(seleccionada.fecha_hora)}
              <br />
              Vendedor: {seleccionada.vendedor_nombre ?? "sin especificar"}
              <br />
              Cliente: {seleccionada.cliente_nombre ? `${seleccionada.cliente_nombre} (${seleccionada.cliente_cedula})` : "Consumidor final"}
              {seleccionada.cliente_direccion && (
                <>
                  <br />
                  Dirección: {seleccionada.cliente_direccion}
                </>
              )}
              <br />
              Estado: {seleccionada.estado}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cant.</th>
                  <th>Precio Bs</th>
                  <th>Subtotal Bs</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.producto_nombre}</td>
                    <td>{it.cantidad}</td>
                    <td>{it.precio_unit_bs.toFixed(2)}</td>
                    <td>{it.subtotal_bs.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {esAdmin && !editandoItems && (
              <button type="button" className="link-btn no-print" onClick={() => setEditandoItems(true)}>
                editar productos de esta venta
              </button>
            )}
            {esAdmin && editandoItems && (
              <div className="no-print">
                <EditorItemsVenta
                  ventaId={seleccionada.id}
                  itemsIniciales={itemsEditables}
                  tasaCambioDia={seleccionada.tasa_cambio_dia}
                  onGuardado={async () => {
                    setEditandoItems(false);
                    await abrirFactura(seleccionada.id);
                    await cargarLista();
                  }}
                  onCancelar={() => setEditandoItems(false)}
                />
              </div>
            )}
            <p>Subtotal: Bs {seleccionada.subtotal_bs.toFixed(2)}</p>
            <p>IVA: Bs {seleccionada.iva_bs.toFixed(2)}</p>
            <p className="ticket-total">
              Total: Bs {seleccionada.total_bs.toFixed(2)}{" "}
              <span style={{ fontWeight: 400, fontSize: 13, color: "#5f5e5a" }}>
                (USD {(seleccionada.total_bs / seleccionada.tasa_cambio_dia).toFixed(2)})
              </span>
            </p>
            <div className="no-print">
              {esAdmin && (
                <p style={{ marginBottom: 4 }}>
                  Pagos — si la caja se equivocó de método (ej. marcó punto de venta y fue biopago),
                  se corrige acá:
                </p>
              )}
              {pagos.map((p) =>
                p.metodo === "CREDITO" ? (
                  <div key={p.id} className="form-row" style={{ alignItems: "center" }}>
                    <span style={{ minWidth: 140 }}>Crédito pendiente</span>
                    <span className="hint" style={{ margin: 0 }}>Bs {p.monto_bs.toFixed(2)}</span>
                  </div>
                ) : esAdmin ? (
                  <div key={p.id} className="form-row" style={{ alignItems: "center" }}>
                    <select
                      defaultValue={p.metodo}
                      onChange={(e) => actualizarPago(p.id, e.target.value, p.referencia ?? "")}
                      style={{ minWidth: 140 }}
                    >
                      {METODOS_PAGO.map((m) => (
                        <option key={m} value={m}>
                          {m.split("_").join(" ")}
                        </option>
                      ))}
                    </select>
                    <span className="hint" style={{ margin: 0 }}>Bs {p.monto_bs.toFixed(2)}</span>
                    <input
                      placeholder="Referencia (opcional)"
                      defaultValue={p.referencia ?? ""}
                      onBlur={(e) => actualizarPago(p.id, p.metodo, e.target.value)}
                      style={{ maxWidth: 180 }}
                    />
                    {p.metodo === "PAGO_MOVIL" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={p.verificado_admin === 1}
                          onChange={(e) => marcarVerificado(p.id, e.target.checked)}
                        />
                        Pago móvil verificado
                      </label>
                    )}
                  </div>
                ) : (
                  <div key={p.id} className="form-row" style={{ alignItems: "center" }}>
                    <span style={{ minWidth: 140 }}>{p.metodo.split("_").join(" ")}</span>
                    <span className="hint" style={{ margin: 0 }}>Bs {p.monto_bs.toFixed(2)}</span>
                    {p.metodo === "PAGO_MOVIL" && (
                      <span className={p.verificado_admin === 1 ? "badge badge-ok" : "hint"}>
                        {p.verificado_admin === 1 ? "Verificado ✓" : "Sin verificar"}
                      </span>
                    )}
                  </div>
                )
              )}
            </div>
            <p>Pagos: {pagos.map((p) => `${p.metodo.split("_").join(" ")} Bs ${p.monto_bs.toFixed(2)}`).join(" · ")}</p>
            {seleccionada.monto_pendiente_usd != null && seleccionada.monto_pendiente_usd > 0 && (
              <p className="restante-pendiente">Saldo pendiente: USD {seleccionada.monto_pendiente_usd.toFixed(2)}</p>
            )}
            <div className="form-row no-print">
              <button onClick={() => window.print()}>Reimprimir</button>
              <button className="link-btn" onClick={() => setSeleccionada(null)}>
                cerrar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
