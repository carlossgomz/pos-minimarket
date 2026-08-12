import { Fragment, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import {
  ClienteDeudor,
  ConfigRow,
  FacturaPendiente,
  FacturaVentaItemDetalle,
  FacturaVentaItemEditable,
  FacturaVentaPagoDetalle,
  ProveedorDeudor,
  VentaCredito,
} from "../types";
import EditorItemsVenta from "./EditorItemsVenta";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";

const EPS = 0.01;

// Análisis de vencimiento de cuentas por pagar: cuántos días pasaron
// desde que se creó la factura del proveedor, para saber cuáles llevan
// más tiempo sin pagarse.
function diasTranscurridos(fecha: string): number {
  const inicio = new Date(fecha).getTime();
  return Math.max(0, Math.floor((Date.now() - inicio) / 86_400_000));
}

function colorVencimiento(dias: number): string {
  if (dias > 30) return "#a32d2d"; // vencida hace rato
  if (dias > 15) return "#b9770e"; // se está poniendo vieja
  return "#5f5e5a";
}

function CuentasPorCobrar({ config, esAdmin }: { config: ConfigRow; esAdmin: boolean }) {
  const [clientes, setClientes] = useState<ClienteDeudor[]>([]);
  const [cedulaAbierta, setCedulaAbierta] = useState<string | null>(null);
  const [ventas, setVentas] = useState<VentaCredito[]>([]);
  // El abono se registra contra la DEUDA TOTAL del cliente (todas sus
  // ventas a crédito pendientes juntas), no contra un ticket puntual — el
  // sistema reparte el pago entre esas ventas, de la más vieja a la más
  // nueva, hasta agotar el monto (ver registrar_abono_cliente_total en
  // src-tauri/src/comandos.rs).
  const [clienteAbono, setClienteAbono] = useState<ClienteDeudor | null>(null);
  const [montoBs, setMontoBs] = useState("");
  const [tasaPago, setTasaPago] = useState(String(config.tasa_cambio_dia));
  const [metodo, setMetodo] = useState("EFECTIVO");
  const [mensaje, setMensaje] = useState<string | null>(null);

  const [ventaDetalleAbierta, setVentaDetalleAbierta] = useState<string | null>(null);
  const [itemsDetalle, setItemsDetalle] = useState<FacturaVentaItemDetalle[]>([]);
  const [itemsEditables, setItemsEditables] = useState<FacturaVentaItemEditable[]>([]);
  const [pagosDetalle, setPagosDetalle] = useState<FacturaVentaPagoDetalle[]>([]);
  const [ventaEditando, setVentaEditando] = useState<VentaCredito | null>(null);

  async function cargarDetalle(ventaId: string) {
    const db = await getDb();
    const items = await db.select<FacturaVentaItemDetalle[]>(
      `SELECT p.nombre as producto_nombre, vi.cantidad, vi.precio_unit_bs, vi.subtotal_bs
       FROM venta_items vi JOIN productos p ON p.id = vi.producto_id
       WHERE vi.venta_id = $1`,
      [ventaId]
    );
    setItemsDetalle(items);
    const itemsEd = await db.select<FacturaVentaItemEditable[]>(
      `SELECT vi.producto_id, p.nombre as producto_nombre, vi.cantidad, vi.precio_unit_bs
       FROM venta_items vi JOIN productos p ON p.id = vi.producto_id
       WHERE vi.venta_id = $1`,
      [ventaId]
    );
    setItemsEditables(itemsEd);
    const pagos = await db.select<FacturaVentaPagoDetalle[]>(
      "SELECT id, metodo, monto_bs, referencia, verificado_admin FROM pagos WHERE venta_id = $1",
      [ventaId]
    );
    setPagosDetalle(pagos);
  }

  async function toggleDetalle(v: VentaCredito) {
    setVentaEditando(null);
    if (ventaDetalleAbierta === v.id) {
      setVentaDetalleAbierta(null);
      setItemsDetalle([]);
      setItemsEditables([]);
      setPagosDetalle([]);
      return;
    }
    setVentaDetalleAbierta(v.id);
    await cargarDetalle(v.id);
  }

  async function cargarClientes() {
    const db = await getDb();
    const rows = await db.select<ClienteDeudor[]>(
      `SELECT cliente_nombre, cliente_cedula,
              SUM(monto_pendiente_usd) as total_pendiente_usd,
              COUNT(*) as num_ventas
       FROM ventas
       WHERE estado = 'CREDITO_PENDIENTE'
       GROUP BY cliente_cedula
       ORDER BY total_pendiente_usd DESC`
    );
    setClientes(rows);
  }

  useEffect(() => {
    cargarClientes();
  }, []);

  async function abrirCliente(cedula: string) {
    setVentaDetalleAbierta(null);
    setItemsDetalle([]);
    setItemsEditables([]);
    setPagosDetalle([]);
    setVentaEditando(null);
    if (cedulaAbierta === cedula) {
      setCedulaAbierta(null);
      setVentas([]);
      return;
    }
    setCedulaAbierta(cedula);
    const db = await getDb();
    const rows = await db.select<VentaCredito[]>(
      `SELECT id, numero_ticket, fecha_hora, total_bs, monto_pendiente_usd, tasa_cambio_dia
       FROM ventas WHERE cliente_cedula = $1 AND estado = 'CREDITO_PENDIENTE'
       ORDER BY fecha_hora`,
      [cedula]
    );
    setVentas(rows);
  }

  async function recargarVentasCliente(cedula: string) {
    const db = await getDb();
    const rows = await db.select<VentaCredito[]>(
      `SELECT id, numero_ticket, fecha_hora, total_bs, monto_pendiente_usd, tasa_cambio_dia
       FROM ventas WHERE cliente_cedula = $1 AND estado = 'CREDITO_PENDIENTE' ORDER BY fecha_hora`,
      [cedula]
    );
    setVentas(rows);
  }

  function empezarAbono(c: ClienteDeudor) {
    setClienteAbono(c);
    setMontoBs("");
    setTasaPago(String(config.tasa_cambio_dia));
    setMensaje(null);
  }

  async function confirmarAbono() {
    if (!clienteAbono) return;
    const bs = Number(montoBs);
    const tasa = Number(tasaPago);
    if (!bs || bs <= 0) {
      setMensaje("El monto debe ser mayor a 0.");
      return;
    }
    if (!tasa || tasa <= 0) {
      setMensaje("La tasa del día debe ser mayor a 0.");
      return;
    }
    const usd = bs / tasa;
    if (usd > clienteAbono.total_pendiente_usd + EPS) {
      setMensaje(
        `Ese monto equivale a USD ${usd.toFixed(2)}, pero la deuda total es de solo USD ${clienteAbono.total_pendiente_usd.toFixed(2)}.`
      );
      return;
    }

    try {
      // Se guarda en una sola transacción real en Rust (ver
      // src-tauri/src/comandos.rs) — el mismo problema que tenían las
      // "transacciones" hechas a mano desde acá (BEGIN/COMMIT sueltos
      // contra el pool de conexiones) causaba el error "cannot commit -
      // no transaction is active". El pago se reparte solo entre todas
      // las ventas pendientes del cliente, de la más vieja a la más nueva.
      await invoke("registrar_abono_cliente_total", {
        input: {
          cliente_cedula: clienteAbono.cliente_cedula,
          monto_usd: usd,
          tasa_cambio_dia: tasa,
          metodo,
        },
      });
    } catch (e) {
      setMensaje(`No se pudo registrar el abono: ${String(e)}`);
      return;
    }

    setClienteAbono(null);
    setMontoBs("");
    await cargarClientes();
    if (cedulaAbierta) await recargarVentasCliente(cedulaAbierta);
  }

  return (
    <div className="card">
      <h2>Clientes con saldo pendiente</h2>
      <p className="hint">
        El saldo en bolívares se calcula a la tasa del día de hoy ({config.tasa_cambio_dia.toFixed(2)}{" "}
        Bs/$) — cambia solo si cambias la tasa arriba, no la de cada venta.
      </p>
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Cédula</th>
            <th>Ventas a crédito</th>
            <th>Saldo USD</th>
            <th>Saldo Bs (hoy)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clientes.map((c) => (
            <Fragment key={c.cliente_cedula}>
              <tr>
                <td>{c.cliente_nombre}</td>
                <td>{c.cliente_cedula}</td>
                <td>{c.num_ventas}</td>
                <td>{c.total_pendiente_usd.toFixed(2)}</td>
                <td>{(c.total_pendiente_usd * config.tasa_cambio_dia).toFixed(2)}</td>
                <td>
                  <button className="link-btn" onClick={() => abrirCliente(c.cliente_cedula)}>
                    {cedulaAbierta === c.cliente_cedula ? "ocultar" : "ver ventas"}
                  </button>{" "}
                  <button className="link-btn" onClick={() => empezarAbono(c)}>
                    registrar abono
                  </button>
                </td>
              </tr>
              {cedulaAbierta === c.cliente_cedula && (
                <tr>
                  <td colSpan={6}>
                    <table>
                      <thead>
                        <tr>
                          <th>Ticket</th>
                          <th>Fecha</th>
                          <th>Total Bs</th>
                          <th>Pendiente USD</th>
                          <th>Pendiente Bs (hoy)</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ventas.map((v) => (
                          <Fragment key={v.id}>
                            <tr>
                              <td>{v.numero_ticket}</td>
                              <td>{new Date(v.fecha_hora).toLocaleDateString("es-VE")}</td>
                              <td>{v.total_bs.toFixed(2)}</td>
                              <td>{v.monto_pendiente_usd.toFixed(2)}</td>
                              <td>{(v.monto_pendiente_usd * config.tasa_cambio_dia).toFixed(2)}</td>
                              <td>
                                <button className="link-btn" onClick={() => toggleDetalle(v)}>
                                  {ventaDetalleAbierta === v.id ? "ocultar detalle" : "ver detalle"}
                                </button>
                              </td>
                            </tr>
                            {ventaDetalleAbierta === v.id && (
                              <tr>
                                <td colSpan={6}>
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
                                      {itemsDetalle.map((it, i) => (
                                        <tr key={i}>
                                          <td>{it.producto_nombre}</td>
                                          <td>{it.cantidad}</td>
                                          <td>{it.precio_unit_bs.toFixed(2)}</td>
                                          <td>{it.subtotal_bs.toFixed(2)}</td>
                                        </tr>
                                      ))}
                                      {itemsDetalle.length === 0 && (
                                        <tr>
                                          <td colSpan={4} className="empty">
                                            Sin ítems.
                                          </td>
                                        </tr>
                                      )}
                                    </tbody>
                                  </table>
                                  <p className="hint" style={{ marginTop: 8 }}>
                                    Pagos ya recibidos:{" "}
                                    {pagosDetalle.length > 0
                                      ? pagosDetalle
                                          .map((p) => `${p.metodo.split("_").join(" ")} Bs ${p.monto_bs.toFixed(2)}`)
                                          .join(" · ")
                                      : "ninguno todavía"}
                                  </p>
                                  {esAdmin && ventaEditando?.id !== v.id && (
                                    <button type="button" className="link-btn" onClick={() => setVentaEditando(v)}>
                                      editar productos de esta venta
                                    </button>
                                  )}
                                  {esAdmin && ventaEditando?.id === v.id && (
                                    <EditorItemsVenta
                                      ventaId={v.id}
                                      itemsIniciales={itemsEditables}
                                      tasaCambioDia={v.tasa_cambio_dia}
                                      onGuardado={async () => {
                                        setVentaEditando(null);
                                        await cargarDetalle(v.id);
                                        await cargarClientes();
                                        if (cedulaAbierta) await recargarVentasCliente(cedulaAbierta);
                                      }}
                                      onCancelar={() => setVentaEditando(null)}
                                    />
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {clientes.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No hay créditos pendientes.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {clienteAbono && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Abono de {clienteAbono.cliente_nombre}</h2>
          <p className="hint">
            Deuda total pendiente ({clienteAbono.num_ventas} venta{clienteAbono.num_ventas === 1 ? "" : "s"}
            ): USD {clienteAbono.total_pendiente_usd.toFixed(2)}. Ingresa cuánto paga el cliente hoy
            y a qué tasa — el pago se aplica primero a la venta más antigua.
          </p>
          <div className="form-row">
            <input placeholder="Monto Bs" type="number" step="0.01" value={montoBs} onChange={(e) => setMontoBs(e.target.value)} />
            <input placeholder="Tasa del día" type="number" step="0.01" value={tasaPago} onChange={(e) => setTasaPago(e.target.value)} />
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)}>
              <option value="PUNTO_VENTA">Punto de venta</option>
              <option value="BIOPAGO">Biopago</option>
              <option value="PAGO_MOVIL">Pago móvil</option>
              <option value="EFECTIVO">Efectivo</option>
              <option value="DIVISAS">Divisas</option>
              <option value="TRANSFERENCIA">Transferencia</option>
            </select>
            <button onClick={confirmarAbono}>Confirmar abono</button>
            <button className="link-btn" onClick={() => setClienteAbono(null)}>
              cancelar
            </button>
          </div>
          {mensaje && <p className="error">{mensaje}</p>}
        </div>
      )}
    </div>
  );
}

function CuentasPorPagar({ config }: { config: ConfigRow }) {
  const [proveedores, setProveedores] = useState<ProveedorDeudor[]>([]);
  const [proveedorAbierto, setProveedorAbierto] = useState<string | null>(null);
  const [facturas, setFacturas] = useState<FacturaPendiente[]>([]);
  const [facturaAbono, setFacturaAbono] = useState<FacturaPendiente | null>(null);
  const [montoBs, setMontoBs] = useState("");
  const [tasaPago, setTasaPago] = useState(String(config.tasa_cambio_dia));
  const [metodo, setMetodo] = useState("EFECTIVO");
  const [referencia, setReferencia] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function cargarProveedores() {
    const db = await getDb();
    const rows = await db.select<ProveedorDeudor[]>(
      `SELECT pr.id as proveedor_id, pr.nombre as proveedor_nombre,
              SUM(fc.monto_total_usd - fc.monto_pagado_usd) as total_pendiente_usd,
              COUNT(*) as num_facturas
       FROM facturas_compra fc
       JOIN proveedores pr ON pr.id = fc.proveedor_id
       WHERE fc.estado != 'PAGADA'
       GROUP BY pr.id
       ORDER BY total_pendiente_usd DESC`
    );
    setProveedores(rows);
  }

  useEffect(() => {
    cargarProveedores();
  }, []);

  async function abrirProveedor(id: string) {
    if (proveedorAbierto === id) {
      setProveedorAbierto(null);
      setFacturas([]);
      return;
    }
    setProveedorAbierto(id);
    const db = await getDb();
    const rows = await db.select<FacturaPendiente[]>(
      `SELECT id, numero_factura, fecha, moneda, tasa_cambio_dia, monto_total_usd, monto_pagado_usd, estado
       FROM facturas_compra WHERE proveedor_id = $1 AND estado != 'PAGADA'
       ORDER BY fecha`,
      [id]
    );
    setFacturas(rows);
  }

  function empezarAbono(f: FacturaPendiente) {
    setFacturaAbono(f);
    setMontoBs("");
    setTasaPago(String(config.tasa_cambio_dia));
    setReferencia("");
    setMensaje(null);
  }

  async function confirmarAbono() {
    if (!facturaAbono) return;
    const bs = Number(montoBs);
    const tasa = Number(tasaPago);
    const saldoUsd = facturaAbono.monto_total_usd - facturaAbono.monto_pagado_usd;
    if (!bs || bs <= 0) {
      setMensaje("El monto debe ser mayor a 0.");
      return;
    }
    if (!tasa || tasa <= 0) {
      setMensaje("La tasa del día debe ser mayor a 0.");
      return;
    }
    const usd = bs / tasa;
    if (usd > saldoUsd + EPS) {
      setMensaje(`Ese monto equivale a USD ${usd.toFixed(2)}, pero el saldo es de solo USD ${saldoUsd.toFixed(2)}.`);
      return;
    }

    try {
      // Misma corrección que en el abono de clientes: transacción real
      // en Rust en vez de BEGIN/COMMIT sueltos desde el frontend.
      await invoke("registrar_pago_proveedor", {
        input: {
          factura_compra_id: facturaAbono.id,
          monto_usd: usd,
          tasa_cambio_dia: tasa,
          monto_bs: bs,
          metodo,
          referencia: referencia.trim() || null,
        },
      });
    } catch (e) {
      setMensaje(`No se pudo registrar el pago: ${String(e)}`);
      return;
    }

    setFacturaAbono(null);
    setMontoBs("");
    setReferencia("");
    await cargarProveedores();
    if (proveedorAbierto) {
      const db2 = await getDb();
      const rows = await db2.select<FacturaPendiente[]>(
        `SELECT id, numero_factura, fecha, moneda, tasa_cambio_dia, monto_total_usd, monto_pagado_usd, estado
         FROM facturas_compra WHERE proveedor_id = $1 AND estado != 'PAGADA' ORDER BY fecha`,
        [proveedorAbierto]
      );
      setFacturas(rows);
    }
  }

  return (
    <div className="card">
      <h2>Proveedores con saldo pendiente</h2>
      <p className="hint">
        El saldo en bolívares se calcula a la tasa del día de hoy ({config.tasa_cambio_dia.toFixed(2)}{" "}
        Bs/$) — cambia solo si cambias la tasa arriba, no la de cada factura.
      </p>
      <table>
        <thead>
          <tr>
            <th>Proveedor</th>
            <th>Facturas pendientes</th>
            <th>Saldo USD</th>
            <th>Saldo Bs (hoy)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {proveedores.map((p) => (
            <Fragment key={p.proveedor_id}>
              <tr>
                <td>{p.proveedor_nombre}</td>
                <td>{p.num_facturas}</td>
                <td>{p.total_pendiente_usd.toFixed(2)}</td>
                <td>{(p.total_pendiente_usd * config.tasa_cambio_dia).toFixed(2)}</td>
                <td>
                  <button className="link-btn" onClick={() => abrirProveedor(p.proveedor_id)}>
                    {proveedorAbierto === p.proveedor_id ? "ocultar" : "ver facturas"}
                  </button>
                </td>
              </tr>
              {proveedorAbierto === p.proveedor_id && (
                <tr>
                  <td colSpan={5}>
                    <table>
                      <thead>
                        <tr>
                          <th>Factura</th>
                          <th>Fecha</th>
                          <th>Días</th>
                          <th>Moneda</th>
                          <th>Total USD</th>
                          <th>Saldo USD</th>
                          <th>Saldo Bs (hoy)</th>
                          <th>Estado</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {facturas.map((f) => {
                          const saldoUsd = f.monto_total_usd - f.monto_pagado_usd;
                          const dias = diasTranscurridos(f.fecha);
                          return (
                            <tr key={f.id}>
                              <td>{f.numero_factura}</td>
                              <td>{new Date(f.fecha).toLocaleDateString("es-VE")}</td>
                              <td style={{ color: colorVencimiento(dias), fontWeight: dias > 15 ? 700 : 400 }}>
                                {dias}
                              </td>
                              <td>{f.moneda}</td>
                              <td>{f.monto_total_usd.toFixed(2)}</td>
                              <td>{saldoUsd.toFixed(2)}</td>
                              <td>{(saldoUsd * config.tasa_cambio_dia).toFixed(2)}</td>
                              <td>{f.estado}</td>
                              <td>
                                <button className="link-btn" onClick={() => empezarAbono(f)}>
                                  registrar pago
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {proveedores.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                No hay facturas de proveedor pendientes.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {facturaAbono && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Pago a factura {facturaAbono.numero_factura}</h2>
          <p className="hint">
            Saldo pendiente: USD {(facturaAbono.monto_total_usd - facturaAbono.monto_pagado_usd).toFixed(2)}.
            Ingresa cuánto pagas hoy y a qué tasa.
          </p>
          <div className="form-row">
            <input placeholder="Monto Bs" type="number" step="0.01" value={montoBs} onChange={(e) => setMontoBs(e.target.value)} />
            <input placeholder="Tasa del día" type="number" step="0.01" value={tasaPago} onChange={(e) => setTasaPago(e.target.value)} />
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)}>
              <option value="PUNTO_VENTA">Punto de venta</option>
              <option value="BIOPAGO">Biopago</option>
              <option value="PAGO_MOVIL">Pago móvil</option>
              <option value="EFECTIVO">Efectivo</option>
              <option value="DIVISAS">Divisas</option>
              <option value="TRANSFERENCIA">Transferencia</option>
            </select>
            <input
              placeholder="Referencia bancaria (opcional)"
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
            />
            <button onClick={confirmarAbono}>Confirmar pago</button>
            <button className="link-btn" onClick={() => setFacturaAbono(null)}>
              cancelar
            </button>
          </div>
          {mensaje && <p className="error">{mensaje}</p>}
        </div>
      )}
    </div>
  );
}

type FacturaCompraPagada = {
  id: string;
  numero_factura: string;
  fecha: string;
  proveedor_nombre: string;
  moneda: string;
  tasa_cambio_dia: number;
  monto_total_usd: number;
  ultimo_pago: string | null;
};

type ItemFacturaCompraDetalle = {
  producto_nombre: string;
  cantidad: number;
  costo_unitario_usd: number;
};

type PagoProveedorDetalle = {
  monto_usd: number;
  monto_bs: number;
  metodo: string;
  referencia: string | null;
  created_at: string;
};

// Historial de facturas de proveedor YA pagadas por completo — separado de
// "Por pagar" (que solo lista las pendientes), para poder revisar y
// reimprimir lo que ya se saldó sin mezclarlo con la deuda actual.
function FacturasPagadas() {
  const [facturas, setFacturas] = useState<FacturaCompraPagada[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null);
  const [items, setItems] = useState<ItemFacturaCompraDetalle[]>([]);
  const [pagos, setPagos] = useState<PagoProveedorDetalle[]>([]);

  async function cargar() {
    const db = await getDb();
    const term = busqueda.trim();
    const rows = await db.select<FacturaCompraPagada[]>(
      `SELECT fc.id, fc.numero_factura, fc.fecha, pr.nombre as proveedor_nombre, fc.moneda,
              fc.tasa_cambio_dia, fc.monto_total_usd,
              (SELECT MAX(pp.created_at) FROM pagos_proveedor pp WHERE pp.factura_compra_id = fc.id) as ultimo_pago
       FROM facturas_compra fc JOIN proveedores pr ON pr.id = fc.proveedor_id
       WHERE fc.estado = 'PAGADA' AND (${sqlSinAcentos("pr.nombre")} LIKE $1 OR fc.numero_factura LIKE $2)
       ORDER BY fc.fecha DESC LIMIT 200`,
      [`%${normalizarTexto(term)}%`, `%${term}%`]
    );
    setFacturas(rows);
  }

  useEffect(() => {
    const timer = setTimeout(cargar, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);

  async function toggleDetalle(f: FacturaCompraPagada) {
    if (detalleAbierto === f.id) {
      setDetalleAbierto(null);
      setItems([]);
      setPagos([]);
      return;
    }
    setDetalleAbierto(f.id);
    const db = await getDb();
    const itemsRows = await db.select<ItemFacturaCompraDetalle[]>(
      `SELECT p.nombre as producto_nombre, i.cantidad, i.costo_unitario_usd
       FROM items_factura_compra i JOIN productos p ON p.id = i.producto_id
       WHERE i.factura_compra_id = $1`,
      [f.id]
    );
    setItems(itemsRows);
    const pagosRows = await db.select<PagoProveedorDetalle[]>(
      `SELECT monto_usd, monto_bs, metodo, referencia, created_at
       FROM pagos_proveedor WHERE factura_compra_id = $1 ORDER BY created_at`,
      [f.id]
    );
    setPagos(pagosRows);
  }

  return (
    <div className="card">
      <div className="form-row" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Facturas de proveedor ya pagadas</h2>
        <button type="button" className="no-print" onClick={() => window.print()}>
          Imprimir
        </button>
      </div>
      <input
        placeholder="Buscar por proveedor o número de factura"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        style={{ marginBottom: 10, width: "100%", padding: "8px 10px", border: "1px solid #b4b2a9", borderRadius: 6 }}
      />
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Factura</th>
              <th>Proveedor</th>
              <th>Fecha</th>
              <th>Moneda</th>
              <th>Total USD</th>
              <th>Total Bs</th>
              <th>Último pago</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {facturas.map((f) => (
              <Fragment key={f.id}>
                <tr>
                  <td>{f.numero_factura}</td>
                  <td>{f.proveedor_nombre}</td>
                  <td>{new Date(f.fecha).toLocaleDateString("es-VE")}</td>
                  <td>{f.moneda}</td>
                  <td>{f.monto_total_usd.toFixed(2)}</td>
                  <td>{(f.monto_total_usd * f.tasa_cambio_dia).toFixed(2)}</td>
                  <td>{f.ultimo_pago ? new Date(f.ultimo_pago).toLocaleDateString("es-VE") : "—"}</td>
                  <td>
                    <button className="link-btn" onClick={() => toggleDetalle(f)}>
                      {detalleAbierto === f.id ? "ocultar detalle" : "ver detalle"}
                    </button>
                  </td>
                </tr>
                {detalleAbierto === f.id && (
                  <tr>
                    <td colSpan={8}>
                      <p className="hint" style={{ marginTop: 0 }}>
                        Productos de la factura
                      </p>
                      <table>
                        <thead>
                          <tr>
                            <th>Producto</th>
                            <th>Cantidad</th>
                            <th>Costo unit. USD</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it, i) => (
                            <tr key={i}>
                              <td>{it.producto_nombre}</td>
                              <td>{it.cantidad}</td>
                              <td>{it.costo_unitario_usd.toFixed(4)}</td>
                            </tr>
                          ))}
                          {items.length === 0 && (
                            <tr>
                              <td colSpan={3} className="empty">
                                Sin ítems.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                      <p className="hint">Pagos realizados</p>
                      <table>
                        <thead>
                          <tr>
                            <th>Fecha</th>
                            <th>Método</th>
                            <th>Monto USD</th>
                            <th>Monto Bs</th>
                            <th>Referencia</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagos.map((p, i) => (
                            <tr key={i}>
                              <td>{new Date(p.created_at).toLocaleDateString("es-VE")}</td>
                              <td>{p.metodo.split("_").join(" ")}</td>
                              <td>{p.monto_usd.toFixed(2)}</td>
                              <td>{p.monto_bs.toFixed(2)}</td>
                              <td>{p.referencia ?? "—"}</td>
                            </tr>
                          ))}
                          {pagos.length === 0 && (
                            <tr>
                              <td colSpan={5} className="empty">
                                Sin pagos registrados.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {facturas.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  No hay facturas de proveedor pagadas todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Solo aparece al imprimir — listado simple para archivo/revisión. */}
      <div className="imprimible">
        <h2>Facturas de proveedor pagadas</h2>
        <p>Impreso el {new Date().toLocaleString("es-VE")}</p>
        <table>
          <thead>
            <tr>
              <th>Factura</th>
              <th>Proveedor</th>
              <th>Fecha</th>
              <th>Total USD</th>
              <th>Total Bs</th>
              <th>Último pago</th>
            </tr>
          </thead>
          <tbody>
            {facturas.map((f) => (
              <tr key={f.id}>
                <td>{f.numero_factura}</td>
                <td>{f.proveedor_nombre}</td>
                <td>{new Date(f.fecha).toLocaleDateString("es-VE")}</td>
                <td>{f.monto_total_usd.toFixed(2)}</td>
                <td>{(f.monto_total_usd * f.tasa_cambio_dia).toFixed(2)}</td>
                <td>{f.ultimo_pago ? new Date(f.ultimo_pago).toLocaleDateString("es-VE") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Cuentas({ config, esAdmin }: { config: ConfigRow; esAdmin: boolean }) {
  const [sub, setSub] = useState<"cobrar" | "pagar" | "pagadas">("cobrar");

  // El cajero solo ve las cuentas por cobrar de clientes — lo que se le
  // debe a los proveedores es información administrativa/financiera del
  // negocio, no algo que necesite ver en el mostrador.
  if (!esAdmin) {
    return <CuentasPorCobrar config={config} esAdmin={false} />;
  }

  return (
    <div>
      <div className="tabs no-print" style={{ marginBottom: 16 }}>
        <button className={sub === "cobrar" ? "tab-activo" : ""} onClick={() => setSub("cobrar")}>
          Por cobrar (clientes)
        </button>
        <button className={sub === "pagar" ? "tab-activo" : ""} onClick={() => setSub("pagar")}>
          Por pagar (proveedores)
        </button>
        <button className={sub === "pagadas" ? "tab-activo" : ""} onClick={() => setSub("pagadas")}>
          Pagadas (proveedores)
        </button>
      </div>
      {sub === "cobrar" && <CuentasPorCobrar config={config} esAdmin={esAdmin} />}
      {sub === "pagar" && <CuentasPorPagar config={config} />}
      {sub === "pagadas" && <FacturasPagadas />}
    </div>
  );
}
