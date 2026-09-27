-- Cuántas unidades del producto "suelto" genera 1 unidad del "paquete"
-- vinculado (producto_padre_id) al abrirlo en Venta — ej. 1 caja de
-- cigarros = 20 cigarros detallados. Es un campo NUEVO y separado de
-- productos.unidades_por_paquete, que significa otra cosa (cajas por
-- "brazo" de compra, para el costeo en Compras) y NO debe reusarse acá:
-- una caja de cigarros trae 12 cajas por brazo (unidades_por_paquete) pero
-- 20 cigarros por caja (unidades_por_paquete_desglose) — son números
-- independientes del mismo producto.
ALTER TABLE productos ADD COLUMN unidades_por_paquete_desglose INTEGER;
