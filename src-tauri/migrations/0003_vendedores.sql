-- Vendedores que atienden la caja. "nombre" alcanza para un minimarket
-- chico; si más adelante hace falta login con clave por vendedor, esta
-- tabla ya está lista para agregarle esa columna sin romper nada.
CREATE TABLE IF NOT EXISTS vendedores (
  id         TEXT PRIMARY KEY,
  nombre     TEXT NOT NULL UNIQUE,
  activo     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Se guarda tanto el id (para poder hacer reportes "ventas por vendedor"
-- más adelante) como el nombre "foto" (por si el vendedor se renombra o
-- se desactiva después, el ticket viejo no pierde el dato).
ALTER TABLE ventas ADD COLUMN vendedor_id TEXT;
ALTER TABLE ventas ADD COLUMN vendedor_nombre TEXT;

-- Recuerda quién quedó seleccionado la última vez, para no tener que
-- elegirlo de nuevo cada vez que se abre la app en la misma caja.
ALTER TABLE config ADD COLUMN vendedor_actual_id TEXT;