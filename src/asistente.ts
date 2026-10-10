import { getDb } from "./db";
import { hoyVenezuela } from "./fecha";

// Motor de conclusiones del Asistente Kax para Estadisticas.tsx — misma
// idea que el de Kaxa Móvil (lib/asistente.ts en kaxa-panel), portado acá:
// pura lógica en JS sobre los agregados que la pantalla ya calculó para
// pintar sus gráficos, sin ninguna consulta nueva a la base.
export type Consejo = {
  prioridad: "urgente" | "atencion" | "positivo" | "tip";
  icono: string;
  texto: string;
  // A dónde navegar si el usuario le hace clic — solo lo tienen los
  // consejos de obtenerConsejosGenerales (mascota fija), no los de
  // Estadísticas/Reportes (esos ya están parados en la pantalla que
  // describen). Ver AsistenteLateral.tsx.
  destino?: DestinoConsejo;
};

export type DestinoConsejo = "cuentas-cobrar" | "cuentas-pagar" | "inventario";

export type DatosEstadisticas = {
  totalBs: number;
  gananciaBs: number;
  numVentas: number;
  metodosPago: { metodo: string; monto_bs: number }[];
  productosPorCantidad: { nombre: string; cantidad: number }[];
  categorias: { categoria: string; monto_bs: number }[];
  clientesFrecuentes: { nombre: string; num_compras: number; total_gastado_bs: number }[];
  horaPicoTop: { hora: string; num_ventas: number };
};

export function obtenerConclusiones(datos: DatosEstadisticas): Consejo[] {
  const conclusiones: Consejo[] = [];
  if (datos.numVentas === 0) return conclusiones;

  const margenPct = datos.totalBs > 0 ? (datos.gananciaBs / datos.totalBs) * 100 : 0;
  if (margenPct < 15) {
    conclusiones.push({
      prioridad: "atencion",
      icono: "⚠️",
      texto: `Tu margen general en este período fue de solo ${margenPct.toFixed(0)}% — vale la pena revisar precios o costos.`,
    });
  } else if (margenPct > 35) {
    conclusiones.push({
      prioridad: "positivo",
      icono: "💰",
      texto: `Buen margen este período: ${margenPct.toFixed(0)}% — vas ganando bien por cada venta.`,
    });
  }

  const totalMetodos = datos.metodosPago.reduce((a, m) => a + m.monto_bs, 0);
  const topMetodo = datos.metodosPago[0];
  if (topMetodo && totalMetodos > 0) {
    const pct = (topMetodo.monto_bs / totalMetodos) * 100;
    if (pct >= 50) {
      conclusiones.push({
        prioridad: "atencion",
        icono: "💳",
        texto: `El ${pct.toFixed(0)}% de tus ventas en este período fueron por ${topMetodo.metodo.split("_").join(" ")} — conviene tener un plan B si ese método falla algún día.`,
      });
    }
  }

  if (datos.productosPorCantidad.length >= 2) {
    const [primero, segundo] = datos.productosPorCantidad;
    if (primero.cantidad >= segundo.cantidad * 1.5) {
      conclusiones.push({
        prioridad: "positivo",
        icono: "🏆",
        texto: `"${primero.nombre}" fue tu producto más vendido, muy por delante del resto (${primero.cantidad} vendidos).`,
      });
    }
  } else if (datos.productosPorCantidad.length === 1) {
    conclusiones.push({
      prioridad: "positivo",
      icono: "🏆",
      texto: `"${datos.productosPorCantidad[0].nombre}" fue el único producto destacado este período, con ${datos.productosPorCantidad[0].cantidad} vendidos.`,
    });
  }

  const totalCategorias = datos.categorias.reduce((a, c) => a + c.monto_bs, 0);
  const topCategoria = datos.categorias[0];
  if (topCategoria && totalCategorias > 0) {
    const pct = (topCategoria.monto_bs / totalCategorias) * 100;
    if (pct >= 40) {
      conclusiones.push({
        prioridad: "tip",
        icono: "🍰",
        texto: `La categoría "${topCategoria.categoria}" representó el ${pct.toFixed(0)}% de lo vendido entre tus categorías top de este período.`,
      });
    }
  }

  if (datos.horaPicoTop.num_ventas > 0) {
    conclusiones.push({
      prioridad: "tip",
      icono: "⏰",
      texto: `La mayoría de tus ventas se concentran cerca de las ${datos.horaPicoTop.hora}:00 — asegúrate de tener suficiente apoyo en ese horario.`,
    });
  }

  const topCliente = datos.clientesFrecuentes[0];
  if (topCliente && topCliente.num_compras >= 3) {
    conclusiones.push({
      prioridad: "tip",
      icono: "🧑‍🤝‍🧑",
      texto: `${topCliente.nombre} fue tu cliente más frecuente, con ${topCliente.num_compras} compras por Bs ${topCliente.total_gastado_bs.toLocaleString("es-VE", { maximumFractionDigits: 0 })}.`,
    });
  }

  const orden = { urgente: -1, atencion: 0, positivo: 1, tip: 2 };
  return conclusiones.sort((a, b) => orden[a.prioridad] - orden[b.prioridad]);
}

