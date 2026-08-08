export type Producto = {
  id: string;
  codigo_barra: string;
  // Código interno del proveedor (de su factura) — no es el código de
  // barras de venta. Solo sirve para reconocer el producto en compras
  // futuras antes de que tenga un código de barras real asignado.
  codigo_proveedor: string | null;
  nombre: string;
  categoria_id: string | null;
  costo_actual_usd: number;
  margen_porcentaje: number | null;
  precio_venta_bs: number;
  es_gravable: number; // 0/1
  tasa_iva: number;
  stock_actual: number;
  stock_minimo: number;
  unidades_por_paquete: number;
  activo: number; // 0/1
  disponible_delivery: number; // 0/1 — si se ofrece o no en la app de delivery
};

export type ProductoInventario = Producto & {
  categoria_nombre: string | null;
};

export type MovimientoInventario = {
  id: string;
  producto_id: string;
  producto_nombre: string;
  tipo: string; // ENTRADA / SALIDA
  cantidad: number;
  motivo: string | null;
  referencia: string | null;
  created_at: string;
};

export type ConfigRow = {
  tasa_cambio_dia: number;
  nombre_negocio: string;
  rif_negocio: string | null;
  prefijo_caja: string;
  proximo_numero_ticket: number;
  vendedor_actual_id: string | null;
  gemini_api_key: string | null;
  delivery_api_url: string | null;
};

export type Vendedor = {
  id: string;
  nombre: string;
  activo: number; // 0/1
};

export type Rol = "ADMIN" | "CAJERO";

export type Usuario = {
  id: string;
  nombre: string;
  usuario: string;
  rol: Rol;
  activo: number; // 0/1
};

export type LineaCarrito = {
  producto_id: string;
  codigo_barra: string;
  nombre: string;
  cantidad: number;
  precio_unit_bs: number; // snapshot del precio al momento de agregarlo
  es_gravable: number;
  tasa_iva: number;
  stock_disponible: number;
};

export type Categoria = {
  id: string;
  nombre: string;
  margen_defecto: number;
};

export type Proveedor = {
  id: string;
  nombre: string;
  rif: string;
  direccion: string | null;
  telefono: string | null;
};

// Los campos siguen el mismo orden en que aparecen en una factura de
// proveedor típica: código, descripción, cajas, unidad (suelta), precio
// unitario. "unidadesPorPaquete" no viene en la factura — es cuántas
// unidades individuales trae una caja de ESTE producto, para poder
// calcular el costo por unidad real (lo que se descuenta y se vende).
export type LineaFacturaBorrador = {
  producto_id: string;
  codigo_barra: string;
  // Código del proveedor tal cual viene en la factura — se guarda en
  // productos.codigo_proveedor, NUNCA como codigo_barra (ver Compras.tsx).
  codigoProveedor?: string;
  nombre: string;
  es_nuevo: boolean;
  categoria?: string;
  cajas: number;
  unidadSuelta: number;
  unidadesPorPaquete: number;
  precioPaqueteIngresado: number; // por caja (o por unidad si cajas=0), en la moneda de la factura
  margen_aplicado: number;
  aplicaIva: boolean;
  tasaIva: number;
  aplicaDescuento: boolean;
  descuentoPct: number;
  // Costo y stock que tenía el producto ANTES de esta línea — solo para
  // productos existentes. Con esto se calcula el costo vigente nuevo como
  // promedio ponderado (ver costoVigenteDeLinea en Compras.tsx): no se
  // mandan tal cual al backend, pero costoVigenteDeLinea sí se manda como
  // costo_vigente_usd.
  costoAnteriorUsd?: number;
  stockAnteriorUnidades?: number;
};

// Lo que devuelve el comando de Rust escanear_factura (src-tauri/src/ia.rs)
// tras leer la foto de la factura con Gemini — datos crudos para
// PRE-LLENAR el formulario de Compras.tsx, nunca se guardan directo.
export type ProveedorExtraidoIA = {
  nombre: string;
  rif: string | null;
  direccion: string | null;
  telefono: string | null;
};

export type ItemExtraidoIA = {
  codigo: string | null;
  nombre: string;
  cajas: number;
  unidad_suelta: number;
  unidades_por_caja: number | null;
  precio_unitario: number;
  aplica_iva: boolean;
  tasa_iva: number | null;
  aplica_descuento: boolean;
  descuento_pct: number | null;
};

export type FacturaExtraidaIA = {
  proveedor: ProveedorExtraidoIA;
  numero_factura: string | null;
  moneda: string | null;
  items: ItemExtraidoIA[];
};

export type ClienteDeudor = {
  cliente_nombre: string;
  cliente_cedula: string;
  total_pendiente_usd: number;
  num_ventas: number;
};

export type VentaCredito = {
  id: string;
  numero_ticket: string;
  fecha_hora: string;
  total_bs: number;
  monto_pendiente_usd: number;
  tasa_cambio_dia: number;
};

