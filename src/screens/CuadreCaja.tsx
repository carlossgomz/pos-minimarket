import { useEffect, useState } from "react";
import { getDb } from "../db";

const METODOS_BASE = ["EFECTIVO", "PUNTO_VENTA", "BIOPAGO", "PAGO_MOVIL", "TRANSFERENCIA"];

type Fila = { metodo: string; esperado: number; contado: string };

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function armarFilas(esperados: Record<string, number>, contadosGuardados: Record<string, number>): Fila[] {
  const metodos = new Set([...METODOS_BASE, ...Object.keys(esperados)]);
  return Array.from(metodos).map((m) => ({
    metodo: m,
    esperado: esperados[m] ?? 0,
    contado: contadosGuardados[m] != null ? String(contadosGuardados[m]) : "",
  }));
}

export default function CuadreCaja() {
  const [fecha, setFecha] = useState(hoyISO());
  const [ingresos, setIngresos] = useState<Fila[]>([]);
  const [egresos, setEgresos] = useState<Fila[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function cargar() {
    setMensaje(null);
    setGuardado(false);
    const db = await getDb();

    const porVenta = await db.select<{ metodo: string; monto: number }[]>(
      `SELECT p.metodo as metodo, SUM(p.monto_bs) as monto
       FROM pagos p JOIN ventas v ON v.id = p.venta_id
       WHERE date(v.fecha_hora) = $1 AND p.metodo != 'CREDITO'
       GROUP BY p.metodo`,
      [fecha]
    );
    const porCobroCredito = await db.select<{ metodo: string | null; monto: number }[]>(
      `SELECT metodo, SUM(monto_bs) as monto FROM cobros_cliente WHERE date(created_at) = $1 GROUP BY metodo`,
      [fecha]
    );
    const esperadosIngreso: Record<string, number> = {};
    for (const r of porVenta) esperadosIngreso[r.metodo] = (esperadosIngreso[r.metodo] ?? 0) + r.monto;
    for (const r of porCobroCredito) {
      const m = r.metodo ?? "SIN_ESPECIFICAR";
      esperadosIngreso[m] = (esperadosIngreso[m] ?? 0) + r.monto;
    }

    const porPagoProveedor = await db.select<{ metodo: string | null; monto: number }[]>(
      `SELECT metodo, SUM(monto_bs) as monto FROM pagos_proveedor WHERE date(created_at) = $1 GROUP BY metodo`,
      [fecha]
    );
    const esperadosEgreso: Record<string, number> = {};
    for (const r of porPagoProveedor) {
      const m = r.metodo ?? "SIN_ESPECIFICAR";
      esperadosEgreso[m] = (esperadosEgreso[m] ?? 0) + r.monto;
    }

    const guardados = await db.select<{ tipo: string; metodo: string; monto_contado_bs: number }[]>(
      `SELECT tipo, metodo, monto_contado_bs FROM cierres_caja WHERE fecha = $1`,
      [fecha]
    );
    const contadosIngreso: Record<string, number> = {};
    const contadosEgreso: Record<string, number> = {};
    for (const g of guardados) {
      if (g.tipo === "INGRESO") contadosIngreso[g.metodo] = g.monto_contado_bs;
      else contadosEgreso[g.metodo] = g.monto_contado_bs;
    }

    setIngresos(armarFilas(esperadosIngreso, contadosIngreso));
    setEgresos(armarFilas(esperadosEgreso, contadosEgreso));
  }

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fecha]);

  function actualizarContado(lista: "ingresos" | "egresos", metodo: string, valor: string) {
    const setter = lista === "ingresos" ? setIngresos : setEgresos;
    setter((prev) => prev.map((f) => (f.metodo === metodo ? { ...f, contado: valor } : f)));
    setGuardado(false);
  }

  async function guardarCierre() {
    setGuardando(true);
    setMensaje(null);
    const db = await getDb();
    try {
      await db.execute("BEGIN");
      for (const [tipo, filas] of [
        ["INGRESO", ingresos],
        ["EGRESO", egresos],
      ] as const) {
        for (const f of filas) {
          const contado = Number(f.contado || "0");
          const diferencia = contado - f.esperado;
          await db.execute(
            `INSERT INTO cierres_caja (id, fecha, tipo, metodo, monto_esperado_bs, monto_contado_bs, diferencia_bs)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(fecha, tipo, metodo) DO UPDATE SET
               monto_esperado_bs = excluded.monto_esperado_bs,
               monto_contado_bs = excluded.monto_contado_bs,
               diferencia_bs = excluded.diferencia_bs`,
            [crypto.randomUUID(), fecha, tipo, f.metodo, f.esperado, contado, diferencia]
          );
        }
      }
      await db.execute("COMMIT");
    } catch (e) {
      await db.execute("ROLLBACK");
      setMensaje(`No se pudo guardar el cierre: ${String(e)}`);
      setGuardando(false);
      return;
    }
    setGuardando(false);
    setGuardado(true);
  }

  const totalIngresoEsperado = ingresos.reduce((a, f) => a + f.esperado, 0);
  const totalIngresoContado = ingresos.reduce((a, f) => a + Number(f.contado || "0"), 0);
  const totalEgresoEsperado = egresos.reduce((a, f) => a + f.esperado, 0);
  const totalEgresoContado = egresos.reduce((a, f) => a + Number(f.contado || "0"), 0);

  function tablaFilas(
    filas: Fila[],
    lista: "ingresos" | "egresos"
  ) {
    return (
      <table>
        <thead>
          <tr>
            <th>Método</th>
            <th>Esperado Bs</th>
            <th>Contado Bs</th>
            <th>Diferencia</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => {
            const contadoNum = Number(f.contado || "0");
            const diff = f.contado === "" ? null : contadoNum - f.esperado;
            return (
              <tr key={f.metodo}>
                <td>{f.metodo.split("_").join(" ")}</td>
                <td>{f.esperado.toFixed(2)}</td>
                <td>
                  <input
                    className="cant-input"
                    style={{ width: 100 }}
                    type="number"
                    step="0.01"
                    value={f.contado}
                    onChange={(e) => actualizarContado(lista, f.metodo, e.target.value)}
                    placeholder="0.00"
                  />
                </td>
                <td className={diff && Math.abs(diff) > 0.01 ? "restante-pendiente" : ""}>
                  {diff === null ? "—" : diff.toFixed(2)}
                </td>
              </tr>
            );
          })}
          {filas.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Sin movimientos ese día.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="form-row">
          <label style={{ alignSelf: "center" }}>Fecha del cierre</label>
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </div>
      </div>

      <div className="venta-layout">
        <div className="card">
          <h2>Ingresos (ventas y abonos de crédito)</h2>
          {tablaFilas(ingresos, "ingresos")}
          <div className="totales">
            <span>Esperado: Bs {totalIngresoEsperado.toFixed(2)}</span>
            <strong>Contado: Bs {totalIngresoContado.toFixed(2)}</strong>
          </div>
        </div>

        <div className="card">
          <h2>Egresos (pagos a proveedores)</h2>
          {tablaFilas(egresos, "egresos")}
          <div className="totales">
            <span>Esperado: Bs {totalEgresoEsperado.toFixed(2)}</span>
            <strong>Contado: Bs {totalEgresoContado.toFixed(2)}</strong>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="totales">
          <span>Neto esperado: Bs {(totalIngresoEsperado - totalEgresoEsperado).toFixed(2)}</span>
          <strong>Neto contado: Bs {(totalIngresoContado - totalEgresoContado).toFixed(2)}</strong>
        </div>
        {mensaje && <p className="error">{mensaje}</p>}
        {guardado && <p className="hint">Cierre guardado ✅ — puedes corregirlo y guardar de nuevo si hace falta.</p>}
        <button className="cobrar-btn" onClick={guardarCierre} disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar cierre del día"}
        </button>
      </div>
    </div>
  );
}