-- Sistema de usuarios para controlar quién ve qué sección, sobre la MISMA
-- base de datos (no son bases separadas, es un permiso por rol). ADMIN ve
-- todo; CAJERO solo Venta, Facturas, Clientes y Cuentas (se filtra en el
-- frontend, en App.tsx). La contraseña se guarda como hash SHA-256, nunca
-- en texto plano.
CREATE TABLE IF NOT EXISTS usuarios (
  id              TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL,
  usuario         TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  rol             TEXT NOT NULL DEFAULT 'CAJERO', -- ADMIN / CAJERO
  activo          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Usuario administrador por defecto para poder entrar la primera vez:
-- usuario "admin", contraseña "admin123". Cámbiala desde la pestaña
-- Usuarios apenas inicies sesión.
INSERT INTO usuarios (id, nombre, usuario, password_hash, rol) VALUES
  ('admin-seed', 'Administrador', 'admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'ADMIN');
