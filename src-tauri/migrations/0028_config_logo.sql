-- Logo propio del negocio, configurable (antes solo el archivo bundleado
-- src/assets/logo.png, igual que ya tienen pos-basico/medio/avanzado
-- desde 0025_config_logo.sql) — se guarda como data URI base64 para no
-- depender del sistema de archivos. Se puede colocar desde Kaxa Móvil
-- (kaxa-panel) y se refleja acá mismo, en la ventana y en los tickets.
ALTER TABLE config ADD COLUMN logo_base64 TEXT;
