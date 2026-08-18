-- Repartidores ("chivos") que hacen las entregas de delivery — tanto las
-- que llegan por WhatsApp (venta manual marcada como delivery) como las que
-- llegan por la app (se les asigna el repartidor después, desde Facturas,
-- porque la app todavía no lo captura al pedido). Se paga comisión de
-- $0.10 por producto entregado, cada 15 y último de mes (ver Cuentas →
-- Comisiones de delivery).
CREATE TABLE IF NOT EXISTS repartidores (
  id      TEXT PRIMARY KEY,
  nombre  TEXT NOT NULL,
  activo  INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE ventas ADD COLUMN repartidor_id TEXT REFERENCES repartidores(id);