// Consejos generales del negocio, sin depender de ningún dato — para que
// la mascota siempre tenga algo que decir, incluso un día tranquilo sin
// alertas ni récords. Rota por día (mismo consejo todo el día, cambia al
// día siguiente) en vez de ser aleatorio en cada carga. Mismo texto que en
// Kaxa Móvil (lib/asistente.ts de kaxa-panel).
const TIPS_GENERALES = [
  "Revisa tu stock una vez por semana — te ahorra sorpresas de última hora.",
  "Un cliente que vuelve vale más que uno nuevo: trátalo bien y va a volver.",
  "Los costos cambian rápido — compara precios con tus proveedores de vez en cuando.",
  "Mientras más métodos de pago aceptes, menos ventas se te van por no tener cómo cobrar.",
  "Un inventario ordenado hace que cobrar sea más rápido, sobre todo en horas pico.",
  "Vale la pena destacar tus productos de mayor margen — no todos generan lo mismo.",
  "Cierra la caja todos los días, aunque sea rápido — evita sustos más adelante.",
  "Escuchar lo que piden tus clientes es la mejor forma de saber qué traer nuevo.",
  "Un cliente fiado que paga a tiempo es un cliente que vale la pena cuidar.",
  "Revisar tus reportes cada semana ayuda a notar cambios antes de que sean un problema.",
];

function tipDelDia(): string {
  const diaDelAnio = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000);
  return TIPS_GENERALES[diaDelAnio % TIPS_GENERALES.length];
}

const UMBRAL_DIAS_CREDITO = 15;
const UMBRAL_DIAS_FACTURA = 15;
const UMBRAL_MARGEN_PCT = 10; // por debajo de esto (o negativo) se avisa
const UMBRAL_DIAS_SIN_MOVIMIENTO = 30;
const UMBRAL_CAPITAL_ESTANCADO_USD = 15;

// Los productos por peso guardan el stock con decimales de punto flotante
// (ej. 4.562000000000003 kg) — se redondea a 2 decimales y se quitan los
// ceros sobrantes para mostrar algo legible.
function formatoUnidades(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// Mismo criterio que diasTranscurridos en Cuentas.tsx: fecha_hora se
// guarda en hora LOCAL (fechaHoraVenezuela), y new Date() sobre esa cadena
// la interpreta como hora local del propio equipo — funciona porque las
// PCs de la tienda están en huso horario de Venezuela.
function diasDesde(fecha: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(fecha).getTime()) / 86_400_000));
}

function fechaISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function hoyComoDate(): Date {
  return new Date(`${hoyVenezuela()}T12:00:00`);
}
function restarDias(fecha: Date, dias: number): Date {
  const d = new Date(fecha);
  d.setDate(d.getDate() - dias);
  return d;
}
function primerDiaMes(offsetMeses: number): string {
  const d = hoyComoDate();
  d.setMonth(d.getMonth() + offsetMeses, 1);
  return fechaISO(d);
}

