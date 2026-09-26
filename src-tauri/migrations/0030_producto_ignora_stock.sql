-- Para productos que no son inventario real (ej. "DELIVERY", un cargo de
-- servicio) - se venden siempre a stock 0 a propósito, así que no tiene
-- sentido que cada venta quede marcada "stock por revisar" para un admin.
ALTER TABLE productos ADD COLUMN ignora_stock INTEGER NOT NULL DEFAULT 0;
