-- El cajero puede marcar una factura de venta para que un admin la revise,
-- dejando una nota (ej. "Esta factura está duplicada por favor revisar").
-- El admin la ve en la campana de notificaciones (igual que stock
-- insuficiente, ver 0027_stock_insuficiente.sql) y la marca como resuelta
-- una vez que la revisó.
CREATE TABLE IF NOT EXISTS revisiones_factura (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  nota TEXT NOT NULL,
  usuario TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  created_at TEXT NOT NULL,
  resuelta_por TEXT,
  resuelta_en TEXT
);

CREATE INDEX IF NOT EXISTS idx_revisiones_factura_estado ON revisiones_factura(estado);
