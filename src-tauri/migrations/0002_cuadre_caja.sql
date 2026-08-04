-- Cuadre de caja diario: un registro por fecha + tipo (INGRESO/EGRESO) +
-- método. "monto_esperado_bs" se recalcula siempre desde ventas/cobros/pagos
-- reales; "monto_contado_bs" es lo que el empleado contó físicamente al
-- cierre. Guardar el cierre es sobre-escribible (ON CONFLICT) por si se
-- corrige el conteo el mismo día.
CREATE TABLE IF NOT EXISTS cierres_caja (
  id                 TEXT PRIMARY KEY,
  fecha              TEXT NOT NULL,  -- 'YYYY-MM-DD'
  tipo               TEXT NOT NULL,  -- INGRESO / EGRESO
  metodo             TEXT NOT NULL,
  monto_esperado_bs  REAL NOT NULL,
  monto_contado_bs   REAL NOT NULL,
  diferencia_bs      REAL NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fecha, tipo, metodo)
);
