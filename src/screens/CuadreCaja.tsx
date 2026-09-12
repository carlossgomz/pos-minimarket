import { useEffect, useState } from "react";
import { getDb } from "../db";
import { fechaHoraVenezuela } from "../fecha";
import { monedaDeMetodo, montoBsDesdeEntrada, montoNativoDesdeBs } from "../precios";
import { ConfigRow } from "../types";

const METODOS_BASE = ["PUNTO_VENTA", "BIOPAGO", "PAGO_MOVIL", "EFECTIVO", "DIVISAS", "TRANSFERENCIA"];

// "esperado" siempre viene en Bs (así se guarda en la base, sin importar la
// moneda del método — ver montoBsDesdeEntrada en precios.ts, que ya
// convierte al guardar un pago). "contado" en cambio es lo que el usuario
// ESCRIBE, en la moneda NATIVA del método (dólares para DIVISAS, bolívares
// para el resto) — así se puede contar billetes físicos sin tener que
// sacar cuentas con la tasa del día.
type Fila = { metodo: string; moneda: string; esperado: number; contado: string };

function hoyISO() {
  return fechaHoraVenezuela().slice(0, 10);
}

function armarFilas(
  esperados: Record<string, number>,
  contadosGuardadosBs: Record<string, number>,
  tasaCambioDia: number
): Fila[] {
  const metodos = new Set([...METODOS_BASE, ...Object.keys(esperados)]);
  return Array.from(metodos).map((m) => {
    const moneda = monedaDeMetodo(m);
    const contadoBsGuardado = contadosGuardadosBs[m];
    return {
      metodo: m,
      moneda,
      esperado: esperados[m] ?? 0,
      contado: contadoBsGuardado != null ? String(montoNativoDesdeBs(moneda, contadoBsGuardado, tasaCambioDia)) : "",
    };
  });
}

