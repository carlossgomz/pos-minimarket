-- Vincula un cliente del POS con su cuenta en la app de delivery (si la
-- tiene) sin fusionar ambos sistemas de registro — un cliente puede existir
-- solo en caja, solo en la app, o en ambos (mismo id de cliente en el POS,
-- solo se agrega el vínculo). credito_autorizado sigue siendo una decisión
-- exclusiva de la tienda física, independiente del crédito que maneje la
-- app de delivery.
ALTER TABLE clientes ADD COLUMN cliente_app_id TEXT;
ALTER TABLE clientes ADD COLUMN direccion TEXT;
