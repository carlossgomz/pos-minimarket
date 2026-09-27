-- Vincula un producto "suelto" (ej. "CIGARRO DETALLADO") con el producto
-- "paquete" del que sale (ej. "CIGARRO CAJA") — para poder ofrecer, en
-- Venta, abrir 1 paquete con un clic cuando el suelto se queda sin stock,
-- en vez de tener que ir a Movimientos a desglosar a mano. La cantidad de
-- unidades que genera cada paquete ya existe: productos.unidades_por_paquete
-- del PADRE (ver desglosar_producto_interna).
ALTER TABLE productos ADD COLUMN producto_padre_id TEXT REFERENCES productos(id);
