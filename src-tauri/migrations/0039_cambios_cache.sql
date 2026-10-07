-- offline.rs refrescar_cache() hace "SELECT * FROM tabla" completo (las 7
-- TABLAS_CACHEADAS) cada 60s en CADA PC abierta, aunque nada haya
-- cambiado — con varias PCs y la base creciendo, la inmensa mayoría de
-- esas lecturas son inútiles. Esta fila (y sus triggers) le avisan a
-- offline.rs si de verdad cambió algo desde la última vez que refrescó,
-- para que se salte el refresco completo cuando no hizo falta. Un solo
-- contador para las 7 tablas juntas (no uno por tabla) porque el refresco
-- siempre las trae todas de una — no hace falta más precisión que esa.
CREATE TABLE IF NOT EXISTS cambios_cache (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO cambios_cache (id, version) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_categorias_ins AFTER INSERT ON categorias
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_categorias_upd AFTER UPDATE ON categorias
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_categorias_del AFTER DELETE ON categorias
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_productos_ins AFTER INSERT ON productos
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_productos_upd AFTER UPDATE ON productos
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_productos_del AFTER DELETE ON productos
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_clientes_ins AFTER INSERT ON clientes
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_clientes_upd AFTER UPDATE ON clientes
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_clientes_del AFTER DELETE ON clientes
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_proveedores_ins AFTER INSERT ON proveedores
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_proveedores_upd AFTER UPDATE ON proveedores
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_proveedores_del AFTER DELETE ON proveedores
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_vendedores_ins AFTER INSERT ON vendedores
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_vendedores_upd AFTER UPDATE ON vendedores
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_vendedores_del AFTER DELETE ON vendedores
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_config_ins AFTER INSERT ON config
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_config_upd AFTER UPDATE ON config
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_config_del AFTER DELETE ON config
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_lotes_producto_ins AFTER INSERT ON lotes_producto
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_lotes_producto_upd AFTER UPDATE ON lotes_producto
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_cambios_cache_lotes_producto_del AFTER DELETE ON lotes_producto
BEGIN UPDATE cambios_cache SET version = version + 1 WHERE id = 1; END;
