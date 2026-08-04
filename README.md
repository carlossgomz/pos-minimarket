# POS Minimarket — esqueleto inicial

Sistema de punto de venta local (offline-first) para el minimarket.
Tauri + React + SQLite. Independiente por ahora del sistema de delivery;
se conectará más adelante.

## Qué incluye este esqueleto

- Ventana de escritorio (Tauri) que corre en Windows/Mac/Linux.
- Base de datos SQLite local (`pos.db`), creada y migrada automáticamente
  al primer arranque — ver `src-tauri/migrations/0001_init.sql` para el
  esquema completo (productos, ventas, pagos combinados, crédito de
  clientes, proveedores, facturas de compra, cuentas por pagar,
  movimientos de inventario).
- Una pantalla de prueba (`src/App.tsx`) que ya lee y escribe en la base
  real: cambia la tasa del día, agrega un producto con costo + margen, y
  lo ve calcular el precio en bolívares y guardarlo. Esto confirma que
  todo el stack funciona de punta a punta antes de construir las
  pantallas reales.

## Requisitos (instalar en tu PC — no en este chat)

Yo armé todos los archivos del proyecto, pero no pude compilarlo ni
correrlo en este entorno porque no tiene el compilador de Rust ni acceso
a internet para descargar paquetes. Vas a necesitar instalar, una sola
vez, en la PC donde vayas a desarrollar:

1. **Node.js** 18 o superior — <https://nodejs.org>
2. **Rust** (con `cargo`) — <https://www.rust-lang.org/tools/install>
3. **Dependencias del sistema para Tauri** según tu sistema operativo,
   siguiendo esta guía oficial: <https://v2.tauri.app/start/prerequisites/>
   (en Windows normalmente ya alcanza con Visual Studio Build Tools +
   WebView2, que suele venir preinstalado en Windows 10/11).

## Cómo correrlo

```bash
npm install
npm run tauri dev
```

La primera vez tardará varios minutos porque Rust va a descargar y
compilar sus dependencias. Las siguientes veces arranca mucho más rápido.

Se debería abrir una ventana de escritorio con el catálogo vacío y un
formulario para agregar el primer producto de prueba.

## Íconos

Puse íconos placeholder (un cuadrado simple) en `src-tauri/icons/` solo
para que el proyecto compile. Cuando tengas tu logo, corre:

```bash
npm run tauri icon ruta/a/tu/logo.png
```

y eso regenera todos los tamaños automáticamente.

## Próximos pasos sugeridos

1. Reemplazar la pantalla de prueba por la pantalla real de venta
   (carrito, escaneo de código de barras, métodos de pago combinados).
2. Construir el módulo de compras (proveedor → factura → cálculo
   automático → stock).
3. Cuadre de caja diario.
4. Más adelante: capa de sincronización contra la base de datos del
   sistema de delivery.
