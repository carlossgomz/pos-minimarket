-- Productos que existen en el catálogo solo para registrar su compra
-- (ej. "pollo entero" comprado para despresar en muslos/alas/pechugas) —
-- no se venden directo al cliente y no deben contar en rankings ni
-- estadísticas de ventas. Reemplaza el exclude-por-ID a mano que ya
-- existía para el producto placeholder de delivery.
ALTER TABLE productos ADD COLUMN uso_interno INTEGER NOT NULL DEFAULT 0;
