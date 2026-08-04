-- Algunos productos de una factura de proveedor llevan IVA y otros no (p.
-- ej. buena parte de la canasta básica está exenta en Venezuela) — se
-- pregunta por línea al cargar la compra. El IVA ya queda incluido en
-- costo_unitario_usd (el costo real pagado por unidad), pero se guarda
-- aparte también para poder mostrarlo en el detalle de la factura.
ALTER TABLE items_factura_compra ADD COLUMN aplica_iva INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items_factura_compra ADD COLUMN tasa_iva_aplicada REAL NOT NULL DEFAULT 0;
