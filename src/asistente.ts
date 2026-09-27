// Motor de conclusiones del Asistente Kax para Estadisticas.tsx — misma
// idea que el de Kaxa Móvil (lib/asistente.ts en kaxa-panel), portado acá:
// pura lógica en JS sobre los agregados que la pantalla ya calculó para
// pintar sus gráficos, sin ninguna consulta nueva a la base.
export type Consejo = {
  prioridad: "atencion" | "positivo" | "tip";
  icono: string;
  texto: string;
};

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

  const orden = { atencion: 0, positivo: 1, tip: 2 };
  return conclusiones.sort((a, b) => orden[a.prioridad] - orden[b.prioridad]);
}
