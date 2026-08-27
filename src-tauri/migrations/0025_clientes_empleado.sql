-- Marca clientes que son empleados de la tienda — controla si el método
-- "Descuento de nómina" aparece como opción al registrarles un abono (ver
-- Cuentas.tsx). Nada más depende de esto por ahora.
ALTER TABLE clientes ADD COLUMN es_empleado INTEGER NOT NULL DEFAULT 0;
