-- listar_ventas_stock_pendiente (ver comandos.rs) corre cada 20s en CADA PC
-- abierta y filtra WHERE stock_insuficiente = 1 AND revisado_admin = 0 sobre
-- venta_items — sin índice, Turso escanea la tabla ENTERA cada vez (y
-- Turso cuenta filas escaneadas, no devueltas). Es el gasto más grande de
-- "rows read" del plan gratis. Parcial porque el caso filtrado es siempre
-- una fracción chiquita de la tabla (la inmensa mayoría de las líneas de
-- venta nunca tuvo problema de stock) — así el índice se queda chico sin
-- importar cuánto crezca venta_items con el historial.
CREATE INDEX IF NOT EXISTS idx_venta_items_stock_pendiente
  ON venta_items(venta_id) WHERE stock_insuficiente = 1 AND revisado_admin = 0;
