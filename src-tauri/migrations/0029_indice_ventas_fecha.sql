-- El dashboard de Kaxa Móvil (kaxa-panel) hace varias consultas por rango
-- de fecha contra ventas (hoy, ayer, semana, mes...) en cada apertura del
-- panel — sin índice, cada una es un escaneo completo de la tabla. No es
-- lo que agotó el cupo de Turso (eso fue el refresco de caché offline
-- cada 5s, ver 0028 y offline.rs), pero sí conviene que estas consultas
-- no sean cada vez más caras a medida que ventas crece con los meses.
CREATE INDEX IF NOT EXISTS idx_ventas_fecha_hora ON ventas (fecha_hora);
