-- Permite comprar por caja/paquete y que el sistema calcule solo el
-- costo por unidad individual (lo que realmente se descuenta y se vende
-- en el mostrador). "unidades_por_paquete" es cuántas unidades
-- individuales trae una caja de ESTE producto — se define al comprarlo
-- (nuevo o ya existente) y queda guardado para la próxima compra.
ALTER TABLE productos ADD COLUMN unidades_por_paquete REAL NOT NULL DEFAULT 1;

-- Se guarda también el desglose tal como viene en la factura del
-- proveedor (cajas, unidad suelta, unidades por paquete usadas en esa
-- compra), para poder revisar después contra el papel — costo_unitario_usd
-- en items_factura_compra ya queda con el cálculo final por unidad, como
-- el resto del sistema.
ALTER TABLE items_factura_compra ADD COLUMN cajas REAL NOT NULL DEFAULT 0;
ALTER TABLE items_factura_compra ADD COLUMN unidad_suelta REAL NOT NULL DEFAULT 0;
ALTER TABLE items_factura_compra ADD COLUMN unidades_por_paquete REAL NOT NULL DEFAULT 1;
