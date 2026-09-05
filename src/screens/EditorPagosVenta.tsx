import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FacturaVentaPagoDetalle, METODOS_PAGO } from "../types";

type LineaPagoEditable = {
  key: string;
  metodo: string;
  monto_bs: number;
  referencia: string;
};

const EPS = 0.01;

// Editor de los pagos de una venta ya registrada — solo para admin, para
// cuando la caja se equivocó de método o el cliente pagó dividido entre
// varios métodos y no quedó registrado así. A diferencia de EditorItemsVenta,
// acá NO se puede cambiar cuánto se cobró en total: solo redistribuir el
// mismo monto entre métodos (ver editar_venta_pagos en
// src-tauri/src/comandos.rs, que rechaza el guardado si la suma no
// coincide). La fila de crédito pendiente (si la hay) no pasa por acá.
export default function EditorPagosVenta({
  ventaId,
  pagosIniciales,
  onGuardado,
  onCancelar,
}: {
  ventaId: string;
  pagosIniciales: FacturaVentaPagoDetalle[];
  onGuardado: () => void;
  onCancelar: () => void;
}) {
  const sumaOriginal = pagosIniciales.reduce((a, p) => a + p.monto_bs, 0);
  const [lineas, setLineas] = useState<LineaPagoEditable[]>(
    pagosIniciales.map((p) => ({
      key: p.id,
      metodo: p.metodo,
      monto_bs: p.monto_bs,
      referencia: p.referencia ?? "",
    }))
  );
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  function agregarLinea() {
    setLineas((prev) => [
      ...prev,
      { key: crypto.randomUUID(), metodo: METODOS_PAGO[0], monto_bs: 0, referencia: "" },
    ]);
  }

  function quitarLinea(key: string) {
    setLineas((prev) => prev.filter((l) => l.key !== key));
  }

  function cambiarLinea(key: string, cambios: Partial<LineaPagoEditable>) {
    setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...cambios } : l)));
  }

  const sumaNueva = lineas.reduce((a, l) => a + (Number(l.monto_bs) || 0), 0);
  const diferencia = sumaNueva - sumaOriginal;
  const cuadra = Math.abs(diferencia) < EPS;

  async function guardar() {
    if (lineas.length === 0) {
      setMensaje("La venta debe tener al menos un pago.");
      return;
    }
    if (lineas.some((l) => !l.metodo || !l.monto_bs || l.monto_bs <= 0)) {
      setMensaje("Todas las líneas deben tener método y un monto mayor a 0.");
      return;
    }
    if (!cuadra) {
      setMensaje(
        `La suma (Bs ${sumaNueva.toFixed(2)}) no coincide con lo ya cobrado (Bs ${sumaOriginal.toFixed(2)}) — solo se puede redistribuir entre métodos, no cambiar el total.`
      );
      return;
    }
    setGuardando(true);
    setMensaje(null);
    try {
      await invoke("editar_venta_pagos", {
        ventaId,
        pagos: lineas.map((l) => ({
          metodo: l.metodo,
          monto_bs: Number(l.monto_bs),
          referencia: l.referencia.trim() || null,
        })),
      });
      onGuardado();
    } catch (e) {
      setMensaje(`No se pudo guardar: ${String(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Editar pagos de la venta</h3>
      <p className="hint">
        Corrige el método de un pago, o divide el monto entre varios métodos si el cliente pagó
        separado. La suma tiene que quedar igual a lo ya cobrado — esto no cambia el total de la
        venta, solo cómo se cobró.
      </p>
      <table>
        <thead>
          <tr>
            <th>Método</th>
            <th>Monto Bs</th>
            <th>Referencia</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lineas.map((l) => (
            <tr key={l.key}>
              <td>
                <select value={l.metodo} onChange={(e) => cambiarLinea(l.key, { metodo: e.target.value })}>
                  {METODOS_PAGO.map((m) => (
                    <option key={m} value={m}>
                      {m.split("_").join(" ")}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={l.monto_bs}
                  onChange={(e) => cambiarLinea(l.key, { monto_bs: Number(e.target.value) })}
                  style={{ width: 100 }}
                />
              </td>
              <td>
                <input
                  placeholder="Opcional"
                  value={l.referencia}
                  onChange={(e) => cambiarLinea(l.key, { referencia: e.target.value })}
                  style={{ maxWidth: 160 }}
                />
              </td>
              <td>
                <button className="link-btn link-btn-danger" onClick={() => quitarLinea(l.key)}>
                  quitar
                </button>
              </td>
            </tr>
          ))}
          {lineas.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Sin pagos — agrega al menos uno.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <button type="button" className="link-btn" onClick={agregarLinea} style={{ marginTop: 4 }}>
        + agregar método de pago
      </button>
      <p style={{ fontWeight: 700, color: cuadra ? undefined : "var(--danger-text)" }}>
        {cuadra
          ? `Suma: Bs ${sumaNueva.toFixed(2)} (cuadra con lo ya cobrado)`
          : `Diferencia: Bs ${diferencia.toFixed(2)} — debe llegar a 0 para poder guardar`}
      </p>

      {mensaje && <p className="error">{mensaje}</p>}
      <div className="form-row" style={{ marginTop: 12 }}>
        <button onClick={guardar} disabled={guardando || !cuadra}>
          {guardando ? "Guardando…" : "Guardar cambios en pagos"}
        </button>
        <button className="link-btn" onClick={onCancelar}>
          cancelar
        </button>
      </div>
    </div>
  );
}
