-- Umbral de stock bajo por producto, para poder alertar en el catálogo
-- ("te estás quedando sin X") sin depender de un número fijo igual para
-- todos los productos (una caja de fósforos y una nevera no deberían
-- alertar al mismo nivel).
ALTER TABLE productos ADD COLUMN stock_minimo REAL NOT NULL DEFAULT 5;
