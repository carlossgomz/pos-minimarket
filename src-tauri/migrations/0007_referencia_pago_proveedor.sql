-- Referencia bancaria del pago (número de transferencia, pago móvil, etc.),
-- igual que ya existe para los pagos de venta (tabla "pagos"). Antes no
-- había forma de dejar constancia de con qué operación bancaria se pagó a
-- un proveedor.
ALTER TABLE pagos_proveedor ADD COLUMN referencia TEXT;
