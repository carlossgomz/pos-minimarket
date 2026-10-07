-- El asistente (asistente.ts: "stock muerto", "poco stock con ganancia")
-- busca, por cada producto, si vendió algo en los últimos N días —
-- "NOT EXISTS (... WHERE vi.producto_id = p.id ...)" y un JOIN directo.
-- Sin índice por producto_id, cada una de esas búsquedas escanea
-- venta_items ENTERA (y Turso cuenta filas escaneadas, no devueltas) — con
-- el catálogo completo multiplicando eso, es el gasto más grande de "rows
-- read" del plan gratis. Con este índice, cada búsqueda queda acotada a
-- las líneas de ESE producto en vez de la tabla completa.
CREATE INDEX IF NOT EXISTS idx_venta_items_producto ON venta_items(producto_id);
