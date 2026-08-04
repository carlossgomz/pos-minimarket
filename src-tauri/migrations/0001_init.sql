-- Esquema inicial del sistema POS local (SQLite).
-- Independiente por ahora del backend de delivery; se conectará más
-- adelante. Los nombres de campo siguen la misma lógica que ya definimos
-- (costo + margen, tasa del día, cuentas por cobrar/pagar en USD) para
-- que integrarlo después sea solo un mapeo de columnas, no un rediseño.

CREATE TABLE IF NOT EXISTS categorias (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL UNIQUE,
  margen_defecto REAL NOT NULL DEFAULT 30,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS productos (
  id                TEXT PRIMARY KEY,
  codigo_barra      TEXT NOT NULL UNIQUE,
  nombre            TEXT NOT NULL,
  categoria_id      TEXT REFERENCES categorias(id),
  imagen_url        TEXT,
  costo_actual_usd  REAL NOT NULL DEFAULT 0,
  margen_porcentaje REAL,                          -- si es NULL, hereda el de la categoría
  precio_venta_bs   REAL NOT NULL DEFAULT 0,        -- = costo_actual_usd * tasa * (1 + margen/100)
  es_gravable       INTEGER NOT NULL DEFAULT 0,     -- 0/1
  tasa_iva          REAL NOT NULL DEFAULT 16,
  por_peso          INTEGER NOT NULL DEFAULT 0,     -- 0/1
  stock_actual      REAL NOT NULL DEFAULT 0,        -- REAL para soportar productos por peso
  activo            INTEGER NOT NULL DEFAULT 1,     -- 0/1, se apaga solo cuando stock llega a 0
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria_id);

CREATE TABLE IF NOT EXISTS clientes (
  id                  TEXT PRIMARY KEY,
  nombre              TEXT NOT NULL,
  cedula              TEXT NOT NULL UNIQUE,
  telefono            TEXT,
  credito_autorizado  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proveedores (
  id          TEXT PRIMARY KEY,
  nombre      TEXT NOT NULL,
  rif         TEXT NOT NULL UNIQUE,
  direccion   TEXT,
  telefono    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  tasa_cambio_dia       REAL NOT NULL DEFAULT 1,
  nombre_negocio        TEXT NOT NULL DEFAULT 'Mi minimarket',
  rif_negocio           TEXT,
  prefijo_caja          TEXT NOT NULL DEFAULT 'CAJA1',
  proximo_numero_ticket INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO config (id) VALUES (1);

-- Una venta puede ser de la caja física ("TIENDA") — más adelante, cuando
-- se conecte con el delivery, el mismo concepto de "venta" se mapeará
-- contra la tabla Order de ese sistema.
CREATE TABLE IF NOT EXISTS ventas (
  id                  TEXT PRIMARY KEY,
  numero_ticket       TEXT NOT NULL UNIQUE,
  fecha_hora          TEXT NOT NULL DEFAULT (datetime('now')),
  cliente_id          TEXT REFERENCES clientes(id),
  cliente_nombre      TEXT,          -- "foto" del dato al momento de vender
  cliente_cedula      TEXT,
  tasa_cambio_dia     REAL NOT NULL,
  subtotal_bs         REAL NOT NULL DEFAULT 0,
  iva_bs              REAL NOT NULL DEFAULT 0,
  total_bs            REAL NOT NULL DEFAULT 0,
  estado              TEXT NOT NULL DEFAULT 'COMPLETADA', -- COMPLETADA / CREDITO_PENDIENTE / CREDITO_PAGADO / ANULADA
  monto_pendiente_usd REAL,          -- solo si estado empieza en CREDITO_PENDIENTE
  sincronizada        INTEGER NOT NULL DEFAULT 0,  -- 0/1, para cuando exista sync con la nube
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS venta_items (
  id              TEXT PRIMARY KEY,
  venta_id        TEXT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id     TEXT NOT NULL REFERENCES productos(id),
  cantidad        REAL NOT NULL,
  precio_unit_bs  REAL NOT NULL,
  subtotal_bs     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_venta_items_venta ON venta_items(venta_id);

-- Línea de pago de una venta: permite combinar varios métodos en una
-- misma venta (ej. mitad efectivo, mitad pago móvil).
CREATE TABLE IF NOT EXISTS pagos (
  id          TEXT PRIMARY KEY,
  venta_id    TEXT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  metodo      TEXT NOT NULL,  -- EFECTIVO / PUNTO_VENTA / BIOPAGO / PAGO_MOVIL / TRANSFERENCIA / CREDITO
  monto_bs    REAL NOT NULL,
  referencia  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pagos_venta ON pagos(venta_id);

-- Abono de un cliente a una venta a crédito. Tasa del día del ABONO, no
-- la de la venta original.
CREATE TABLE IF NOT EXISTS cobros_cliente (
  id              TEXT PRIMARY KEY,
  venta_id        TEXT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  monto_usd       REAL NOT NULL,
  tasa_cambio_dia REAL NOT NULL,
  monto_bs        REAL NOT NULL,
  metodo          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS facturas_compra (
  id                TEXT PRIMARY KEY,
  proveedor_id      TEXT NOT NULL REFERENCES proveedores(id),
  numero_factura    TEXT NOT NULL,
  fecha             TEXT NOT NULL DEFAULT (datetime('now')),
  moneda            TEXT NOT NULL DEFAULT 'USD',  -- USD / VES
  tasa_cambio_dia   REAL NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'PENDIENTE', -- PENDIENTE / PARCIAL / PAGADA
  monto_total_usd   REAL NOT NULL DEFAULT 0,
  monto_pagado_usd  REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(proveedor_id, numero_factura)
);

CREATE TABLE IF NOT EXISTS items_factura_compra (
  id                      TEXT PRIMARY KEY,
  factura_compra_id       TEXT NOT NULL REFERENCES facturas_compra(id) ON DELETE CASCADE,
  producto_id             TEXT NOT NULL REFERENCES productos(id),
  cantidad                REAL NOT NULL,
  costo_unitario_usd      REAL NOT NULL,
  margen_aplicado         REAL NOT NULL,
  precio_venta_calculado  REAL NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_factura_compra_factura ON items_factura_compra(factura_compra_id);

-- Abono a un proveedor, con la tasa del día del pago.
CREATE TABLE IF NOT EXISTS pagos_proveedor (
  id                  TEXT PRIMARY KEY,
  factura_compra_id   TEXT NOT NULL REFERENCES facturas_compra(id) ON DELETE CASCADE,
  monto_usd           REAL NOT NULL,
  tasa_cambio_dia     REAL NOT NULL,
  monto_bs            REAL NOT NULL,
  metodo              TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial de movimientos de stock: entradas (compra), salidas (venta),
-- ajustes manuales (mermas, conteos físicos).
CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id          TEXT PRIMARY KEY,
  producto_id TEXT NOT NULL REFERENCES productos(id),
  tipo        TEXT NOT NULL,  -- ENTRADA / SALIDA / AJUSTE
  cantidad    REAL NOT NULL,
  motivo      TEXT,
  referencia  TEXT,           -- id de venta o factura_compra relacionada
  usuario     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos_inventario(producto_id);
