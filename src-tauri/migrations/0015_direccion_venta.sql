-- "Foto" de la dirección del cliente al momento de la venta, igual criterio
-- que cliente_nombre/cliente_cedula — para que la factura quede consistente
-- aunque el cliente cambie de dirección después.
ALTER TABLE ventas ADD COLUMN cliente_direccion TEXT;
