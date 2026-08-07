import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db";
import { formatearStock } from "../precios";
import {
  ConfigRow,
  FacturaCompraItemDetalle,
  FacturaCompraItemEditable,
  FacturaCompraResumen,
  FacturaExtraidaIA,
  LineaFacturaBorrador,
  Producto,
  Proveedor,
} from "../types";
import { fechaHoraVenezuela } from "../fecha";
import { normalizarTexto, sqlSinAcentos } from "../busqueda";

// Caja con etiqueta fija arriba del campo — a diferencia del placeholder,
// la etiqueta no desaparece al escribir, así que siempre queda claro qué
// va en cada casilla.
function Campo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="campo">
      <label>{label}</label>
      {children}
    </div>
  );
}

export default function Compras({
  config,
  onConfigActualizado,
}: {
  config: ConfigRow;
  onConfigActualizado: () => void;
}) {
  // --- Escanear factura con IA (Gemini) ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mostrarConfigIA, setMostrarConfigIA] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [escaneando, setEscaneando] = useState(false);
  const [avisoEscaneo, setAvisoEscaneo] = useState<string | null>(null);

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [proveedorId, setProveedorId] = useState<string>("");
  const [mostrarNuevoProveedor, setMostrarNuevoProveedor] = useState(false);
  const [nombreProv, setNombreProv] = useState("");
  const [rifProv, setRifProv] = useState("");
  const [direccionProv, setDireccionProv] = useState("");
  const [telefonoProv, setTelefonoProv] = useState("");

  const [numeroFactura, setNumeroFactura] = useState("");
  const [moneda, setMoneda] = useState<"USD" | "VES">("USD");
  const [tasaFactura, setTasaFactura] = useState(String(config.tasa_cambio_dia));

  // --- Línea en construcción: los campos siguen el orden de la factura
  // del proveedor (código, descripción, cajas, unidad, precio unitario).
  const [codigoBusqueda, setCodigoBusqueda] = useState("");
  const [resultadosCodigo, setResultadosCodigo] = useState<Producto[]>([]);
  const [mostrarDropdownCodigo, setMostrarDropdownCodigo] = useState(false);
  const [productoSeleccionado, setProductoSeleccionado] = useState<Producto | null>(null);
  const [nombreNuevo, setNombreNuevo] = useState("");
  const [categoriaNuevo, setCategoriaNuevo] = useState("");

  const [cajas, setCajas] = useState("0");
  const [unidadSuelta, setUnidadSuelta] = useState("0");
  const [unidadesPorPaquete, setUnidadesPorPaquete] = useState("1");
  const [precioPaquete, setPrecioPaquete] = useState("");
  const [margen, setMargen] = useState("30");
  const [aplicaIva, setAplicaIva] = useState(false);
  const [tasaIva, setTasaIva] = useState("16");
  const [aplicaDescuento, setAplicaDescuento] = useState(false);
  const [descuento, setDescuento] = useState("");

  const [lineas, setLineas] = useState<LineaFacturaBorrador[]>([]);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [ultimaFactura, setUltimaFactura] = useState<string | null>(null);

  // --- Historial de facturas ya registradas, con detalle de productos ---
  const [facturas, setFacturas] = useState<FacturaCompraResumen[]>([]);
  const [facturaDetalleAbierta, setFacturaDetalleAbierta] = useState<string | null>(null);
  const [itemsDetalleCompra, setItemsDetalleCompra] = useState<FacturaCompraItemDetalle[]>([]);

  // --- Edición de una factura ya registrada: reutiliza el mismo
  // formulario/tabla de "líneas" que una factura nueva — al guardar, si
  // esto tiene un id, se llama a editar_factura_compra en vez de
  // guardar_factura_compra. Solo se puede editar/eliminar mientras nada de
  // su stock se haya vendido y no tenga pagos al proveedor (ver columna
  // "editable" más abajo).
  const [editandoFacturaId, setEditandoFacturaId] = useState<string | null>(null);

  async function cargarProveedores() {
    const db = await getDb();
    const rows = await db.select<Proveedor[]>("SELECT * FROM proveedores ORDER BY nombre");
    setProveedores(rows);
  }

  async function cargarFacturas() {
    const db = await getDb();
    const rows = await db.select<FacturaCompraResumen[]>(
      `SELECT fc.id, fc.proveedor_id, fc.numero_factura, fc.fecha, pr.nombre as proveedor_nombre, fc.moneda,
              fc.tasa_cambio_dia, fc.monto_total_usd, fc.monto_pagado_usd, fc.estado,
              (fc.monto_pagado_usd <= 0 AND NOT EXISTS (
                SELECT 1 FROM lotes_producto lp
                WHERE lp.factura_compra_id = fc.id AND lp.cantidad_restante < lp.cantidad_inicial - 0.0001
              )) as editable
       FROM facturas_compra fc JOIN proveedores pr ON pr.id = fc.proveedor_id
       ORDER BY fc.fecha DESC LIMIT 50`
    );
    setFacturas(rows);
  }

  useEffect(() => {
    cargarProveedores();
    cargarFacturas();
  }, []);

  async function toggleDetalleFactura(id: string) {
    if (facturaDetalleAbierta === id) {
      setFacturaDetalleAbierta(null);
      setItemsDetalleCompra([]);
      return;
    }
    setFacturaDetalleAbierta(id);
    const db = await getDb();
    const items = await db.select<FacturaCompraItemDetalle[]>(
      `SELECT p.nombre as producto_nombre, p.codigo_barra, i.cajas, i.unidad_suelta, i.unidades_por_paquete,
              i.cantidad, i.costo_unitario_usd, i.precio_venta_calculado, i.aplica_iva, i.tasa_iva_aplicada,
              i.aplica_descuento, i.descuento_aplicado
       FROM items_factura_compra i JOIN productos p ON p.id = i.producto_id
       WHERE i.factura_compra_id = $1`,
      [id]
    );
    setItemsDetalleCompra(items);
  }

  // Precarga una factura existente en el formulario de arriba, en modo
  // edición — mismas líneas, editables en la misma tabla que una factura
  // nueva. El costo unitario que trae ya incluye IVA/descuento aplicados
  // en su momento, así que se carga directo como "precio unitario" con
  // cajas=1 y sin volver a marcar IVA/descuento (si hace falta cambiarlos,
  // se ajusta el costo unitario a mano).
  async function cargarFacturaParaEditar(f: FacturaCompraResumen) {
    const db = await getDb();
    const items = await db.select<FacturaCompraItemEditable[]>(
      `SELECT p.id as producto_id, p.codigo_barra, p.codigo_proveedor, p.nombre as producto_nombre,
              i.cantidad, i.costo_unitario_usd, i.margen_aplicado
       FROM items_factura_compra i JOIN productos p ON p.id = i.producto_id
       WHERE i.factura_compra_id = $1`,
      [f.id]
    );
    setProveedorId(f.proveedor_id);
    setMostrarNuevoProveedor(false);
    setNumeroFactura(f.numero_factura);
    setMoneda(f.moneda as "USD" | "VES");
    setTasaFactura(String(f.tasa_cambio_dia));
    setLineas(
      items.map((it) => ({
        producto_id: it.producto_id,
        codigo_barra: it.codigo_barra,
        codigoProveedor: it.codigo_proveedor ?? undefined,
        nombre: it.producto_nombre,
        es_nuevo: false,
        cajas: 0,
        unidadSuelta: it.cantidad,
        unidadesPorPaquete: 1,
        precioPaqueteIngresado: it.costo_unitario_usd,
        margen_aplicado: it.margen_aplicado,
        aplicaIva: false,
        tasaIva: 0,
        aplicaDescuento: false,
        descuentoPct: 0,
      }))
    );
    setEditandoFacturaId(f.id);
    setFacturaDetalleAbierta(null);
    setMensaje(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelarEdicionFactura() {
    setEditandoFacturaId(null);
    setLineas([]);
    setNumeroFactura("");
    setMensaje(null);
  }

  async function eliminarFactura(f: FacturaCompraResumen) {
    if (!f.editable) return;
    if (!window.confirm(`¿Eliminar la factura ${f.numero_factura}? Esto revierte el stock que había sumado.`)) {
      return;
    }
    try {
      await invoke("eliminar_factura_compra", { facturaId: f.id });
    } catch (e) {
      setMensaje(`No se pudo eliminar la factura: ${String(e)}`);
      return;
    }
    if (editandoFacturaId === f.id) cancelarEdicionFactura();
    if (facturaDetalleAbierta === f.id) {
      setFacturaDetalleAbierta(null);
      setItemsDetalleCompra([]);
    }
    await cargarFacturas();
  }

  async function guardarProveedor() {
    if (!nombreProv || !rifProv) return;
    const db = await getDb();
    const id = crypto.randomUUID();
    await db.execute(
      "INSERT INTO proveedores (id, nombre, rif, direccion, telefono) VALUES ($1,$2,$3,$4,$5)",
      [id, nombreProv, rifProv, direccionProv || null, telefonoProv || null]
    );
    await cargarProveedores();
    setProveedorId(id);
    setMostrarNuevoProveedor(false);
    setNombreProv("");
    setRifProv("");
    setDireccionProv("");
    setTelefonoProv("");
  }

  async function guardarApiKey() {
    if (!geminiKeyInput.trim()) return;
    const db = await getDb();
    await db.execute("UPDATE config SET gemini_api_key = $1 WHERE id = 1", [geminiKeyInput.trim()]);
    setGeminiKeyInput("");
    setMostrarConfigIA(false);
    onConfigActualizado();
  }

  // Achica y recomprime la foto en el navegador antes de mandarla — más
  // rápido de subir y más barato de procesar, sin perder legibilidad del
  // texto de la factura.
  async function redimensionarImagen(file: File): Promise<{ base64: string; mimeType: string }> {
    const bitmap = await createImageBitmap(file);
    const maxLado = 1800;
    const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * escala);
    const h = Math.round(bitmap.height * escala);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo procesar la imagen.");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo comprimir la imagen."))), "image/jpeg", 0.85)
    );
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { base64: dataUrl.split(",")[1], mimeType: "image/jpeg" };
  }

  // Vuelca lo que extrajo la IA sobre el formulario normal — proveedor,
  // datos de la factura y cada línea — sin guardar nada todavía. Es
  // exactamente como si alguien lo hubiera tecleado, para que la persona
  // revise y corrija antes de "Guardar factura".
  async function aplicarExtraccion(extraida: FacturaExtraidaIA) {
    const rifExtraido = extraida.proveedor.rif?.trim().toUpperCase();
    const proveedorExistente = rifExtraido
      ? proveedores.find((p) => p.rif.trim().toUpperCase() === rifExtraido)
      : undefined;
    if (proveedorExistente) {
      setProveedorId(proveedorExistente.id);
      setMostrarNuevoProveedor(false);
    } else {
      setMostrarNuevoProveedor(true);
      setNombreProv(extraida.proveedor.nombre ?? "");
      setRifProv(extraida.proveedor.rif ?? "");
      setDireccionProv(extraida.proveedor.direccion ?? "");
      setTelefonoProv(extraida.proveedor.telefono ?? "");
    }

    if (extraida.numero_factura) setNumeroFactura(extraida.numero_factura);
    if (extraida.moneda === "USD" || extraida.moneda === "VES") setMoneda(extraida.moneda);

    const db = await getDb();
    const nuevasLineas: LineaFacturaBorrador[] = [];
    for (const item of extraida.items) {
      // El código que extrae la IA es el del PROVEEDOR, no el de barras
      // real — se busca contra el código de barras (por si ya tiene uno
      // real asignado), el código de proveedor "legado" (compatibilidad
      // con productos de antes de esta tabla) y la tabla de códigos por
      // proveedor (un mismo producto puede tener un código distinto según
      // a quién se le compre — así no se duplica al pedirlo a otro
      // proveedor con su propio código).
      let existente: Producto | null = null;
      const codigo = item.codigo?.trim();
      if (codigo) {
        const rows = await db.select<Producto[]>(
          `SELECT * FROM productos
           WHERE codigo_barra = $1 OR codigo_proveedor = $1
              OR id IN (SELECT producto_id FROM codigos_proveedor_producto WHERE proveedor_id = $2 AND codigo = $1)`,
          [codigo, proveedorId]
        );
        existente = rows[0] ?? null;
      }
      nuevasLineas.push({
        producto_id: existente ? existente.id : crypto.randomUUID(),
        codigo_barra: existente ? existente.codigo_barra : `SINCOD-${crypto.randomUUID()}`,
        codigoProveedor: codigo,
        // Si ya existe, se mantiene SU nombre (puede haber sido editado a
        // mano desde que se compró la primera vez) — nunca el que acaba de
        // leer la IA de esta factura nueva.
        nombre: existente ? existente.nombre : item.nombre,
        es_nuevo: !existente,
        categoria: undefined,
        cajas: item.cajas,
        unidadSuelta: item.unidad_suelta,
        unidadesPorPaquete: item.unidades_por_caja || existente?.unidades_por_paquete || 1,
        precioPaqueteIngresado: item.precio_unitario,
        margen_aplicado: existente?.margen_porcentaje ?? 30,
        aplicaIva: item.aplica_iva,
        tasaIva: item.aplica_iva ? item.tasa_iva ?? 16 : 0,
        aplicaDescuento: item.aplica_descuento,
        descuentoPct: item.aplica_descuento ? item.descuento_pct ?? 0 : 0,
        costoAnteriorUsd: existente?.costo_actual_usd,
        stockAnteriorUnidades: existente?.stock_actual,
      });
    }
    setLineas((prev) => [...prev, ...nuevasLineas]);

    setAvisoEscaneo(
      nuevasLineas.length > 0
        ? `Se extrajeron ${nuevasLineas.length} producto${nuevasLineas.length === 1 ? "" : "s"} de la foto — revisa cada línea (cantidades, precio, margen) antes de guardar. Los productos nuevos quedan sin código de barras hasta que alguien lo escanee en la tienda (ver Inventario). La IA puede equivocarse.`
        : "No se detectaron productos en la foto. Prueba con una imagen más clara o carga la factura a mano."
    );
  }

  async function escanearFactura(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMensaje(null);
    setAvisoEscaneo(null);
    setEscaneando(true);
    try {
      const { base64, mimeType } = await redimensionarImagen(file);
      const extraida = await invoke<FacturaExtraidaIA>("escanear_factura", {
        imagenBase64: base64,
        mimeType,
      });
      await aplicarExtraccion(extraida);
    } catch (err) {
      setMensaje(`No se pudo leer la factura: ${String(err)}`);
    } finally {
      setEscaneando(false);
    }
  }

  // mantenerCodigoEscrito: true cuando esto se dispara por encontrar una
  // coincidencia EXACTA con lo que la persona ya tecleó — puede ser el
  // código de un proveedor nuevo para este producto, distinto al que
  // tenía guardado, y justo ESE es el que hay que conservar para guardarlo
  // como el código de este proveedor. Cuando en cambio se elige de la
  // lista de sugerencias por nombre (se pudo haber tecleado parte del
  // nombre, no un código), no tiene sentido guardar eso como código —
  // ahí se reemplaza por el código que el sistema ya le conoce al
  // producto, editable después a mano si hace falta.
  function seleccionarProductoExistente(p: Producto, mantenerCodigoEscrito = false) {
    setProductoSeleccionado(p);
    if (!mantenerCodigoEscrito) {
      setCodigoBusqueda(p.codigo_proveedor ?? p.codigo_barra);
    }
    setNombreNuevo(p.nombre);
    setCategoriaNuevo("");
    setMargen(p.margen_porcentaje != null ? String(p.margen_porcentaje) : "30");
    setUnidadesPorPaquete(String(p.unidades_por_paquete || 1));
    setResultadosCodigo([]);
    setMostrarDropdownCodigo(false);
  }

  function tratarComoNuevo() {
    setProductoSeleccionado(null);
    setNombreNuevo("");
    setCategoriaNuevo("");
    setMargen("30");
    setUnidadesPorPaquete("1");
  }

  // Busca por código exacto — de barras O de proveedor (lo normal al leer
  // una factura es que se tenga el código del proveedor, no el de barras
  // real; ver Compras.tsx arriba). Si no hay coincidencia exacta, sugiere
  // productos parecidos por si ya existen con otro código, para no crear
  // un duplicado sin querer.
  useEffect(() => {
    const term = codigoBusqueda.trim();
    if (productoSeleccionado && (productoSeleccionado.codigo_proveedor === term || productoSeleccionado.codigo_barra === term)) {
      return;
    }
    if (term.length < 1) {
      setResultadosCodigo([]);
      setMostrarDropdownCodigo(false);
      return;
    }
    const timer = setTimeout(async () => {
      const db = await getDb();
      // Coincidencia exacta: por código de barras, por el código de
      // proveedor "legado" (compatibilidad) o por la tabla de códigos por
      // proveedor — de la fuente autoritativa, no de la caché local, para
      // no arriesgarse a duplicar un producto por una lectura desfasada.
      const exactas = await db.select<Producto[]>(
        `SELECT * FROM productos
         WHERE codigo_barra = $1 OR codigo_proveedor = $1
            OR id IN (SELECT producto_id FROM codigos_proveedor_producto WHERE proveedor_id = $2 AND codigo = $1)`,
        [term, proveedorId]
      );
      if (exactas.length > 0) {
        seleccionarProductoExistente(exactas[0], true);
        return;
      }
      // Ya no se limpia productoSeleccionado acá aunque este código nuevo
      // no matchee nada — puede ser justo que la persona esté corrigiendo
      // el código de un producto que YA eligió (ej. tras encontrarlo por
      // nombre y ahora tipeando el código real del proveedor nuevo). Solo
      // se deselecciona con "no es este, crear nuevo" (tratarComoNuevo).
      const rows = await db.selectRapido<Producto[]>(
        `SELECT * FROM productos WHERE codigo_barra LIKE $1 OR codigo_proveedor LIKE $1 OR ${sqlSinAcentos("nombre")} LIKE $2 ORDER BY nombre LIMIT 6`,
        [`%${term}%`, `%${normalizarTexto(term)}%`]
      );
      setResultadosCodigo(rows);
      setMostrarDropdownCodigo(rows.length > 0);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codigoBusqueda]);

  const cajasNum = Number(cajas || "0");
  const unidadSueltaNum = Number(unidadSuelta || "0");
  const unidadesPorPaqueteNum = Number(unidadesPorPaquete || "1");
  const precioPaqueteNum = Number(precioPaquete || "0");
  const tasaIvaNum = Number(tasaIva || "0");
  const descuentoNum = Number(descuento || "0");
  const cantidadPreview = cajasNum * unidadesPorPaqueteNum + unidadSueltaNum;
  const costoUnitPreviewBase = cajasNum > 0 ? precioPaqueteNum / (unidadesPorPaqueteNum || 1) : precioPaqueteNum;
  const costoUnitPreviewConDescuento = aplicaDescuento
    ? costoUnitPreviewBase * (1 - descuentoNum / 100)
    : costoUnitPreviewBase;
  const costoUnitPreview = aplicaIva ? costoUnitPreviewConDescuento * (1 + tasaIvaNum / 100) : costoUnitPreviewConDescuento;
  const totalLineaPreview = cantidadPreview * costoUnitPreview;
  // En USD, para comparar contra productoSeleccionado.costo_actual_usd
  // (que siempre está en USD) sin importar en qué moneda esté la factura.
  const costoUnitPreviewUsd = moneda === "USD" ? costoUnitPreview : costoUnitPreview / (Number(tasaFactura) || 1);
  const stockPrevioPreview = productoSeleccionado?.stock_actual ?? 0;
  const hayCambioDePrecioPreview =
    productoSeleccionado != null &&
    stockPrevioPreview > 0 &&
    Math.abs(costoUnitPreviewUsd - productoSeleccionado.costo_actual_usd) > 0.0001;
  const costoPromedioPreview =
    productoSeleccionado != null && stockPrevioPreview > 0
      ? (stockPrevioPreview * productoSeleccionado.costo_actual_usd + cantidadPreview * costoUnitPreviewUsd) /
        (stockPrevioPreview + cantidadPreview)
      : costoUnitPreviewUsd;

  function agregarLinea() {
    setMensaje(null);

    const codigo = codigoBusqueda.trim();
    if (!codigo) {
      setMensaje("Falta el código del proveedor.");
      return;
    }
    if (unidadesPorPaqueteNum <= 0) {
      setMensaje("Las unidades por caja deben ser mayor a 0.");
      return;
    }
    if (cantidadPreview <= 0) {
      setMensaje("Indica cuántas cajas o unidades sueltas compraste.");
      return;
    }
    if (!precioPaqueteNum || precioPaqueteNum <= 0) {
      setMensaje("El precio unitario debe ser mayor a 0.");
      return;
    }
    if (aplicaIva && (!tasaIvaNum || tasaIvaNum <= 0)) {
      setMensaje("Indica el % de IVA de este producto.");
      return;
    }
    if (aplicaDescuento && (!descuentoNum || descuentoNum <= 0 || descuentoNum >= 100)) {
      setMensaje("Indica el % de descuento de este producto (entre 0 y 100).");
      return;
    }

    if (productoSeleccionado) {
      setLineas((prev) => [
        ...prev,
        {
          producto_id: productoSeleccionado.id,
          codigo_barra: productoSeleccionado.codigo_barra,
          codigoProveedor: codigo,
          nombre: productoSeleccionado.nombre,
          es_nuevo: false,
          cajas: cajasNum,
          unidadSuelta: unidadSueltaNum,
          unidadesPorPaquete: unidadesPorPaqueteNum,
          precioPaqueteIngresado: precioPaqueteNum,
          margen_aplicado: Number(margen || "0"),
          aplicaIva,
          tasaIva: aplicaIva ? tasaIvaNum : 0,
          aplicaDescuento,
          descuentoPct: aplicaDescuento ? descuentoNum : 0,
          costoAnteriorUsd: productoSeleccionado.costo_actual_usd,
          stockAnteriorUnidades: productoSeleccionado.stock_actual,
        },
      ]);
    } else {
      if (!nombreNuevo.trim()) {
        setMensaje("Para un producto nuevo necesitas el nombre.");
        return;
      }
      setLineas((prev) => [
        ...prev,
        {
          // Se genera de una vez — el producto se crea al guardar la
          // factura completa, junto con todo lo demás, en una sola
          // transacción atómica. El código de barras NO se conoce todavía
          // (el que se tecleó acá es el código del proveedor, no el de
          // venta) — queda pendiente de escanear en Inventario o en la
          // primera venta (ver Venta.tsx).
          producto_id: crypto.randomUUID(),
          codigo_barra: `SINCOD-${crypto.randomUUID()}`,
          codigoProveedor: codigo,
          nombre: nombreNuevo.trim(),
          es_nuevo: true,
          categoria: categoriaNuevo || undefined,
          cajas: cajasNum,
          unidadSuelta: unidadSueltaNum,
          unidadesPorPaquete: unidadesPorPaqueteNum,
          precioPaqueteIngresado: precioPaqueteNum,
          margen_aplicado: Number(margen || "0"),
          aplicaIva,
          tasaIva: aplicaIva ? tasaIvaNum : 0,
          aplicaDescuento,
          descuentoPct: aplicaDescuento ? descuentoNum : 0,
        },
      ]);
    }

    // limpiar el formulario, listo para la siguiente línea de la factura
    setCodigoBusqueda("");
    setResultadosCodigo([]);
    setMostrarDropdownCodigo(false);
    setProductoSeleccionado(null);
    setNombreNuevo("");
    setCategoriaNuevo("");
    setCajas("0");
    setUnidadSuelta("0");
    setUnidadesPorPaquete("1");
    setPrecioPaquete("");
    setMargen("30");
    setAplicaIva(false);
    setTasaIva("16");
    setAplicaDescuento(false);
    setDescuento("");
  }

  function quitarLinea(idx: number) {
    setLineas((prev) => prev.filter((_, i) => i !== idx));
  }

  // Cada campo de una línea ya agregada se edita directo en su casilla en
  // la tabla (ver abajo) — clave sobre todo para las líneas que trae el
  // escaneo con IA, que hay que poder corregir sin tener que pasar de
  // nuevo por el formulario del Paso 3.
  function actualizarLinea(idx: number, cambios: Partial<LineaFacturaBorrador>) {
    setLineas((prev) => prev.map((l, i) => (i === idx ? { ...l, ...cambios } : l)));
  }

  function unidadesTotales(l: LineaFacturaBorrador) {
    return l.cajas * l.unidadesPorPaquete + l.unidadSuelta;
  }

  function costoUnitarioIngresado(l: LineaFacturaBorrador) {
    return l.cajas > 0 ? l.precioPaqueteIngresado / l.unidadesPorPaquete : l.precioPaqueteIngresado;
  }

  function costoUsdDeLinea(l: LineaFacturaBorrador) {
    const costoUnit = costoUnitarioIngresado(l);
    const costoBase = moneda === "USD" ? costoUnit : costoUnit / Number(tasaFactura);
    // El descuento se aplica sobre el costo base (igual que en una factura
    // de papel), y el IVA se calcula después, sobre lo que queda con
    // descuento ya restado. El IVA que se le paga al proveedor es parte
    // del costo real de la mercancía (este negocio no lo recupera como
    // crédito fiscal), así que ambos quedan incluidos acá — de esta forma
    // cascada solo hasta el precio de venta (costo + margen) sin tener que
    // tocar nada más.
    const costoConDescuento = l.aplicaDescuento ? costoBase * (1 - l.descuentoPct / 100) : costoBase;
    return l.aplicaIva ? costoConDescuento * (1 + l.tasaIva / 100) : costoConDescuento;
  }

  // "Margen" es margen bruto sobre el precio de venta (igual que en
  // precios.ts) — con costo 2.99 y margen 30%, el precio da 4.27 (2.99 /
  // 0.70), no 3.89. Se topa en 99.99 para no dividir por cero o un número
  // negativo si se escribe 100 o más por error.
  function precioBsDeLinea(l: LineaFacturaBorrador) {
    const margen = Math.min(Math.max(l.margen_aplicado, 0), 99.99);
    return (costoUsdDeLinea(l) / (1 - margen / 100)) * Number(tasaFactura);
  }

  // Costo que queda VIGENTE para el producto tras esta línea — el promedio
  // ponderado entre el stock que ya tenía (a su costo anterior) y esta
  // compra nueva. Ya no esperamos a que se agote el stock viejo para
  // empezar a vender al precio nuevo: el promedio pasa a mandar de una vez,
  // apenas se guarda la factura.
  function costoVigenteDeLinea(l: LineaFacturaBorrador) {
    const costoNuevo = costoUsdDeLinea(l);
    const stockPrevio = l.stockAnteriorUnidades ?? 0;
    if (l.costoAnteriorUsd == null || stockPrevio <= 0) return costoNuevo;
    const cantidadNueva = unidadesTotales(l);
    return (stockPrevio * l.costoAnteriorUsd + cantidadNueva * costoNuevo) / (stockPrevio + cantidadNueva);
  }

  function precioVentaVigenteBsDeLinea(l: LineaFacturaBorrador) {
    const margen = Math.min(Math.max(l.margen_aplicado, 0), 99.99);
    return (costoVigenteDeLinea(l) / (1 - margen / 100)) * Number(tasaFactura);
  }

  const montoTotalUsd = lineas.reduce((acc, l) => acc + costoUsdDeLinea(l) * unidadesTotales(l), 0);
  const montoTotalBs = montoTotalUsd * Number(tasaFactura || "0");

  // Líneas donde el costo vigente que va a quedar tras guardar difiere del
  // costo que tenía el producto antes de esta factura — puramente
  // informativo, ya se puede corregir directo en la tabla si hace falta.
  const lineasConCambioDeCosto = lineas.filter(
    (l) =>
      l.costoAnteriorUsd != null &&
      (l.stockAnteriorUnidades ?? 0) > 0 &&
      Math.abs(costoVigenteDeLinea(l) - l.costoAnteriorUsd) > 0.0001
  );

  async function guardarFactura() {
    setMensaje(null);
    if (!proveedorId) {
      setMensaje("Selecciona o crea un proveedor primero.");
      return;
    }
    if (!numeroFactura) {
      setMensaje("Falta el número de factura.");
      return;
    }
    if (lineas.length === 0) {
      setMensaje("Agrega al menos un producto a la factura.");
      return;
    }
    const tasa = Number(tasaFactura);
    if (!tasa || tasa <= 0) {
      setMensaje("La tasa del día de esta compra debe ser mayor a 0.");
      return;
    }

    setGuardando(true);
    const facturaId = editandoFacturaId ?? crypto.randomUUID();
    const input = {
      id: facturaId,
      proveedor_id: proveedorId,
      numero_factura: numeroFactura,
      fecha_hora: fechaHoraVenezuela(),
      moneda,
      tasa_cambio_dia: tasa,
      items: lineas.map((l) => ({
        producto_id: l.producto_id,
        es_nuevo: l.es_nuevo,
        codigo_barra: l.codigo_barra,
        codigo_proveedor: l.codigoProveedor ?? null,
        nombre: l.nombre,
        categoria_nombre: l.categoria ?? null,
        cajas: l.cajas,
        unidad_suelta: l.unidadSuelta,
        unidades_por_paquete: l.unidadesPorPaquete,
        cantidad_total: unidadesTotales(l),
        costo_unitario_usd: costoUsdDeLinea(l),
        margen_aplicado: l.margen_aplicado,
        precio_venta_bs: precioBsDeLinea(l),
        costo_vigente_usd: costoVigenteDeLinea(l),
        margen_vigente: l.margen_aplicado,
        precio_venta_vigente_bs: precioVentaVigenteBsDeLinea(l),
        aplica_iva: l.aplicaIva,
        tasa_iva_aplicada: l.tasaIva,
        aplica_descuento: l.aplicaDescuento,
        descuento_aplicado: l.descuentoPct,
      })),
    };

    try {
      // Todo esto — la factura, los productos nuevos, las líneas, el
      // stock y el movimiento de inventario — se guarda en una sola
      // transacción atómica real dentro de Rust (ver
      // src-tauri/src/comandos.rs). Si algo falla a mitad de camino, no
      // queda nada a medias. Editar una factura existente es "deshacer y
      // volver a cargar" por debajo, con el mismo chequeo de elegibilidad
      // que "eliminar".
      if (editandoFacturaId) {
        await invoke("editar_factura_compra", { facturaId: editandoFacturaId, input });
      } else {
        await invoke("guardar_factura_compra", { input });
      }
    } catch (e) {
      setMensaje(`No se pudo guardar la factura: ${String(e)}`);
      setGuardando(false);
      return;
    }

    setGuardando(false);
    setUltimaFactura(numeroFactura);
    setLineas([]);
    setNumeroFactura("");
    setEditandoFacturaId(null);
    await cargarFacturas();
  }

  if (ultimaFactura) {
    return (
      <div className="card">
        <h2>Factura {ultimaFactura} guardada ✅</h2>
        <p>El stock y los precios de los productos ya quedaron actualizados.</p>
        <button onClick={() => setUltimaFactura(null)}>Cargar otra factura</button>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>Escanear factura con IA (opcional)</h2>
        <p className="hint">
          Sube una foto de la factura del proveedor y se pre-llenan el proveedor y cada línea de
          producto abajo — igual tienes que revisarlas y apretar "Guardar factura" al final.
        </p>

        {!config.gemini_api_key || mostrarConfigIA ? (
          <div className="form-row" style={{ alignItems: "center" }}>
            <input
              placeholder="API key de Gemini"
              type="password"
              value={geminiKeyInput}
              onChange={(e) => setGeminiKeyInput(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <button type="button" onClick={guardarApiKey}>
              Guardar API key
            </button>
            {config.gemini_api_key && (
              <button type="button" className="link-btn" onClick={() => setMostrarConfigIA(false)}>
                cancelar
              </button>
            )}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer"
              className="hint"
              style={{ margin: 0 }}
            >
              Sacar una key gratis en Google AI Studio ↗
            </a>
          </div>
        ) : (
          <div className="form-row" style={{ alignItems: "center" }}>
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={escaneando}>
              {escaneando ? "Leyendo factura…" : "📷 Escanear factura con IA"}
            </button>
            <button type="button" className="link-btn" onClick={() => setMostrarConfigIA(true)}>
              cambiar API key
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={escanearFactura}
        />

        {avisoEscaneo && (
          <p className="aviso-credito" style={{ marginTop: 10 }}>
            {avisoEscaneo}
          </p>
        )}
      </div>

      <div className="card">
        <div className="paso-titulo">
          <span className="paso-numero">1</span>
          <h2 style={{ margin: 0 }}>Proveedor</h2>
        </div>
        {!mostrarNuevoProveedor ? (
          <div className="form-grid form-grid-ancho">
            <Campo label="Proveedor">
              <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
                <option value="">Selecciona un proveedor…</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} — {p.rif}
                  </option>
                ))}
              </select>
            </Campo>
            <div className="campo-boton">
              <button type="button" onClick={() => setMostrarNuevoProveedor(true)}>
                + Nuevo proveedor
              </button>
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <Campo label="Nombre">
              <input value={nombreProv} onChange={(e) => setNombreProv(e.target.value)} />
            </Campo>
            <Campo label="RIF">
              <input value={rifProv} onChange={(e) => setRifProv(e.target.value)} />
            </Campo>
            <Campo label="Dirección (opcional)">
              <input value={direccionProv} onChange={(e) => setDireccionProv(e.target.value)} />
            </Campo>
            <Campo label="Teléfono (opcional)">
              <input value={telefonoProv} onChange={(e) => setTelefonoProv(e.target.value)} />
            </Campo>
            <div className="campo-boton">
              <button type="button" onClick={guardarProveedor}>
                Guardar proveedor
              </button>
            </div>
            <div className="campo-boton">
              <button
                type="button"
                className="link-btn"
                style={{ fontSize: 14 }}
                onClick={() => setMostrarNuevoProveedor(false)}
              >
                cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="paso-titulo">
          <span className="paso-numero">2</span>
          <h2 style={{ margin: 0 }}>Datos de la factura</h2>
        </div>
        <div className="form-grid">
          <Campo label="Número de factura">
            <input value={numeroFactura} onChange={(e) => setNumeroFactura(e.target.value)} />
          </Campo>
          <Campo label="Moneda de la factura">
            <select value={moneda} onChange={(e) => setMoneda(e.target.value as "USD" | "VES")}>
              <option value="USD">USD (dólares)</option>
              <option value="VES">Bs (bolívares)</option>
            </select>
          </Campo>
          <Campo label="Tasa del día de esta compra">
            <input type="number" step="0.01" value={tasaFactura} onChange={(e) => setTasaFactura(e.target.value)} />
          </Campo>
        </div>
      </div>

      <div className="card">
        <div className="paso-titulo">
          <span className="paso-numero">3</span>
          <h2 style={{ margin: 0 }}>Agregar producto a la factura</h2>
        </div>
        <p className="hint">
          Copia los datos tal cual salen en la factura del proveedor, línea por línea. Si el
          código ya existe, se reconoce solo; si no, se crea el producto nuevo al guardar. Este
          código es el del PROVEEDOR (el que trae su factura) — no hace falta el código de barras
          real, eso se asigna después escaneándolo en la tienda (ver "pendientes de código de
          barras" en Inventario).
        </p>

        <div style={{ position: "relative", maxWidth: 420, marginTop: 12 }}>
          <Campo label="Código del proveedor (como en la factura)">
            <input
              value={codigoBusqueda}
              onChange={(e) => setCodigoBusqueda(e.target.value)}
              onFocus={() => resultadosCodigo.length > 0 && setMostrarDropdownCodigo(true)}
              onBlur={() => setTimeout(() => setMostrarDropdownCodigo(false), 150)}
              autoFocus
            />
          </Campo>
          {mostrarDropdownCodigo && resultadosCodigo.length > 0 && (
            <ul
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                background: "#fff",
                border: "1px solid #d3d1c7",
                borderRadius: 8,
                listStyle: "none",
                margin: 0,
                padding: 4,
                zIndex: 10,
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              }}
            >
              {resultadosCodigo.map((p) => (
                <li
                  key={p.id}
                  onMouseDown={() => seleccionarProductoExistente(p)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 14,
                  }}
                >
                  <span>{p.nombre}</span>
                  <span style={{ color: "#5f5e5a" }}>{p.codigo_barra}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          {productoSeleccionado ? (
            <div className="aviso-producto aviso-producto-existente">
              <span>
                ✓ Producto existente: <strong>{productoSeleccionado.nombre}</strong> (stock
                actual: {formatearStock(productoSeleccionado.stock_actual)})
              </span>
              <button className="link-btn" onClick={tratarComoNuevo}>
                no es este, crear nuevo
              </button>
            </div>
          ) : (
            codigoBusqueda.trim() && (
              <>
                <div className="aviso-producto aviso-producto-nuevo" style={{ marginBottom: 12 }}>
                  <span>⚠ Este código no existe todavía — se creará un producto nuevo.</span>
                </div>
                <div className="form-grid">
                  <Campo label="Nombre / descripción del producto">
                    <input value={nombreNuevo} onChange={(e) => setNombreNuevo(e.target.value)} />
                  </Campo>
                  <Campo label="Categoría (opcional)">
                    <input value={categoriaNuevo} onChange={(e) => setCategoriaNuevo(e.target.value)} />
                  </Campo>
                </div>
              </>
            )
          )}
        </div>

        <div className="form-grid" style={{ marginTop: 16 }}>
          <Campo label="Cajas">
            <input type="number" step="0.01" value={cajas} onChange={(e) => setCajas(e.target.value)} />
          </Campo>
          <Campo label="Unidad suelta">
            <input type="number" step="0.01" value={unidadSuelta} onChange={(e) => setUnidadSuelta(e.target.value)} />
          </Campo>
          <Campo label="Unid. por caja">
            <input
              type="number"
              step="1"
              value={unidadesPorPaquete}
              onChange={(e) => setUnidadesPorPaquete(e.target.value)}
            />
          </Campo>
          <Campo label={`Precio unitario (${moneda})`}>
            <input type="number" step="0.01" value={precioPaquete} onChange={(e) => setPrecioPaquete(e.target.value)} />
          </Campo>
          <Campo label="Margen %">
            <input type="number" step="1" value={margen} onChange={(e) => setMargen(e.target.value)} />
          </Campo>
          <Campo label="¿Lleva IVA?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, height: 38 }}>
              <input type="checkbox" checked={aplicaIva} onChange={(e) => setAplicaIva(e.target.checked)} />
              Sí
            </label>
          </Campo>
          {aplicaIva && (
            <Campo label="% IVA">
              <input type="number" step="0.01" value={tasaIva} onChange={(e) => setTasaIva(e.target.value)} />
            </Campo>
          )}
          <Campo label="¿Tiene descuento?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, height: 38 }}>
              <input
                type="checkbox"
                checked={aplicaDescuento}
                onChange={(e) => setAplicaDescuento(e.target.checked)}
              />
              Sí
            </label>
          </Campo>
          {aplicaDescuento && (
            <Campo label="% Descuento">
              <input type="number" step="0.01" value={descuento} onChange={(e) => setDescuento(e.target.value)} />
            </Campo>
          )}
          <div className="campo-boton">
            <button type="button" onClick={agregarLinea}>
              + Agregar línea
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          "Precio unitario" es el precio por caja (o por unidad si no compras por caja), SIN IVA y
          SIN descuento. "Unid. por caja" es cuántas unidades individuales trae la caja de este
          producto. No todos los productos de una factura llevan IVA o descuento — márcalo solo si
          corresponde a esa línea; el costo real por unidad ya los incluye (primero se resta el
          descuento y sobre eso se calcula el IVA, igual que en una factura de papel).
        </p>

        {precioPaqueteNum > 0 && (
          <div className="previsualizacion" style={{ marginTop: 10 }}>
            Se agregarán <strong>{cantidadPreview}</strong> unidades a costo de{" "}
            <strong>{costoUnitPreview.toFixed(4)}</strong> {moneda} c/u
            {(aplicaDescuento || aplicaIva) && (
              <>
                {" ("}
                {[
                  aplicaDescuento ? `${descuentoNum}% descuento` : null,
                  aplicaIva ? `${tasaIvaNum}% IVA` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {")"}
              </>
            )}{" "}
            · Total de esta línea:{" "}
            <strong>
              {totalLineaPreview.toFixed(2)} {moneda}
            </strong>
            <br />
            <span className="hint" style={{ marginTop: 4 }}>
              Compara este total contra el de la factura de papel.
            </span>
          </div>
        )}

        {hayCambioDePrecioPreview && productoSeleccionado && (
          <p className="aviso-credito" style={{ marginTop: 10 }}>
            ⚠ Este precio (USD {costoUnitPreviewUsd.toFixed(4)}) es distinto al costo actual de{" "}
            <strong>{productoSeleccionado.nombre}</strong> (USD {productoSeleccionado.costo_actual_usd.toFixed(4)}),
            que todavía tiene {stockPrevioPreview} en stock. Al agregar esta línea, el costo vigente
            del producto pasa a ser el promedio ponderado entre ese stock y esta compra:{" "}
            <strong>USD {costoPromedioPreview.toFixed(4)}</strong>. Revísalo antes de agregar la
            línea — puedes ajustar el precio o el margen arriba.
          </p>
        )}

        {mensaje && (
          <p className="error" style={{ marginTop: 10 }}>
            {mensaje}
          </p>
        )}
      </div>

      <div className="seccion-ancha">
      <div className="card">
        <h2>Líneas de la factura ({lineas.length})</h2>
        {editandoFacturaId && (
          <p className="aviso-credito">
            ✎ Editando la factura <strong>{numeroFactura}</strong> — al guardar se reemplazan sus
            líneas y se recalcula el stock.{" "}
            <button type="button" className="link-btn" onClick={cancelarEdicionFactura}>
              cancelar edición
            </button>
          </p>
        )}
        <p className="hint">
          Todos los valores se editan directo en su casilla — cámbialos si algo salió mal (sobre
          todo al escanear con IA) o déjalos tal cual si están correctos.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="tabla-compacta">
            <thead>
              <tr>
                <th>Código</th>
                <th>Producto</th>
                <th>Cajas</th>
                <th>Unid. suelta</th>
                <th>Unid./caja</th>
                <th>Cant. total</th>
                <th>Precio unit. ({moneda})</th>
                <th>Costo total USD</th>
                <th>Costo total Bs</th>
                <th>Margen %</th>
                <th>Precio Bs</th>
                <th>Descuento</th>
                <th>IVA</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lineas.map((l, i) => {
                const costoTotalUsdLinea = costoUsdDeLinea(l) * unidadesTotales(l);
                return (
                  <tr key={i}>
                    <td>
                      <input
                        className="cant-input"
                        style={{ width: 100 }}
                        value={l.codigo_barra}
                        onChange={(e) => actualizarLinea(i, { codigo_barra: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="cant-input"
                        style={{ width: 140 }}
                        value={l.nombre}
                        onChange={(e) => actualizarLinea(i, { nombre: e.target.value })}
                      />{" "}
                      {l.es_nuevo && <span className="badge badge-bajo">nuevo</span>}
                    </td>
                    <td>
                      <input
                        className="cant-input"
                        type="number"
                        step="0.01"
                        value={l.cajas}
                        onChange={(e) => actualizarLinea(i, { cajas: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td>
                      <input
                        className="cant-input"
                        type="number"
                        step="0.01"
                        value={l.unidadSuelta}
                        onChange={(e) => actualizarLinea(i, { unidadSuelta: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td>
                      <input
                        className="cant-input"
                        type="number"
                        step="1"
                        value={l.unidadesPorPaquete}
                        onChange={(e) =>
                          actualizarLinea(i, { unidadesPorPaquete: Number(e.target.value) || 1 })
                        }
                      />
                    </td>
                    <td>{unidadesTotales(l)}</td>
                    <td>
                      <input
                        className="cant-input"
                        type="number"
                        step="0.01"
                        value={l.precioPaqueteIngresado}
                        onChange={(e) =>
                          actualizarLinea(i, { precioPaqueteIngresado: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td>{costoTotalUsdLinea.toFixed(2)}</td>
                    <td>{(costoTotalUsdLinea * Number(tasaFactura || "0")).toFixed(2)}</td>
                    <td>
                      <input
                        className="cant-input"
                        style={{ width: 55 }}
                        type="number"
                        step="1"
                        value={l.margen_aplicado}
                        onChange={(e) => actualizarLinea(i, { margen_aplicado: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td>{precioBsDeLinea(l).toFixed(2)}</td>
                    <td>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                        <input
                          type="checkbox"
                          checked={l.aplicaDescuento}
                          onChange={(e) => actualizarLinea(i, { aplicaDescuento: e.target.checked })}
                        />
                        {l.aplicaDescuento && (
                          <input
                            className="cant-input"
                            style={{ width: 50 }}
                            type="number"
                            step="0.01"
                            value={l.descuentoPct}
                            onChange={(e) => actualizarLinea(i, { descuentoPct: Number(e.target.value) || 0 })}
                          />
                        )}
                      </label>
                    </td>
                    <td>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                        <input
                          type="checkbox"
                          checked={l.aplicaIva}
                          onChange={(e) => actualizarLinea(i, { aplicaIva: e.target.checked })}
                        />
                        {l.aplicaIva && (
                          <input
                            className="cant-input"
                            style={{ width: 50 }}
                            type="number"
                            step="0.01"
                            value={l.tasaIva}
                            onChange={(e) => actualizarLinea(i, { tasaIva: Number(e.target.value) || 0 })}
                          />
                        )}
                      </label>
                    </td>
                    <td>
                      <button className="link-btn link-btn-danger" onClick={() => quitarLinea(i)}>
                        quitar
                      </button>
                    </td>
                  </tr>
                );
              })}
              {lineas.length === 0 && (
                <tr>
                  <td colSpan={14} className="empty">
                    Sin líneas todavía. Agrégalas arriba, una por una.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {lineasConCambioDeCosto.length > 0 && (
          <p className="aviso-credito">
            ⚠ {lineasConCambioDeCosto.length === 1 ? "Este producto cambia" : "Estos productos cambian"}{" "}
            de costo vigente al guardar (promedio ponderado con el stock que ya tenían):{" "}
            {lineasConCambioDeCosto
              .map(
                (l) =>
                  `${l.nombre} (USD ${l.costoAnteriorUsd!.toFixed(4)} → USD ${costoVigenteDeLinea(l).toFixed(4)})`
              )
              .join(", ")}
            . Puedes guardar tal cual o ajustar los valores en la tabla de arriba.
          </p>
        )}

        <div className="totales">
          <span>
            Total factura: USD {montoTotalUsd.toFixed(2)}{" "}
            <span className="hint" style={{ margin: 0 }}>
              (Bs {montoTotalBs.toFixed(2)})
            </span>
          </span>
        </div>

        <button className="cobrar-btn" onClick={guardarFactura} disabled={guardando}>
          {guardando ? "Guardando…" : editandoFacturaId ? "Guardar cambios de la factura" : "Guardar factura"}
        </button>
      </div>
      </div>

      <div className="card">
        <h2>Facturas registradas</h2>
        <p className="hint">
          Últimas {facturas.length} facturas de proveedor. Abre una para ver el detalle de
          productos comprados. Solo se puede editar o eliminar una factura mientras nada de su
          stock se haya vendido y no tenga pagos registrados al proveedor — si no, la corrección
          segura es un ajuste de stock manual en la pestaña Movimientos.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Factura</th>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Moneda</th>
                <th>Total USD</th>
                <th>Total Bs</th>
                <th>Pagado USD</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {facturas.map((f) => (
                <Fragment key={f.id}>
                  <tr>
                    <td>{f.numero_factura}</td>
                    <td>{new Date(f.fecha.replace(" ", "T")).toLocaleDateString("es-VE")}</td>
                    <td>{f.proveedor_nombre}</td>
                    <td>{f.moneda}</td>
                    <td>{f.monto_total_usd.toFixed(2)}</td>
                    <td>{(f.monto_total_usd * f.tasa_cambio_dia).toFixed(2)}</td>
                    <td>{f.monto_pagado_usd.toFixed(2)}</td>
                    <td>{f.estado}</td>
                    <td>
                      <button className="link-btn" onClick={() => toggleDetalleFactura(f.id)}>
                        {facturaDetalleAbierta === f.id ? "ocultar detalle" : "ver detalle"}
                      </button>
                      {f.editable ? (
                        <>
                          <button className="link-btn" onClick={() => cargarFacturaParaEditar(f)}>
                            editar
                          </button>
                          <button className="link-btn link-btn-danger" onClick={() => eliminarFactura(f)}>
                            eliminar
                          </button>
                        </>
                      ) : (
                        <span className="hint" style={{ margin: 0 }}>
                          ya no editable
                        </span>
                      )}
                    </td>
                  </tr>
                  {facturaDetalleAbierta === f.id && (
                    <tr>
                      <td colSpan={9}>
                        <table>
                          <thead>
                            <tr>
                              <th>Producto</th>
                              <th>Código</th>
                              <th>Cajas</th>
                              <th>Unid. suelta</th>
                              <th>Unid./caja</th>
                              <th>Cant. total</th>
                              <th>Costo unit. USD</th>
                              <th>Costo total USD</th>
                              <th>Costo total Bs</th>
                              <th>Precio venta Bs</th>
                              <th>Descuento</th>
                              <th>IVA</th>
                            </tr>
                          </thead>
                          <tbody>
                            {itemsDetalleCompra.map((it, i) => {
                              const costoTotalUsdItem = it.costo_unitario_usd * it.cantidad;
                              return (
                                <tr key={i}>
                                  <td>{it.producto_nombre}</td>
                                  <td>{it.codigo_barra}</td>
                                  <td>{it.cajas}</td>
                                  <td>{it.unidad_suelta}</td>
                                  <td>{it.unidades_por_paquete}</td>
                                  <td>{it.cantidad}</td>
                                  <td>{it.costo_unitario_usd.toFixed(4)}</td>
                                  <td>{costoTotalUsdItem.toFixed(2)}</td>
                                  <td>{(costoTotalUsdItem * f.tasa_cambio_dia).toFixed(2)}</td>
                                  <td>{it.precio_venta_calculado.toFixed(2)}</td>
                                  <td>{it.aplica_descuento ? `${it.descuento_aplicado}%` : "—"}</td>
                                  <td>{it.aplica_iva ? `${it.tasa_iva_aplicada}%` : "—"}</td>
                                </tr>
                              );
                            })}
                            {itemsDetalleCompra.length === 0 && (
                              <tr>
                                <td colSpan={12} className="empty">
                                  Sin ítems.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {facturas.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">
                    Sin facturas registradas todavía.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
