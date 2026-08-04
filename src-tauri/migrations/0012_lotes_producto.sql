CREATE TABLE IF NOT EXISTS lotes_producto (
  id                 TEXT PRIMARY KEY,
  producto_id        TEXT NOT NULL REFERENCES productos(id),
  costo_unitario_usd REAL NOT NULL,
  margen_porcentaje  REAL NOT NULL,
  cantidad_inicial   REAL NOT NULL,
  cantidad_restante  REAL NOT NULL,
  factura_compra_id  TEXT REFERENCES facturas_compra(id),
  creado_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lotes_producto_fifo ON lotes_producto(producto_id, creado_at);
