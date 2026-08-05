-- Avance de efectivo: el cliente pide efectivo (ej. Bs 300) y se le cobra
-- un monto mayor (ej. Bs 330) por punto de venta/biopago/etc. — la
-- diferencia es la comisión del negocio. Esto afecta el cuadre de caja de
-- dos formas: sube el "esperado" del método con el que se cobró, y baja el
-- "esperado" de EFECTIVO — siempre, sin importar fuente_efectivo, porque el
-- billete sale de la caja física en cualquiera de los dos casos. Cuando la
-- fuente es capital externo, el aporte que lo financió (ver
-- aportes_capital_externo, migración 0017) también entró a esa misma caja
-- como efectivo, así que también suma al esperado de EFECTIVO.
-- fuente_efectivo solo sirve para llevar el saldo del fondo de capital
-- externo, no para decidir si el avance afecta el cuadre.
CREATE TABLE IF NOT EXISTS avances_efectivo (
  id                TEXT PRIMARY KEY,
  fecha_hora        TEXT NOT NULL DEFAULT (datetime('now')),
  monto_efectivo_bs REAL NOT NULL,
  monto_cobrado_bs  REAL NOT NULL,
  metodo_cobro      TEXT NOT NULL,  -- PUNTO_VENTA / BIOPAGO / PAGO_MOVIL / TRANSFERENCIA
  fuente_efectivo   TEXT NOT NULL,  -- CAJA / CAPITAL_EXTERIOR
  referencia        TEXT,
  usuario           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avances_efectivo_fecha ON avances_efectivo(created_at);
