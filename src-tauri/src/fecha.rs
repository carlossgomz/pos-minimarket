// Fecha/hora en Venezuela (America/Caracas, UTC-4 fijo, sin horario de
// verano), para usar en cualquier INSERT hecho desde Rust — el DEFAULT
// (datetime('now')) de SQLite es UTC, así que una fila creada sin pasarle
// esta hora explícita queda desfasada 4 horas: cualquier pago o movimiento
// hecho entre las 8:00pm y la medianoche (hora Venezuela) cae en la fecha
// SIGUIENTE al agruparse por date(created_at) en Cuadre de Caja/Reportes.
// Mismo formato que fechaHoraVenezuela() en src/fecha.ts — las dos deben
// coincidir siempre.
use chrono::{FixedOffset, Utc};

pub fn ahora_venezuela() -> String {
    let venezuela = FixedOffset::west_opt(4 * 3600).expect("offset fijo válido");
    Utc::now().with_timezone(&venezuela).format("%Y-%m-%d %H:%M:%S").to_string()
}
