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

export function precioVentaUsd(p: ProductoParaPrecio): number {
  return p.costo_actual_usd * (1 + (p.margen_porcentaje ?? 0) / 100);
}

export function precioVentaBsHoy(p: ProductoParaPrecio, tasaCambioDia: number): number {
  return precioVentaUsd(p) * tasaCambioDia;
}

export function gananciaUnitariaUsd(p: ProductoParaPrecio): number {
  return precioVentaUsd(p) - p.costo_actual_usd;
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
