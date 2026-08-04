-- Productos de prueba para un minimarket. El precio en Bs se calcula
-- igual que en el resto del sistema: costo_usd * tasa_del_día_actual *
-- (1 + margen/100) — así que va a quedar correcto sin importar qué tasa
-- tengas configurada cuando esta migración corra por primera vez.

INSERT OR IGNORE INTO categorias (id, nombre, margen_defecto) VALUES
  ('cat-seed-alimentos', 'Alimentos', 25),
  ('cat-seed-lacteos', 'Lácteos', 20),
  ('cat-seed-bebidas', 'Bebidas', 30),
  ('cat-seed-aseo', 'Aseo personal', 30);

INSERT INTO productos (id, codigo_barra, nombre, categoria_id, costo_actual_usd, margen_porcentaje, precio_venta_bs, stock_actual)
VALUES
  ('seed-harina-pan', '7591234500016', 'Harina P.A.N. 1kg', 'cat-seed-alimentos', 1.20, 25,
    1.20 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.25, 50),
  ('seed-aceite-vatel', '7591234500023', 'Aceite Vatel 1L', 'cat-seed-alimentos', 2.50, 20,
    2.50 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.20, 40),
  ('seed-arroz-mary', '7591234500030', 'Arroz Mary 1kg', 'cat-seed-alimentos', 1.10, 25,
    1.10 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.25, 50),
  ('seed-azucar-montalban', '7591234500047', 'Azúcar Montalbán 1kg', 'cat-seed-alimentos', 1.00, 20,
    1.00 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.20, 45),
  ('seed-pasta-ronco', '7591234500054', 'Pasta Ronco 500g', 'cat-seed-alimentos', 0.80, 25,
    0.80 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.25, 60),
  ('seed-cafe-fama', '7591234500061', 'Café Fama de América 250g', 'cat-seed-alimentos', 2.00, 30,
    2.00 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.30, 30),
  ('seed-leche-nido', '7591234500078', 'Leche en polvo Nido 400g', 'cat-seed-lacteos', 4.50, 20,
    4.50 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.20, 25),
  ('seed-cocacola-1500', '7591234500085', 'Refresco Coca-Cola 1.5L', 'cat-seed-bebidas', 1.30, 30,
    1.30 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.30, 36),
  ('seed-jabon-camay', '7591234500092', 'Jabón de baño Camay', 'cat-seed-aseo', 0.60, 35,
    0.60 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.35, 40),
  ('seed-papel-rosal', '7591234500108', 'Papel higiénico Rosal x4', 'cat-seed-aseo', 1.80, 25,
    1.80 * (SELECT tasa_cambio_dia FROM config WHERE id = 1) * 1.25, 30);

INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo)
SELECT lower(hex(randomblob(8))), id, 'ENTRADA', stock_actual, 'Carga de productos de prueba'
FROM productos WHERE id LIKE 'seed-%';