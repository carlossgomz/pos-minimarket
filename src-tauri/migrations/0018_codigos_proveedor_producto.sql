-- Un mismo producto se puede comprar a MÁS de un proveedor, cada uno con
-- su propio código interno — productos.codigo_proveedor solo alcanzaba
-- para guardar el de la ÚLTIMA compra, así que comprarlo a otro proveedor
-- con un código distinto no lo reconocía y terminaba duplicando el
-- producto. Esta tabla guarda TODOS los códigos conocidos por proveedor.
CREATE TABLE IF NOT EXISTS codigos_proveedor_producto (
  id           TEXT PRIMARY KEY,
  producto_id  TEXT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  proveedor_id TEXT NOT NULL REFERENCES proveedores(id),
  codigo       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(proveedor_id, codigo)
);
CREATE INDEX IF NOT EXISTS idx_codigos_proveedor_producto_producto ON codigos_proveedor_producto(producto_id);

-- Backfill best-effort: de lo ya comprado antes de esta tabla, solo se
-- puede reconstruir el vínculo (proveedor, código) de la compra MÁS
-- RECIENTE de cada producto — productos.codigo_proveedor iba
-- sobrescribiéndose en cada compra, así que códigos de otros proveedores
-- más viejos ya no están guardados en ningún lado y no se pueden
-- recuperar acá. De acá en adelante (ver comandos.rs) cada compra nueva
-- sí agrega su propia fila, sin perder las anteriores.
INSERT OR IGNORE INTO codigos_proveedor_producto (id, producto_id, proveedor_id, codigo)
SELECT lower(hex(randomblob(16))), p.id, ultimo.proveedor_id, p.codigo_proveedor
FROM productos p
JOIN (
  SELECT ifc.producto_id, fc.proveedor_id, fc.fecha
  FROM items_factura_compra ifc
  JOIN facturas_compra fc ON fc.id = ifc.factura_compra_id
) ultimo ON ultimo.producto_id = p.id
WHERE p.codigo_proveedor IS NOT NULL AND trim(p.codigo_proveedor) != ''
  AND ultimo.fecha = (
    SELECT MAX(fc2.fecha)
    FROM items_factura_compra ifc2
    JOIN facturas_compra fc2 ON fc2.id = ifc2.factura_compra_id
    WHERE ifc2.producto_id = p.id
  );
