// Gráficos compartidos por Reportes.tsx y Estadisticas.tsx — mismo
// tratamiento visual que ya se le dio a Kaxa Móvil (torta con
// conic-gradient, barras horizontales de colores) en vez de listas de
// números. Paleta validada con el validador de accesibilidad del skill de
// dataviz (contraste y separación para daltonismo, en claro y oscuro).
export const COLORES = ["#16A37C", "#C9820B", "#3B82F6", "#EC4899", "#8B5CF6", "#EF4444"];

function fondoTorta(datos: { valor: number }[]): string {
  const total = datos.reduce((a, d) => a + d.valor, 0) || 1;
  let acumulado = 0;
  const tramos = datos.map((d, i) => {
    const inicio = (acumulado / total) * 100;
    acumulado += d.valor;
    const fin = (acumulado / total) * 100;
    return `${COLORES[i % COLORES.length]} ${inicio}% ${fin}%`;
  });
  return `conic-gradient(${tramos.join(", ")})`;
}

export function GraficoTorta({ datos }: { datos: { etiqueta: string; valor: number }[] }) {
  const total = datos.reduce((a, d) => a + d.valor, 0);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ width: 96, height: 96, borderRadius: "50%", flexShrink: 0, background: fondoTorta(datos) }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        {datos.map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0, background: COLORES[i % COLORES.length] }} />
            <span style={{ color: "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {d.etiqueta}
            </span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{total > 0 ? Math.round((d.valor / total) * 100) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Barra horizontal con relleno proporcional al máximo de la lista.
export function BarraHorizontal({
  etiqueta,
  valor,
  max,
  color,
  sufijo,
}: {
  etiqueta: string;
  valor: number;
  max: number;
  color: string;
  sufijo: string;
}) {
  const pct = max > 0 ? Math.max(4, (valor / max) * 100) : 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {etiqueta}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{sufijo}</span>
      </div>
      <div style={{ height: 10, borderRadius: 5, background: "var(--border-subtle)", overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 5, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// Histograma de las 24 horas del día — misma idea que en Kaxa Móvil.
export function HistogramaHoras({ horas24, horaPico }: { horas24: { hora: string; num_ventas: number }[]; horaPico: string }) {
  const max = Math.max(1, ...horas24.map((h) => h.num_ventas));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 90 }}>
        {horas24.map((h) => (
          <div key={h.hora} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end" }}>
            <div
              style={{
                width: "100%",
                borderRadius: "3px 3px 0 0",
                height: `${Math.max(3, (h.num_ventas / max) * 100)}%`,
                background: h.hora === horaPico ? "var(--accent)" : "var(--accent-soft-bg)",
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-secondary)", marginTop: 4 }}>
        <span>12am</span>
        <span>6am</span>
        <span>12pm</span>
        <span>6pm</span>
        <span>11pm</span>
      </div>
    </div>
  );
}
