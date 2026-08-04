-- Igual que el IVA (migración 0008): algunos productos de una factura de
-- proveedor traen descuento y otros no, se pregunta por línea. El
-- descuento se aplica sobre el costo ANTES del IVA (como en una factura de
-- verdad) y ya queda incluido en costo_unitario_usd; se guarda aparte para
-- poder mostrarlo en el detalle de la factura.
ALTER TABLE items_factura_compra ADD COLUMN aplica_descuento INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items_factura_compra ADD COLUMN descuento_aplicado REAL NOT NULL DEFAULT 0;
