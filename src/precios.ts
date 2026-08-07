import { Producto } from "./types";

// El precio en bolívares guardado en productos.precio_venta_bs es una
// "foto" de la última vez que se tocó el producto (alta o compra) — no se
// actualiza solo cuando cambia la tasa del día. Como este negocio vive de
// la tasa del día, confiar en esa columna para cobrar vendería a un precio
// desactualizado cualquier día en que la tasa cambie sin que el producto
// se recompre. Estas funciones son la fuente de verdad para "cuánto vale
// esto ahora mismo": siempre se calculan a partir de costo + margen +
// tasa actual, en vez de leer el valor guardado.

type ProductoParaPrecio = Pick<Producto, "costo_actual_usd" | "margen_porcentaje">;

// "Margen" acá es margen bruto sobre el precio de venta (qué % del precio
// final es ganancia), no markup sobre el costo — con costo 2.99 y margen
// 30%, el precio da 4.27 (2.99 / 0.70), no 3.89 (2.99 * 1.30). Se topa en
// 99.99 para no dividir por cero (o un número negativo) si alguien
// escribe 100 o más por error.
export function precioVentaUsd(p: ProductoParaPrecio): number {
  const margen = Math.min(Math.max(p.margen_porcentaje ?? 0, 0), 99.99);
  return p.costo_actual_usd / (1 - margen / 100);
}

// Redondea el USD a centavos ANTES de pasarlo a bolívares — si no, lo que
// se ve en pantalla no cuadra: con costo 1.49 y margen 30%, el USD exacto
// es 2.1285714..., que se muestra redondeado como "2.13", pero convertir
// el número SIN redondear (2.1285714 * tasa) da un Bs distinto al que da
// multiplicar a mano el "2.13" que el usuario ve. Redondeando acá, el Bs
// mostrado siempre coincide con USD mostrado × tasa del día.
export function precioVentaBsHoy(p: ProductoParaPrecio, tasaCambioDia: number): number {
  const usdRedondeado = Math.round(precioVentaUsd(p) * 100) / 100;
  return usdRedondeado * tasaCambioDia;
}

export function gananciaUnitariaUsd(p: ProductoParaPrecio): number {
  return precioVentaUsd(p) - p.costo_actual_usd;
}

// Los productos por peso (kg) acumulan ruido de punto flotante al restar
// gramo a gramo (ej. -0.16499999999999998 en vez de -0.165) — esto es solo
// para mostrar, redondea a 3 decimales (alcanza para gramos) sin forzar
// ceros de más en productos por unidad (5 sigue mostrando "5", no "5.000").
export function formatearStock(stock: number): string {
  return String(Math.round(stock * 1000) / 1000);
}

export type EstadoStock = "agotado" | "critico" | "bajo" | "ok";

// "critico" es una advertencia dura, fija en 1 unidad, independiente del
// stock mínimo configurable de cada producto — para que salte a la vista
// aunque el mínimo esté mal puesto o ni se haya revisado.
export function estadoStock(p: Pick<Producto, "stock_actual" | "stock_minimo">): EstadoStock {
  if (p.stock_actual <= 0) return "agotado";
  if (p.stock_actual === 1) return "critico";
  if (p.stock_actual <= p.stock_minimo) return "bajo";
  return "ok";
}