// El "Asistente Kax" fijo del lado izquierdo del programa (ver
// AsistenteLateral.tsx) — misma idea que "Inicio" en Kaxa Móvil
// (obtenerConsejos de kaxa-panel/lib/asistente.ts), portado acá: reglas
// simples con umbrales sobre los datos del propio negocio, nada de IA ni
// costo por mensaje. A diferencia de la versión de Kaxa Móvil, acá no hay
// rutas de Next.js — cada consejo carga un "destino" (pestaña del programa)
// que App.tsx traduce a un cambio de pestaña real al hacer clic.
export async function obtenerConsejosGenerales(esAdmin: boolean, tasa: number): Promise<Consejo[]> {
  const db = await getDb();
  const consejos: Consejo[] = [];

  // 1. Crédito de cliente pendiente hace muchos días (todos los roles: Cobrar
  // es una sección que también usa el cajero).
  const creditoViejo = await db.select<{ cliente_nombre: string; fecha_mas_vieja: string; total_pendiente_usd: number }[]>(
    `SELECT v.cliente_nombre, MIN(v.fecha_hora) as fecha_mas_vieja, SUM(v.monto_pendiente_usd) as total_pendiente_usd
     FROM ventas v WHERE v.estado = 'CREDITO_PENDIENTE'
     GROUP BY v.cliente_cedula ORDER BY fecha_mas_vieja ASC LIMIT 1`
  );
  const filaCredito = creditoViejo[0];
  if (filaCredito) {
    const dias = diasDesde(filaCredito.fecha_mas_vieja);
    if (dias >= UMBRAL_DIAS_CREDITO) {
      consejos.push({
        prioridad: "urgente",
        icono: "💵",
        texto: `${filaCredito.cliente_nombre} te debe USD ${filaCredito.total_pendiente_usd.toFixed(2)} desde hace ${dias} días — quizás valga la pena recordarle.`,
        destino: "cuentas-cobrar",
      });
    }
  }

  if (esAdmin) {
    // 2. Factura de proveedor pendiente hace muchos días.
    const facturaVieja = await db.select<{ proveedor_nombre: string; numero_factura: string; fecha: string; saldo_usd: number }[]>(
      `SELECT pr.nombre as proveedor_nombre, fc.numero_factura, fc.fecha, (fc.monto_total_usd - fc.monto_pagado_usd) as saldo_usd
       FROM facturas_compra fc JOIN proveedores pr ON pr.id = fc.proveedor_id
       WHERE fc.estado != 'PAGADA' ORDER BY fc.fecha ASC LIMIT 1`
    );
    const filaFactura = facturaVieja[0];
    if (filaFactura) {
      const dias = diasDesde(filaFactura.fecha);
      if (dias >= UMBRAL_DIAS_FACTURA) {
        consejos.push({
          prioridad: "urgente",
          icono: "📦",
          texto: `La factura ${filaFactura.numero_factura} de ${filaFactura.proveedor_nombre} lleva ${dias} días sin pagarse (saldo USD ${filaFactura.saldo_usd.toFixed(2)}).`,
          destino: "cuentas-pagar",
        });
      }
    }

    // 3. Margen casi nulo o negativo — el costo subió (nueva compra a mayor
    // precio) y el precio de venta se quedó atrás, algo muy común cuando el
    // dólar se mueve seguido. Se compara contra la tasa de HOY, no la de
    // cuando se fijó el precio.
    const margenBajo = await db.select<{ nombre: string; margen_bs: number; costo_bs: number }[]>(
      `SELECT p.nombre, p.precio_venta_bs - p.costo_actual_usd * $1 as margen_bs, p.costo_actual_usd * $1 as costo_bs
       FROM productos p
       WHERE p.activo = 1 AND p.uso_interno = 0 AND p.costo_actual_usd > 0 AND p.precio_venta_bs > 0
       ORDER BY (p.precio_venta_bs - p.costo_actual_usd * $1) / (p.costo_actual_usd * $1) ASC
       LIMIT 1`,
      [tasa]
    );
    const filaMargen = margenBajo[0];
    if (filaMargen) {
      const margenPct = filaMargen.costo_bs > 0 ? (filaMargen.margen_bs / filaMargen.costo_bs) * 100 : 100;
      if (margenPct < UMBRAL_MARGEN_PCT) {
        consejos.push({
          prioridad: "atencion",
          icono: margenPct < 0 ? "🆘" : "⚠️",
          texto:
            margenPct < 0
              ? `"${filaMargen.nombre}" se está vendiendo por debajo de su costo actual — revisa su precio.`
              : `"${filaMargen.nombre}" apenas deja margen (${margenPct.toFixed(0)}%) al costo de hoy — capaz conviene subirle el precio.`,
          destino: "inventario",
        });
      }
    }

    // 4. Producto que vende bien y tiene poco stock (según SU propio
    // stock_minimo configurado, no un número inventado).
    const hace30dias = fechaISO(restarDias(hoyComoDate(), 30));
    const pocoStock = await db.select<{ nombre: string; stock_actual: number; ganancia_30d_bs: number }[]>(
      `SELECT p.nombre, p.stock_actual,
              SUM(vi.cantidad * (vi.precio_unit_bs - p.costo_actual_usd * v.tasa_cambio_dia)) as ganancia_30d_bs
       FROM productos p
       JOIN venta_items vi ON vi.producto_id = p.id
       JOIN ventas v ON v.id = vi.venta_id
       WHERE p.activo = 1 AND p.uso_interno = 0 AND p.ignora_alerta_stock = 0 AND p.stock_minimo > 0 AND p.stock_actual <= p.stock_minimo
         AND v.fecha_hora >= $1
       GROUP BY p.id ORDER BY ganancia_30d_bs DESC LIMIT 1`,
      [hace30dias]
    );
    const filaPocoStock = pocoStock[0];
    if (filaPocoStock) {
      consejos.push({
        prioridad: "atencion",
        icono: "📉",
        texto: `"${filaPocoStock.nombre}" queda en ${formatoUnidades(filaPocoStock.stock_actual)} unidades y en el último mes generó Bs ${filaPocoStock.ganancia_30d_bs.toLocaleString("es-VE", { maximumFractionDigits: 0 })} de ganancia — vale la pena reponerlo pronto.`,
        destino: "inventario",
      });
    }

    // 5. Stock muerto: capital importante parado en un producto que no se
    // mueve hace tiempo.
    const stockMuerto = await db.select<{ nombre: string; stock_actual: number; capital_usd: number }[]>(
      `SELECT p.nombre, p.stock_actual, p.stock_actual * p.costo_actual_usd as capital_usd
       FROM productos p
       WHERE p.activo = 1 AND p.uso_interno = 0 AND p.ignora_alerta_stock = 0 AND p.stock_actual > 0
         AND p.created_at <= $1
         AND NOT EXISTS (
           SELECT 1 FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
           WHERE vi.producto_id = p.id AND v.fecha_hora >= $1
         )
       ORDER BY capital_usd DESC LIMIT 1`,
      [hace30dias]
    );
    const filaMuerto = stockMuerto[0];
    if (filaMuerto && filaMuerto.capital_usd >= UMBRAL_CAPITAL_ESTANCADO_USD) {
      consejos.push({
        prioridad: "atencion",
        icono: "🐌",
        texto: `"${filaMuerto.nombre}" tiene ${formatoUnidades(filaMuerto.stock_actual)} unidades sin venderse hace más de ${UMBRAL_DIAS_SIN_MOVIMIENTO} días (USD ${filaMuerto.capital_usd.toFixed(2)} parados ahí) — quizás una promoción lo mueva.`,
        destino: "inventario",
      });
    }
  }

  // 6, 7, 8. Buenas noticias — hoy-vs-ayer, semana-vs-semana-anterior y
  // mes-vs-mes-anterior, todo en una sola consulta (misma idea de Kaxa
  // Móvil, pero sin repetir 6 consultas separadas).
  const hoy = hoyVenezuela();
  // mañana (límite superior de "hoy") en vez de date(fecha_hora) = hoy — ver
  // el comentario grande más abajo sobre por qué todas estas comparaciones
  // pasaron a ser por rango sobre la columna cruda.
  const mañana = fechaISO(restarDias(hoyComoDate(), -1));
  const ayer = fechaISO(restarDias(hoyComoDate(), 1));
  const semanaInicio = fechaISO(restarDias(hoyComoDate(), 6));
  const semanaAnteriorInicio = fechaISO(restarDias(hoyComoDate(), 13));
  const mesInicio = primerDiaMes(0);
  const mesAnteriorInicio = primerDiaMes(-1);
  // "fecha_hora >= X" en vez de "date(fecha_hora) >= X": envolver la columna
  // en date() le impide a SQLite/Turso usar el índice idx_ventas_fecha_hora
  // (no puede usar un índice normal para resolver una comparación sobre el
  // RESULTADO de una función aplicada a la columna) — así que esta consulta
  // escaneaba la tabla ventas COMPLETA cada 5 minutos en cada PC abierta, y
  // Turso cuenta filas escaneadas, no devueltas. fecha_hora guarda
  // "AAAA-MM-DD HH:MM:SS" (ver fechaHoraVenezuela en fecha.ts), así que un
  // rango de cadenas [X, X+1dia) da exactamente lo mismo que date(.) = X,
  // sin perder el índice.
  const [periodos] = await db.select<
    { hoy_bs: number; ayer_bs: number; semana_bs: number; semana_anterior_bs: number; mes_bs: number; mes_anterior_bs: number }[]
  >(
    `SELECT
       SUM(CASE WHEN fecha_hora >= $1 AND fecha_hora < $2 THEN total_bs ELSE 0 END) as hoy_bs,
       SUM(CASE WHEN fecha_hora >= $3 AND fecha_hora < $1 THEN total_bs ELSE 0 END) as ayer_bs,
       SUM(CASE WHEN fecha_hora >= $4 THEN total_bs ELSE 0 END) as semana_bs,
       SUM(CASE WHEN fecha_hora >= $5 AND fecha_hora < $4 THEN total_bs ELSE 0 END) as semana_anterior_bs,
       SUM(CASE WHEN fecha_hora >= $6 THEN total_bs ELSE 0 END) as mes_bs,
       SUM(CASE WHEN fecha_hora >= $7 AND fecha_hora < $6 THEN total_bs ELSE 0 END) as mes_anterior_bs
     FROM ventas
     WHERE fecha_hora >= $7`,
    [hoy, mañana, ayer, semanaInicio, semanaAnteriorInicio, mesInicio, mesAnteriorInicio]
  );
  if (periodos) {
    const { hoy_bs, ayer_bs, semana_bs, semana_anterior_bs, mes_bs, mes_anterior_bs } = periodos;
    if (hoy_bs > 0 && ayer_bs > 0 && hoy_bs > ayer_bs * 1.05) {
      const mejora = Math.round((hoy_bs / ayer_bs - 1) * 100);
      consejos.push({
        prioridad: "positivo",
        icono: "🚀",
        texto: `¡Hoy vendiste más que ayer! Bs ${hoy_bs.toLocaleString("es-VE", { maximumFractionDigits: 0 })} (+${mejora}%) — así se hace.`,
      });
    }
    if (semana_bs > 0 && semana_anterior_bs > 0 && semana_bs > semana_anterior_bs * 1.1) {
      const mejora = Math.round((semana_bs / semana_anterior_bs - 1) * 100);
      consejos.push({
        prioridad: "positivo",
        icono: "📅",
        texto: `Esta semana vas ${mejora}% mejor que la anterior — vas por buen camino.`,
      });
    }
    if (mes_bs > 0 && mes_anterior_bs > 0 && mes_bs > mes_anterior_bs * 1.1) {
      const mejora = Math.round((mes_bs / mes_anterior_bs - 1) * 100);
      consejos.push({
        prioridad: "positivo",
        icono: "🗓️",
        texto: `Este mes va ${mejora}% mejor que el pasado — sigue así.`,
      });
    }
  }

  // 9. Consejo general del día — siempre presente, para que el asistente
  // nunca se quede callado en un día sin nada especial que avisar.
  consejos.push({ prioridad: "tip", icono: "💡", texto: tipDelDia() });

  const orden = { urgente: 0, atencion: 1, positivo: 2, tip: 3 };
  return consejos.sort((a, b) => orden[a.prioridad] - orden[b.prioridad]);
}