export default function CuadreCaja({ config }: { config: ConfigRow }) {
  const [fecha, setFecha] = useState(hoyISO());
  const [ingresos, setIngresos] = useState<Fila[]>([]);
  // Puramente informativo — de dónde sale el número de EFECTIVO en
  // "ingresos" (ver más abajo por qué se resta ahí y no en una tarjeta
  // aparte). No tiene "contado" propio: la caja física es una sola, no
  // tiene sentido pedir el conteo dos veces.
  const [aporteCapitalExterno, setAporteCapitalExterno] = useState(0);
  const [avanceEfectivo, setAvanceEfectivo] = useState(0);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const tasa = config.tasa_cambio_dia;

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
    // DESCUENTO_NOMINA: el crédito se saldó descontándolo del sueldo del
    // empleado, no con ningún método de pago de la tienda — no entró (ni
    // salió) plata de la caja física, así que no debe sumar acá. Mismo
    // criterio que ya se usa arriba con 'CREDITO' en pagos.
    const porCobroCredito = await db.select<{ metodo: string | null; monto: number }[]>(
      `SELECT metodo, SUM(monto_bs) as monto FROM cobros_cliente
       WHERE date(created_at) = $1 AND metodo != 'DESCUENTO_NOMINA'
       GROUP BY metodo`,
      [fecha]
    );
    // Avances de efectivo: lo cobrado por el método usado es un ingreso
    // real (sube ese método). El efectivo entregado sale de la caja física
    // SIEMPRE, sin importar si ese efectivo venía de las ventas del día o
    // de un aporte de capital externo — ambos casos son plata que estaba
    // físicamente en la caja. Por eso un aporte de capital externo también
    // cuenta como un ingreso de EFECTIVO (entró a la misma caja) y todo
    // avance (sea cual sea su fuente) cuenta como egreso de EFECTIVO.
    const porAvanceCobro = await db.select<{ metodo_cobro: string; monto: number }[]>(
      `SELECT metodo_cobro, SUM(monto_cobrado_bs) as monto FROM avances_efectivo WHERE date(created_at) = $1 GROUP BY metodo_cobro`,
      [fecha]
    );
    const porAvanceEfectivo = await db.select<{ monto: number | null }[]>(
      `SELECT SUM(monto_efectivo_bs) as monto FROM avances_efectivo WHERE date(created_at) = $1`,
      [fecha]
    );
    const porAporteCapitalExterno = await db.select<{ monto: number | null }[]>(
      `SELECT SUM(monto_bs) as monto FROM aportes_capital_externo WHERE date(created_at) = $1`,
      [fecha]
    );

    const esperadosIngreso: Record<string, number> = {};
    for (const r of porVenta) esperadosIngreso[r.metodo] = (esperadosIngreso[r.metodo] ?? 0) + r.monto;
    for (const r of porCobroCredito) {
      const m = r.metodo ?? "SIN_ESPECIFICAR";
      esperadosIngreso[m] = (esperadosIngreso[m] ?? 0) + r.monto;
    }
    for (const r of porAvanceCobro) {
      esperadosIngreso[r.metodo_cobro] = (esperadosIngreso[r.metodo_cobro] ?? 0) + r.monto;
    }
    // El EFECTIVO esperado es UN solo número neto — la caja física es una
    // sola, así que solo tiene sentido una casilla de "contado" para
    // efectivo, no dos repartidas en tarjetas distintas (eso fue lo que
    // confundía antes: se veían 1000 acá y 300 aparte, y nunca se
    // combinaban en un "700" visible en ningún lado). Un aporte de capital
    // externo suma (entra a la misma caja) y un avance entregado resta
    // (sale de la misma caja), sin importar su fuente — ver el desglose
    // que se muestra junto al renglón de EFECTIVO más abajo.
    const aporteCapitalExterno = porAporteCapitalExterno[0]?.monto ?? 0;
    const avanceEfectivo = porAvanceEfectivo[0]?.monto ?? 0;
    if (aporteCapitalExterno > 0 || avanceEfectivo > 0) {
      esperadosIngreso.EFECTIVO = (esperadosIngreso.EFECTIVO ?? 0) + aporteCapitalExterno - avanceEfectivo;
    }
    setAporteCapitalExterno(aporteCapitalExterno);
    setAvanceEfectivo(avanceEfectivo);

    const guardados = await db.select<{ tipo: string; metodo: string; monto_contado_bs: number }[]>(
      `SELECT tipo, metodo, monto_contado_bs FROM cierres_caja WHERE fecha = $1 AND tipo = 'INGRESO'`,
      [fecha]
    );
    const contadosIngresoBs: Record<string, number> = {};
    for (const g of guardados) contadosIngresoBs[g.metodo] = g.monto_contado_bs;

    setIngresos(armarFilas(esperadosIngreso, contadosIngresoBs, tasa));
  }

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fecha]);

  // Solo el cierre del día actual se puede editar — uno de días anteriores
  // ya se cerró contablemente, corregirlo a posteriori podría desmentir un
  // arqueo que ya se dio por bueno (y en el peor caso, uno que el dueño ya
  // revisó). Se compara contra la fecha de Venezuela, no la del sistema
  // operativo, igual que el resto de la app.
  const esHoy = fecha === hoyISO();

  function actualizarContado(metodo: string, valor: string) {
    if (!esHoy) return;
    setIngresos((prev) => prev.map((f) => (f.metodo === metodo ? { ...f, contado: valor } : f)));
    setGuardado(false);
  }

  async function guardarCierre() {
    if (!esHoy) return;
    setGuardando(true);
    setMensaje(null);
    const db = await getDb();
    try {
      // Cada fila es un UPSERT independiente por (fecha, tipo, metodo) — no
      // hace falta envolver esto en BEGIN/COMMIT (cada db.execute() abre su
      // propia conexión contra Turso, así que un BEGIN/COMMIT suelto entre
      // llamadas separadas no hace nada real: por eso el botón se quedaba
      // trabado en "Guardando…", el COMMIT fallaba sin transacción activa
      // y el ROLLBACK del catch fallaba también, sin llegar nunca a
      // setGuardando(false)).
      for (const f of ingresos) {
        // Lo escrito está en la moneda nativa del método — se convierte a
        // Bs para guardar (cierres_caja siempre guarda en Bs) y para
        // calcular la diferencia contra "esperado" (que también está en
        // Bs).
        const contadoBs = montoBsDesdeEntrada(f.moneda, Number(f.contado || "0"), tasa);
        const diferencia = contadoBs - f.esperado;
        await db.execute(
          `INSERT INTO cierres_caja (id, fecha, tipo, metodo, monto_esperado_bs, monto_contado_bs, diferencia_bs)
           VALUES ($1,$2,'INGRESO',$3,$4,$5,$6)
           ON CONFLICT(fecha, tipo, metodo) DO UPDATE SET
             monto_esperado_bs = excluded.monto_esperado_bs,
             monto_contado_bs = excluded.monto_contado_bs,
             diferencia_bs = excluded.diferencia_bs`,
          [crypto.randomUUID(), fecha, f.metodo, f.esperado, contadoBs, diferencia]
        );
      }
    } catch (e) {
      setMensaje(`No se pudo guardar el cierre: ${String(e)}`);
      setGuardando(false);
      return;
    }
    setGuardando(false);
    setGuardado(true);
  }

  // Bs y USD se calculan aparte (no tiene sentido sumar "5000" de pago
  // móvil con "10" de divisas como si fueran la misma moneda — ese era
  // justo el bug reportado). "en bolívares" es el total de verdad, todo
  // convertido a una sola moneda con la tasa del día.
  const filasBs = ingresos.filter((f) => f.moneda !== "USD");
  const filasUsd = ingresos.filter((f) => f.moneda === "USD");
  const totalEsperadoBs = filasBs.reduce((a, f) => a + f.esperado, 0);
  const totalEsperadoUsdNativo = filasUsd.reduce((a, f) => a + montoNativoDesdeBs("USD", f.esperado, tasa), 0);
  const totalEsperadoBolivares = ingresos.reduce((a, f) => a + f.esperado, 0);

  const totalContadoBsNativo = filasBs.reduce((a, f) => a + Number(f.contado || "0"), 0);
  const totalContadoUsdNativo = filasUsd.reduce((a, f) => a + Number(f.contado || "0"), 0);
  const totalContadoBolivares = ingresos.reduce(
    (a, f) => a + montoBsDesdeEntrada(f.moneda, Number(f.contado || "0"), tasa),
    0
  );

  function tablaFilas(filas: Fila[]) {
    return (
      <table>
        <thead>
          <tr>
            <th>Método</th>
            <th>Esperado</th>
            <th>Contado</th>
            <th>Diferencia</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => {
            const simbolo = f.moneda === "USD" ? "$" : "Bs";
            const esperadoNativo = montoNativoDesdeBs(f.moneda, f.esperado, tasa);
            const contadoNum = Number(f.contado || "0");
            const diff = f.contado === "" ? null : contadoNum - esperadoNativo;
            return (
              <tr key={f.metodo}>
                <td>{f.metodo.split("_").join(" ")}</td>
                <td>
                  {simbolo} {esperadoNativo.toFixed(2)}
                </td>
                <td>
                  <input
                    className="cant-input"
                    style={{ width: 100 }}
                    type="number"
                    step="0.01"
                    value={f.contado}
                    onChange={(e) => actualizarContado(f.metodo, e.target.value)}
                    placeholder={`0.00 ${simbolo}`}
                    disabled={!esHoy}
                  />
                </td>
                <td className={diff && Math.abs(diff) > 0.01 ? "restante-pendiente" : ""}>
                  {diff === null ? "—" : `${simbolo} ${diff.toFixed(2)}`}
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

      <div className="card">
        <h2>Ingresos (ventas y abonos de crédito)</h2>
        <p className="hint">
          Los pagos a proveedores no entran acá — es un flujo aparte del efectivo/pagos de la
          tienda (ver Cuentas → Por pagar).
        </p>
        {(aporteCapitalExterno > 0 || avanceEfectivo > 0) && (
          <p className="hint">
            El renglón de EFECTIVO ya incluye los avances del día: +Bs {aporteCapitalExterno.toFixed(2)}{" "}
            de aportes de capital externo (entra a la caja) − Bs {avanceEfectivo.toFixed(2)} entregados
            en avances (sale de la caja). Lo cobrado a cambio de cada avance (por otro método) está
            sumado en su propia fila más abajo.
          </p>
        )}
        {tablaFilas(ingresos)}
        <div className="totales" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <div className="form-row" style={{ justifyContent: "space-between" }}>
            <span>Total esperado en Bs: Bs {totalEsperadoBs.toFixed(2)}</span>
            <span>Total contado en Bs: Bs {totalContadoBsNativo.toFixed(2)}</span>
          </div>
          {filasUsd.length > 0 && (
            <div className="form-row" style={{ justifyContent: "space-between" }}>
              <span>Total esperado en $: $ {totalEsperadoUsdNativo.toFixed(2)}</span>
              <span>Total contado en $: $ {totalContadoUsdNativo.toFixed(2)}</span>
            </div>
          )}
          <div className="form-row" style={{ justifyContent: "space-between" }}>
            <strong>Total estimado en bolívares: Bs {totalEsperadoBolivares.toFixed(2)}</strong>
            <strong>Total contado en bolívares: Bs {totalContadoBolivares.toFixed(2)}</strong>
          </div>
        </div>
      </div>

      <div className="card">
        {!esHoy && (
          <p className="hint" style={{ marginTop: 0 }}>
            🔒 Este cierre ya pasó — solo se puede ver, no editar. Volvé a la fecha de hoy para cargar
            el conteo del día.
          </p>
        )}
        {mensaje && (
          <p className="error" style={{ marginTop: 10 }}>
            {mensaje}
          </p>
        )}
        {guardado && (
          <p className="hint" style={{ marginTop: 10 }}>
            Cierre guardado ✅ — puedes corregirlo y guardar de nuevo si hace falta.
          </p>
        )}
        {esHoy && (
          <button className="cobrar-btn" onClick={guardarCierre} disabled={guardando}>
            {guardando ? "Guardando…" : "Guardar cierre del día"}
          </button>
        )}
      </div>
    </div>
  );
}