export type ProveedorDeudor = {
  proveedor_id: string;
  proveedor_nombre: string;
  total_pendiente_usd: number;
  num_facturas: number;
};

export type FacturaPendiente = {
  id: string;
  numero_factura: string;
  fecha: string;
  moneda: string;
  tasa_cambio_dia: number;
  monto_total_usd: number;
  monto_pagado_usd: number;
  estado: string;
};

export type Cliente = {
  id: string;
  nombre: string;
  cedula: string;
  telefono: string | null;
  direccion: string | null;
  // Id del Cliente en la app de delivery, si tiene cuenta ahí — null si se
  // creó solo en caja. No se fusiona con la cuenta de delivery, solo la
  // referencia (ver migración 0014).
  cliente_app_id: string | null;
  credito_autorizado: number; // 0/1
};

export type VentaResumen = {
  id: string;
  numero_ticket: string;
  fecha_hora: string;
  total_bs: number;
  estado: string;
};

export type FacturaResumen = {
  id: string;
  numero_factura: string;
  fecha: string;
  moneda: string;
  monto_total_usd: number;
  monto_pagado_usd: number;
  estado: string;
};

export type FacturaVentaResumen = {
  id: string;
  numero_ticket: string;
  fecha_hora: string;
  cliente_nombre: string | null;
  cliente_cedula: string | null;
  vendedor_nombre: string | null;
  total_bs: number;
  estado: string;
  canal: string; // TIENDA / DELIVERY
};

export type FacturaVentaCompleta = {
  id: string;
  numero_ticket: string;
  fecha_hora: string;
  cliente_nombre: string | null;
  cliente_cedula: string | null;
  cliente_direccion: string | null;
  vendedor_nombre: string | null;
  tasa_cambio_dia: number;
  subtotal_bs: number;
  iva_bs: number;
  total_bs: number;
  estado: string;
  monto_pendiente_usd: number | null;
};

export type FacturaVentaItemDetalle = {
  producto_nombre: string;
  cantidad: number;
  precio_unit_bs: number;
  subtotal_bs: number;
};

// Igual que FacturaVentaItemDetalle, pero con producto_id — hace falta
// para poder editar los productos de una venta ya registrada (ver
// EditorItemsVenta.tsx).
export type FacturaVentaItemEditable = {
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  precio_unit_bs: number;
};

export type FacturaVentaPagoDetalle = {
  id: string;
  metodo: string;
  monto_bs: number;
  referencia: string | null;
  verificado_admin: number; // 0/1 — solo aplica a PAGO_MOVIL
};

export type FacturaCompraResumen = {
  id: string;
  proveedor_id: string;
  numero_factura: string;
  fecha: string;
  proveedor_nombre: string;
  moneda: string;
  tasa_cambio_dia: number;
  monto_total_usd: number;
  monto_pagado_usd: number;
  estado: string;
  // 1 si todavía no se vendió nada de su stock ni se le pagó nada al
  // proveedor — solo en ese caso se puede editar/eliminar (ver
  // factura_compra_bloqueo en src-tauri/src/comandos.rs).
  editable: number;
};

export type FacturaCompraItemDetalle = {
  producto_nombre: string;
  codigo_barra: string;
  cajas: number;
  unidad_suelta: number;
  unidades_por_paquete: number;
  cantidad: number;
  costo_unitario_usd: number;
  precio_venta_calculado: number;
  aplica_iva: number; // 0/1
  tasa_iva_aplicada: number;
  aplica_descuento: number; // 0/1
  descuento_aplicado: number;
};

// Usado solo para precargar una factura existente en el formulario de
// edición — a diferencia de FacturaCompraItemDetalle (para mostrar), acá
// hace falta el producto_id para poder reconstruir cada línea editable.
export type FacturaCompraItemEditable = {
  producto_id: string;
  codigo_barra: string;
  codigo_proveedor: string | null;
  producto_nombre: string;
  cantidad: number;
  costo_unitario_usd: number;
  margen_aplicado: number;
};

export type AporteCapitalExterno = {
  id: string;
  monto_bs: number;
  nota: string | null;
  created_at: string;
};

export type AvanceEfectivo = {
  id: string;
  fecha_hora: string;
  monto_efectivo_bs: number;
  monto_cobrado_bs: number;
  metodo_cobro: string;
  fuente_efectivo: "CAJA" | "CAPITAL_EXTERIOR";
  referencia: string | null;
  created_at: string;
};

// Orden de más a menos usado en este negocio — así el más común queda
// primero en cada selector/lista, para que el proceso sea más rápido.
export const METODOS_PAGO = [
  "PUNTO_VENTA",
  "BIOPAGO",
  "PAGO_MOVIL",
  "EFECTIVO",
  "DIVISAS",
  "TRANSFERENCIA",
] as const;

export type MetodoPago = (typeof METODOS_PAGO)[number] | "CREDITO";

export type LineaPago = {
  metodo: MetodoPago;
  monto_bs: number;
  referencia?: string;
};