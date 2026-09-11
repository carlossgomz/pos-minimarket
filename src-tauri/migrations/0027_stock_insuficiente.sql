-- Venta con más cantidad de un producto de la que había en stock: en vez
-- de bloquear el cobro (o de un cartel de "¿continuar igual?" que
-- cualquiera cierra sin que quede rastro), la venta se cobra y se guarda
-- normal, pero esta línea queda marcada para que un admin la revise y
-- corrija el inventario real - el cajero puede dejar su propia
-- explicación, pero no puede cerrar el caso él mismo.
ALTER TABLE venta_items ADD COLUMN stock_insuficiente INTEGER NOT NULL DEFAULT 0;
-- Cuánto había disponible en el momento de vender (no el stock actual,
-- que ya se corrigió después) - así el admin ve el tamaño real de la
-- diferencia sin depender de que el stock haya quedado en 0 (nunca baja
-- de ahí, para no descuadrar la próxima factura de compra).
ALTER TABLE venta_items ADD COLUMN stock_disponible_al_vender REAL;
ALTER TABLE venta_items ADD COLUMN nota_cajero TEXT;
ALTER TABLE venta_items ADD COLUMN revisado_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venta_items ADD COLUMN revisado_por TEXT;
ALTER TABLE venta_items ADD COLUMN revisado_en TEXT;
