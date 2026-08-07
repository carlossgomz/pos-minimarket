-- Integración con la app de delivery (sistema aparte, Next.js/Postgres, sin
-- base de datos compartida — se conecta por HTTP, ver src/delivery.rs).

-- Si es 0, el producto nunca se ofrece por delivery (hay artículos que
-- solo se venden en el mostrador físico). Lo decide el POS y se empuja al
-- catálogo de la delivery-app en cada sincronización.
ALTER TABLE productos ADD COLUMN disponible_delivery INTEGER NOT NULL DEFAULT 1;

-- Toda venta nace "TIENDA" (caja física); las que llegan importadas desde
-- un pedido de delivery entregado quedan en "DELIVERY", con el id del
-- Order de origen para no volver a importarlo.
ALTER TABLE ventas ADD COLUMN canal TEXT NOT NULL DEFAULT 'TIENDA';
ALTER TABLE ventas ADD COLUMN pedido_delivery_id TEXT;

-- URL de la delivery-app y el token compartido para autenticar contra sus
-- endpoints /api/pos/*. Vive en config (no en sync-config.json local)
-- porque es configuración de negocio, igual que la tasa del día — la
-- comparten todas las PCs vía Turso, no es un secreto por-dispositivo.
ALTER TABLE config ADD COLUMN delivery_api_url TEXT;
ALTER TABLE config ADD COLUMN delivery_sync_token TEXT;
