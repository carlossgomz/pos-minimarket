-- Nota de crédito de un proveedor contra una factura de compra ya
-- registrada — a diferencia de "ajustar monto" (ajustes_factura_compra,
-- que solo corrige el total a pagar a mano, sin tocar stock), esto
-- registra EXACTAMENTE qué productos y cuánta cantidad se devolvieron,
-- rebaja el stock de cada uno (con su propio movimiento de salida) y de
-- ahí calcula sola cuánto baja la factura — ver
-- registrar_nota_credito_compra en comandos.rs.
CREATE TABLE IF NOT EXISTS notas_credito_compra (
  id                 TEXT PRIMARY KEY,
  factura_compra_id  TEXT NOT NULL REFERENCES facturas_compra(id) ON DELETE CASCADE,
  monto_total_usd    REAL NOT NULL,
  motivo             TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notas_credito_compra_factura ON notas_credito_compra(factura_compra_id);

CREATE TABLE IF NOT EXISTS items_nota_credito_compra (
  id                  TEXT PRIMARY KEY,
  nota_credito_id     TEXT NOT NULL REFERENCES notas_credito_compra(id) ON DELETE CASCADE,
  producto_id         TEXT NOT NULL REFERENCES productos(id),
  cantidad            REAL NOT NULL,
  -- Copiado de items_factura_compra al momento de la nota — el costo de
  -- ESA factura específica, no el costo_actual_usd de hoy (puede haber
  -- cambiado desde la compra original).
  costo_unitario_usd  REAL NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_nota_credito_compra_nota ON items_nota_credito_compra(nota_credito_id);
