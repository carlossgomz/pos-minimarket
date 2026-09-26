-- Dirección y teléfono del negocio, para la ficha completa en
-- Configuración > Negocio (nombre y RIF ya existían) - se usan también en
-- los tickets impresos si el negocio los carga.
ALTER TABLE config ADD COLUMN direccion_negocio TEXT;
ALTER TABLE config ADD COLUMN telefono_negocio TEXT;
