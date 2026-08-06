// Fecha y hora actual EN VENEZUELA (America/Caracas, UTC-4), sin importar en
// qué zona horaria esté configurado el sistema operativo del equipo donde
// corra la app. Todo lo que se guarda con fecha/hora (ventas, movimientos de
// inventario, facturas de compra) usa esta misma fuente — si cada tabla
// tomara su propia hora (p. ej. el DEFAULT datetime('now') de SQLite, que es
// UTC) el agrupamiento por día en Movimientos y Cuadre de caja quedaría
// desfasado varias horas respecto al resto de la app.
export function fechaHoraVenezuela(): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Caracas",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

// Solo la fecha (YYYY-MM-DD) de "hoy" en Venezuela — para valores por
// defecto de filtros de fecha (Reportes, Estadísticas, Cuadre de caja).
export function hoyVenezuela(): string {
  return fechaHoraVenezuela().slice(0, 10);
}
