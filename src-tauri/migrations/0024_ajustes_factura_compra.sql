-- Ajuste del monto total de una factura de proveedor después de creada —
-- para cuando lo que realmente se termina pagando es distinto al total
-- original (ej. se devolvió un producto, o el proveedor aplicó un
-- descuento a último momento). Sin esto, la factura queda "pendiente" para
-- siempre por una diferencia que en realidad ya no existe. Cada ajuste
-- queda registrado con su motivo, para tener el porqué a mano después.
CREATE TABLE IF NOT EXISTS ajustes_factura_compra (
  id                 TEXT PRIMARY KEY,
  factura_compra_id  TEXT NOT NULL REFERENCES facturas_compra(id) ON DELETE CASCADE,
  monto_anterior_usd REAL NOT NULL,
  monto_nuevo_usd    REAL NOT NULL,
  motivo             TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
