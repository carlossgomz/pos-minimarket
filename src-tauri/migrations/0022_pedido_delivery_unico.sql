-- Evita que un mismo pedido de la app de delivery termine registrado dos
-- veces como venta (por ejemplo, si dos PCs del POS lo importan casi al
-- mismo tiempo). Índice parcial: no afecta a las ventas de mostrador, que
-- siempre tienen pedido_delivery_id NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_pedido_delivery_id
  ON ventas(pedido_delivery_id)
  WHERE pedido_delivery_id IS NOT NULL;
