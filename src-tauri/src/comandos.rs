// Comandos de Tauri que necesitan una transacción real contra la base
// compartida (Turso/libSQL, ver src/db.rs). Reciben todos los datos de una
// sola vez y hacen todo el trabajo dentro de una única transacción de
// libsql — si algo falla a mitad de camino, se hace rollback de todo.

use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

use crate::db::{self, EstadoBaseDatos};

async fn conexion(app: &tauri::AppHandle) -> Result<libsql::Connection, String> {
    let estado = app.state::<EstadoBaseDatos>();
    db::obtener_conexion(&estado).await
}

/// Chequeo de conectividad real (no solo si Turso está configurado) —
/// usado por los 3 comandos críticos de caja para decidir si trabajan
/// contra la conexión remota o encolan en la caché local (ver
/// src-tauri/src/offline.rs).
async fn en_linea(app: &tauri::AppHandle) -> bool {
    let estado = app.state::<EstadoBaseDatos>();
    db::esta_en_linea(&estado).await
}

/// Descuenta `cantidad` de los lotes más viejos con stock de un producto
/// (FIFO — primero entra, primero sale) — solo para llevar el rastro de
/// cuánto queda de cada compra (usado por la elegibilidad de editar/borrar
/// facturas y por el desglose). Ya NO toca `productos.costo_actual_usd`: el
/// precio de venta vigente ahora solo cambia al comprar (promedio ponderado
/// confirmado, ver `insertar_items_factura_interna`) o al revertir una
/// compra — nunca automáticamente porque un lote se agotó vendiendo.
///
/// Si la cantidad pedida supera lo que queda en lotes (sobreventa), se
/// permite igual — mismo criterio tolerante que ya tenía el sistema antes
/// de los lotes (la UI ya avisa "stock bajo" antes de llegar acá).
///
/// Devuelve el costo USD total de lo consumido (suma de cada porción por
/// el costo de SU lote) — lo usa `desglosar_producto_interna` para saber a
/// qué costo real se está partiendo el paquete, en vez de asumir el costo
/// "actual" del producto (que puede no ser el del lote que se está
/// vendiendo si hay varios lotes en cola).
async fn consumir_stock_fifo(
    tx: &libsql::Transaction,
    producto_id: &str,
    cantidad: f64,
) -> Result<f64, String> {
    let mut restante = cantidad;
    let mut costo_total = 0.0;
    while restante > 0.0001 {
        let fila = tx
            .query(
                "SELECT id, cantidad_restante, costo_unitario_usd FROM lotes_producto
                 WHERE producto_id = ?1 AND cantidad_restante > 0
                 ORDER BY creado_at ASC, rowid ASC LIMIT 1",
                libsql::params![producto_id.to_string()],
            )
            .await
            .map_err(|e| e.to_string())?
            .next()
            .await
            .map_err(|e| e.to_string())?;
        let Some(fila) = fila else { break };
        let lote_id: String = fila.get(0).map_err(|e| e.to_string())?;
        let disponible: f64 = fila.get(1).map_err(|e| e.to_string())?;
        let costo_lote: f64 = fila.get(2).map_err(|e| e.to_string())?;
        let consumido = restante.min(disponible);

        tx.execute(
            "UPDATE lotes_producto SET cantidad_restante = cantidad_restante - ?1 WHERE id = ?2",
            libsql::params![consumido, lote_id],
        )
        .await
        .map_err(|e| e.to_string())?;

        costo_total += consumido * costo_lote;
        restante -= consumido;
    }

    Ok(costo_total)
}

/// Recalcula `productos.costo_actual_usd` como el promedio ponderado de los
/// lotes que quedan con stock — solo se usa al revertir una factura de
/// compra (`revertir_factura_compra_interna`), para que el costo vigente
/// vuelva a reflejar lo que realmente queda tras deshacer esa compra en
/// concreto. Si no queda ningún lote con stock, se deja el costo como
/// estaba (no hay con qué recalcularlo). No toca margen_porcentaje ni
/// precio_venta_bs — promediarlos también no vale la complejidad para este
/// caso de borde (revertir solo se permite si la factura no vendió nada
/// todavía, así que el precio de venta al público no llegó a usarse con
/// datos de esa compra).
async fn actualizar_costo_vigente(tx: &libsql::Transaction, producto_id: &str) -> Result<(), String> {
    let fila = tx
        .query(
            "SELECT SUM(cantidad_restante * costo_unitario_usd), SUM(cantidad_restante)
             FROM lotes_producto WHERE producto_id = ?1 AND cantidad_restante > 0",
            libsql::params![producto_id.to_string()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(fila) = fila {
        let suma_costo: Option<f64> = fila.get(0).map_err(|e| e.to_string())?;
        let suma_cantidad: Option<f64> = fila.get(1).map_err(|e| e.to_string())?;
        if let (Some(costo), Some(cantidad)) = (suma_costo, suma_cantidad) {
            if cantidad > 0.0001 {
                tx.execute(
                    "UPDATE productos SET costo_actual_usd = ?1 WHERE id = ?2",
                    libsql::params![costo / cantidad, producto_id.to_string()],
                )
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

/// Crea un lote nuevo para stock que entra sin pasar por una factura de
/// compra (alta manual, corrección de conteo) — usa el costo/margen
/// ACTUAL del producto, ya que ese flujo no captura un costo nuevo.
async fn crear_lote_con_costo_actual(
    tx: &libsql::Transaction,
    producto_id: &str,
    cantidad: f64,
) -> Result<(), String> {
    let fila = tx
        .query(
            "SELECT costo_actual_usd, margen_porcentaje FROM productos WHERE id = ?1",
            libsql::params![producto_id.to_string()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El producto no existe.".to_string())?;
    let costo: f64 = fila.get(0).map_err(|e| e.to_string())?;
    let margen: Option<f64> = fila.get(1).map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO lotes_producto (id, producto_id, costo_unitario_usd, margen_porcentaje, cantidad_inicial, cantidad_restante, factura_compra_id)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?4, NULL)",
        libsql::params![producto_id.to_string(), costo, margen.unwrap_or(0.0), cantidad],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Dispatcher usado por la tarea de sincronización de offline.rs para
/// reproducir un comando pendiente de la cola contra la conexión remota,
/// reutilizando exactamente la misma lógica de negocio (`..._interna`)
/// que corre cuando el comando se ejecuta en línea la primera vez.
pub async fn ejecutar_desde_cola(
    conn: &libsql::Connection,
    comando: &str,
    payload_json: &str,
) -> Result<(), String> {
    match comando {
        "confirmar_venta" => {
            let input: ConfirmarVentaInput =
                serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
            confirmar_venta_interna(conn, &input).await?;
        }
        "ajustar_stock" => {
            let input: AjustarStockInput =
                serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
            ajustar_stock_interna(conn, &input).await?;
        }
        "registrar_consumo_interno" => {
            let input: ConsumoInternoInput =
                serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
            registrar_consumo_interno_interna(conn, &input).await?;
        }
        "desglosar_producto" => {
            let input: DesglosarProductoInput =
                serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
            desglosar_producto_interna(conn, &input).await?;
        }
        otro => return Err(format!("Comando desconocido en la cola: {otro}")),
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ItemVentaInput {
    pub producto_id: String,
    pub cantidad: f64,
    pub precio_unit_bs: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PagoVentaInput {
    pub metodo: String,
    pub monto_bs: f64,
    pub referencia: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ConfirmarVentaInput {
    pub id: String,
    pub fecha_hora: String,
    pub cliente_nombre: Option<String>,
    pub cliente_cedula: Option<String>,
    pub cliente_direccion: Option<String>,
    pub vendedor_id: Option<String>,
    pub vendedor_nombre: Option<String>,
    pub tasa_cambio_dia: f64,
    pub subtotal_bs: f64,
    pub iva_bs: f64,
    pub total_bs: f64,
    pub estado: String,
    pub monto_pendiente_usd: Option<f64>,
    /// "TIENDA" (default, caja física) o "DELIVERY" (venta importada de un
    /// pedido entregado de la app de delivery — ver delivery.rs). El
    /// frontend de Venta.tsx no manda este campo (serde lo completa con el
    /// default de abajo), solo lo usa la importación automática.
    #[serde(default = "canal_tienda")]
    pub canal: String,
    /// Id del Order de la delivery-app cuando canal = "DELIVERY", para
    /// trazabilidad — no se usa para nada más (la dedupe real pasa por
    /// Order.importadoPos del lado de la delivery-app).
    #[serde(default)]
    pub pedido_delivery_id: Option<String>,
    pub items: Vec<ItemVentaInput>,
    pub pagos: Vec<PagoVentaInput>,
}

pub fn canal_tienda() -> String {
    "TIENDA".to_string()
}

#[derive(Debug, Serialize)]
pub struct ConfirmarVentaOutput {
    numero_ticket: String,
    /// true si se guardó en la cola local por falta de conexión — el
    /// número de ticket es provisional (prefijo "PEND-") hasta que se
    /// sincronice sola con Turso.
    sin_conexion: bool,
}

/// Guarda una venta completa (cabecera + items + pagos + descuento de
/// stock + movimiento de inventario + consumo del próximo N° de ticket)
/// en una sola transacción atómica. El número de ticket se calcula acá
/// adentro (no lo manda el frontend) para que quede consistente con el
/// contador incluso si dos ventas se confirman muy seguidas. Funciona
/// igual contra la conexión remota o contra la caché local — la usan
/// tanto el comando público como el reintento offline (ver
/// ejecutar_desde_cola).
pub(crate) async fn confirmar_venta_interna(
    conn: &libsql::Connection,
    input: &ConfirmarVentaInput,
) -> Result<ConfirmarVentaOutput, String> {
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let fila = tx
        .query("SELECT prefijo_caja, proximo_numero_ticket FROM config WHERE id = 1", ())
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No se encontró la configuración.".to_string())?;
    let prefijo: String = fila.get(0).map_err(|e| e.to_string())?;
    let numero_config: i64 = fila.get(1).map_err(|e| e.to_string())?;
    drop(fila);

    // El contador de config puede haber quedado atrasado. Para no repetir
    // nunca un número ya usado, se toma el mayor entre el contador y el
    // máximo ya existente en "ventas" con ese mismo prefijo.
    let mut filas_max = tx
        .query(
            "SELECT MAX(CAST(SUBSTR(numero_ticket, LENGTH(?1) + 2) AS INTEGER))
             FROM ventas WHERE numero_ticket LIKE ?1 || '-%'",
            libsql::params![prefijo.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    let max_existente: Option<i64> = match filas_max.next().await.map_err(|e| e.to_string())? {
        Some(f) => f.get(0).map_err(|e| e.to_string())?,
        None => None,
    };

    let numero = numero_config.max(max_existente.unwrap_or(0) + 1);
    let numero_ticket = format!("{prefijo}-{numero:06}");

    tx.execute(
        "INSERT INTO ventas (id, numero_ticket, fecha_hora, cliente_nombre, cliente_cedula, cliente_direccion, vendedor_id, vendedor_nombre, tasa_cambio_dia, subtotal_bs, iva_bs, total_bs, estado, monto_pendiente_usd, canal, pedido_delivery_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        libsql::params![
            input.id.clone(),
            numero_ticket.clone(),
            input.fecha_hora.clone(),
            input.cliente_nombre.clone(),
            input.cliente_cedula.clone(),
            input.cliente_direccion.clone(),
            input.vendedor_id.clone(),
            input.vendedor_nombre.clone(),
            input.tasa_cambio_dia,
            input.subtotal_bs,
            input.iva_bs,
            input.total_bs,
            input.estado.clone(),
            input.monto_pendiente_usd,
            input.canal.clone(),
            input.pedido_delivery_id.clone(),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    for item in &input.items {
        if item.cantidad <= 0.0 {
            return Err("Una línea del carrito tiene cantidad inválida.".to_string());
        }
        let subtotal_linea = item.precio_unit_bs * item.cantidad;

        tx.execute(
            "INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unit_bs, subtotal_bs)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
            libsql::params![
                input.id.clone(),
                item.producto_id.clone(),
                item.cantidad,
                item.precio_unit_bs,
                subtotal_linea,
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE productos
             SET stock_actual = stock_actual - ?1,
                 activo = CASE WHEN stock_actual - ?1 <= 0 THEN 0 ELSE activo END
             WHERE id = ?2",
            libsql::params![item.cantidad, item.producto_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;

        consumir_stock_fifo(&tx, &item.producto_id, item.cantidad).await?;

        tx.execute(
            "INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, referencia, created_at)
             VALUES (lower(hex(randomblob(16))), ?1, 'SALIDA', ?2, 'Venta en caja', ?3, ?4)",
            libsql::params![item.producto_id.clone(), item.cantidad, input.id.clone(), input.fecha_hora.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    for pago in &input.pagos {
        tx.execute(
            "INSERT INTO pagos (id, venta_id, metodo, monto_bs, referencia)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4)",
            libsql::params![input.id.clone(), pago.metodo.clone(), pago.monto_bs, pago.referencia.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "UPDATE config SET proximo_numero_ticket = ?1 WHERE id = 1",
        libsql::params![numero + 1],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(ConfirmarVentaOutput { numero_ticket, sin_conexion: false })
}

/// Comando público: si hay conexión, confirma la venta contra Turso
/// directo. Si no, la guarda en la cola local de pendientes Y la aplica
/// de inmediato contra la caché local (mismo esquema) para que el stock
/// que ve la caja quede correcto ya mismo, aunque no se haya sincronizado.
/// El número de ticket que se muestra en ese caso es provisional.
#[tauri::command]
pub async fn confirmar_venta(
    app: tauri::AppHandle,
    input: ConfirmarVentaInput,
) -> Result<ConfirmarVentaOutput, String> {
    if en_linea(&app).await {
        let conn = conexion(&app).await?;
        return confirmar_venta_interna(&conn, &input).await;
    }

    let cache = app.state::<crate::offline::EstadoCache>();
    crate::offline::encolar(&cache, "confirmar_venta", &input).await?;

    let conn_cache = cache.conectar().await?;
    let mut resultado = confirmar_venta_interna(&conn_cache, &input).await?;
    resultado.numero_ticket = format!("PEND-{}", resultado.numero_ticket);
    resultado.sin_conexion = true;
    Ok(resultado)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AjustarStockInput {
    producto_id: String,
    /// "ENTRADA" o "SALIDA". Igual que en Compras/Venta, la cantidad
    /// siempre se guarda en movimientos_inventario como magnitud
    /// positiva; la dirección la da este campo.
    tipo: String,
    cantidad: f64,
    motivo: String,
    fecha_hora: String,
}

/// Entrada o salida manual de stock (mermas, donaciones, corrección de
/// conteo físico, etc.) fuera del flujo de una venta o una compra. Suma o
/// resta el stock y dista el movimiento en una sola transacción atómica,
/// igual que confirmar_venta. Funciona igual contra la conexión remota o
/// la caché local (ver confirmar_venta_interna).
async fn ajustar_stock_interna(conn: &libsql::Connection, input: &AjustarStockInput) -> Result<(), String> {
    if input.cantidad <= 0.0 {
        return Err("La cantidad debe ser mayor a 0.".to_string());
    }
    let delta = match input.tipo.as_str() {
        "ENTRADA" => input.cantidad,
        "SALIDA" => -input.cantidad,
        otro => return Err(format!("Tipo de movimiento inválido: {otro}")),
    };
    let motivo = input.motivo.trim();
    if motivo.is_empty() {
        return Err("Indica un motivo para el movimiento.".to_string());
    }

    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let existe = tx
        .query("SELECT stock_actual FROM productos WHERE id = ?1", libsql::params![input.producto_id.clone()])
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?;
    if existe.is_none() {
        return Err("El producto no existe.".to_string());
    }

    tx.execute(
        "UPDATE productos
         SET stock_actual = stock_actual + ?1,
             activo = CASE
               WHEN stock_actual + ?1 <= 0 THEN 0
               WHEN ?1 > 0 THEN 1
               ELSE activo
             END
         WHERE id = ?2",
        libsql::params![delta, input.producto_id.clone()],
    )
    .await
    .map_err(|e| e.to_string())?;

    if input.tipo == "SALIDA" {
        consumir_stock_fifo(&tx, &input.producto_id, input.cantidad).await?;
    } else {
        crear_lote_con_costo_actual(&tx, &input.producto_id, input.cantidad).await?;
    }

    tx.execute(
        "INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, created_at)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
        libsql::params![input.producto_id.clone(), input.tipo.clone(), input.cantidad, motivo, input.fecha_hora.clone()],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct AjustarStockOutput {
    sin_conexion: bool,
}

#[tauri::command]
pub async fn ajustar_stock(app: tauri::AppHandle, input: AjustarStockInput) -> Result<AjustarStockOutput, String> {
    if en_linea(&app).await {
        let conn = conexion(&app).await?;
        ajustar_stock_interna(&conn, &input).await?;
        return Ok(AjustarStockOutput { sin_conexion: false });
    }

    let cache = app.state::<crate::offline::EstadoCache>();
    crate::offline::encolar(&cache, "ajustar_stock", &input).await?;

    let conn_cache = cache.conectar().await?;
    ajustar_stock_interna(&conn_cache, &input).await?;
    Ok(AjustarStockOutput { sin_conexion: true })
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DesglosarProductoInput {
    producto_origen_id: String,
    producto_destino_id: String,
    /// Cuántas unidades del producto origen se rompen (ej. 1 paquete).
    cantidad_origen: f64,
    /// Cuántas unidades del producto destino se generan (ej. 20
    /// cigarrillos) — no tiene que ser un múltiplo "redondo", lo decide
    /// quien hace el desglose.
    unidades_generadas: f64,
    motivo: String,
    fecha_hora: String,
}

/// Convierte stock de un producto (ej. una caja de cigarrillos) en stock
/// de OTRO producto del catálogo (ej. cigarrillos sueltos, con su propio
/// código de barras) — el caso típico es vender por unidad algo que se
/// compra empaquetado. Es una SALIDA del origen y una ENTRADA al destino
/// en una sola transacción atómica: el origen se descuenta por FIFO (con
/// el costo real del lote que se está partiendo) y ese costo, dividido
/// entre las unidades generadas, es el costo del lote nuevo del destino —
/// así la ganancia de vender por unidad queda calculada correctamente en
/// vez de heredar a ciegas el costo que ya tenía el destino.
async fn desglosar_producto_interna(conn: &libsql::Connection, input: &DesglosarProductoInput) -> Result<(), String> {
    if input.cantidad_origen <= 0.0 {
        return Err("La cantidad a desglosar debe ser mayor a 0.".to_string());
    }
    if input.unidades_generadas <= 0.0 {
        return Err("Las unidades generadas deben ser mayor a 0.".to_string());
    }
    if input.producto_origen_id == input.producto_destino_id {
        return Err("El producto de origen y el de destino no pueden ser el mismo.".to_string());
    }
    let motivo = input.motivo.trim();
    let motivo = if motivo.is_empty() { "Desglose" } else { motivo };

    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let existe_destino = tx
        .query(
            "SELECT margen_porcentaje FROM productos WHERE id = ?1",
            libsql::params![input.producto_destino_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El producto de destino no existe.".to_string())?;
    let margen_destino: Option<f64> = existe_destino.get(0).map_err(|e| e.to_string())?;

    // Respaldo para productos sin lotes todavía (ej. dados de alta desde el
    // formulario rápido de Inventario, que no crea lote) — sin esto,
    // consumir_stock_fifo no encuentra nada que descontar y el costo del
    // desglose saldría en 0, como si el producto no costara nada.
    let costo_actual_origen: f64 = tx
        .query(
            "SELECT costo_actual_usd FROM productos WHERE id = ?1",
            libsql::params![input.producto_origen_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El producto de origen no existe.".to_string())?
        .get(0)
        .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE productos
         SET stock_actual = stock_actual - ?1,
             activo = CASE WHEN stock_actual - ?1 <= 0 THEN 0 ELSE activo END
         WHERE id = ?2",
        libsql::params![input.cantidad_origen, input.producto_origen_id.clone()],
    )
    .await
    .map_err(|e| e.to_string())?;

    let costo_total_origen = consumir_stock_fifo(&tx, &input.producto_origen_id, input.cantidad_origen).await?;
    let costo_total_origen = if costo_total_origen.abs() < 0.0000001 {
        costo_actual_origen * input.cantidad_origen
    } else {
        costo_total_origen
    };
    let costo_unitario_destino = costo_total_origen / input.unidades_generadas;

    let tenia_stock_vigente_destino: i64 = tx
        .query(
            "SELECT COUNT(*) FROM lotes_producto WHERE producto_id = ?1 AND cantidad_restante > 0",
            libsql::params![input.producto_destino_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .map(|f| f.get::<i64>(0).unwrap_or(0))
        .unwrap_or(0);

    tx.execute(
        "INSERT INTO lotes_producto (id, producto_id, costo_unitario_usd, margen_porcentaje, cantidad_inicial, cantidad_restante, factura_compra_id)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?4, NULL)",
        libsql::params![
            input.producto_destino_id.clone(),
            costo_unitario_destino,
            margen_destino.unwrap_or(0.0),
            input.unidades_generadas,
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    if tenia_stock_vigente_destino == 0 {
        tx.execute(
            "UPDATE productos SET costo_actual_usd = ?1, margen_porcentaje = ?2 WHERE id = ?3",
            libsql::params![costo_unitario_destino, margen_destino.unwrap_or(0.0), input.producto_destino_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "UPDATE productos
         SET stock_actual = stock_actual + ?1,
             activo = 1
         WHERE id = ?2",
        libsql::params![input.unidades_generadas, input.producto_destino_id.clone()],
    )
    .await
    .map_err(|e| e.to_string())?;

    let referencia = Uuid::new_v4().simple().to_string();

    tx.execute(
        "INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, referencia, created_at)
         VALUES (lower(hex(randomblob(16))), ?1, 'SALIDA', ?2, ?3, ?4, ?5)",
        libsql::params![
            input.producto_origen_id.clone(),
            input.cantidad_origen,
            format!("Desglose: {motivo}"),
            referencia.clone(),
            input.fecha_hora.clone(),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, referencia, created_at)
         VALUES (lower(hex(randomblob(16))), ?1, 'ENTRADA', ?2, ?3, ?4, ?5)",
        libsql::params![
            input.producto_destino_id.clone(),
            input.unidades_generadas,
            format!("Desglose: {motivo}"),
            referencia,
            input.fecha_hora.clone(),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct DesglosarProductoOutput {
    sin_conexion: bool,
}

#[tauri::command]
pub async fn desglosar_producto(app: tauri::AppHandle, input: DesglosarProductoInput) -> Result<DesglosarProductoOutput, String> {
    if en_linea(&app).await {
        let conn = conexion(&app).await?;
        desglosar_producto_interna(&conn, &input).await?;
        return Ok(DesglosarProductoOutput { sin_conexion: false });
    }

    let cache = app.state::<crate::offline::EstadoCache>();
    crate::offline::encolar(&cache, "desglosar_producto", &input).await?;

    let conn_cache = cache.conectar().await?;
    desglosar_producto_interna(&conn_cache, &input).await?;
    Ok(DesglosarProductoOutput { sin_conexion: true })
}

const EPS: f64 = 0.01;

#[derive(Debug, Deserialize)]
pub struct AbonoClienteInput {
    venta_id: String,
    monto_usd: f64,
    tasa_cambio_dia: f64,
    monto_bs: f64,
    metodo: Option<String>,
}

/// Abono de un cliente a una venta a crédito. El saldo pendiente se lee
/// de la propia venta DENTRO de la transacción (no del valor que ya tenía
/// el frontend en memoria, que puede estar desactualizado) para que la
/// validación "no puede abonar más de lo que debe" sea confiable incluso
/// si algo más tocó esa venta mientras el formulario estaba abierto.
#[tauri::command]
pub async fn registrar_abono_cliente(app: tauri::AppHandle, input: AbonoClienteInput) -> Result<(), String> {
    if input.monto_usd <= 0.0 {
        return Err("El monto debe ser mayor a 0.".to_string());
    }

    let conn = conexion(&app).await?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let fila = tx
        .query(
            "SELECT monto_pendiente_usd FROM ventas WHERE id = ?1 AND estado = 'CREDITO_PENDIENTE'",
            libsql::params![input.venta_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?;

    let pendiente = match fila {
        Some(f) => {
            let v: Option<f64> = f.get(0).map_err(|e| e.to_string())?;
            v.ok_or_else(|| "Esa venta ya no tiene saldo pendiente.".to_string())?
        }
        None => return Err("Esa venta ya no tiene saldo pendiente.".to_string()),
    };

    if input.monto_usd > pendiente + EPS {
        return Err(format!(
            "Ese monto equivale a USD {:.2}, pero la deuda es de solo USD {:.2}.",
            input.monto_usd, pendiente
        ));
    }

    let nuevo_pendiente = (pendiente - input.monto_usd).max(0.0);

    tx.execute(
        "INSERT INTO cobros_cliente (id, venta_id, monto_usd, tasa_cambio_dia, monto_bs, metodo)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
        libsql::params![input.venta_id.clone(), input.monto_usd, input.tasa_cambio_dia, input.monto_bs, input.metodo.clone()],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE ventas
         SET monto_pendiente_usd = ?1,
             estado = CASE WHEN ?1 <= 0.01 THEN 'CREDITO_PAGADO' ELSE estado END
         WHERE id = ?2",
        libsql::params![nuevo_pendiente, input.venta_id.clone()],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct AbonoClienteTotalInput {
    cliente_cedula: String,
    monto_usd: f64,
    tasa_cambio_dia: f64,
    metodo: Option<String>,
}

/// Abono de un cliente aplicado a su DEUDA TOTAL (todas las ventas a
/// crédito pendientes), no a una factura puntual — así lo pidió el
/// negocio: el cliente paga "lo que debe" y el sistema reparte ese pago
/// entre sus ventas pendientes, de la más vieja a la más nueva, hasta
/// agotar el monto. El saldo total se recalcula DENTRO de la transacción
/// (no el que tenía el frontend en memoria) por la misma razón que en
/// registrar_abono_cliente.
#[tauri::command]
pub async fn registrar_abono_cliente_total(
    app: tauri::AppHandle,
    input: AbonoClienteTotalInput,
) -> Result<(), String> {
    if input.monto_usd <= 0.0 {
        return Err("El monto debe ser mayor a 0.".to_string());
    }

    let conn = conexion(&app).await?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let mut ventas: Vec<(String, f64)> = Vec::new();
    let mut filas = tx
        .query(
            "SELECT id, monto_pendiente_usd FROM ventas
             WHERE cliente_cedula = ?1 AND estado = 'CREDITO_PENDIENTE'
             ORDER BY fecha_hora ASC",
            libsql::params![input.cliente_cedula.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    while let Some(f) = filas.next().await.map_err(|e| e.to_string())? {
        let id: String = f.get(0).map_err(|e| e.to_string())?;
        let pendiente: f64 = f.get(1).map_err(|e| e.to_string())?;
        ventas.push((id, pendiente));
    }
    drop(filas);

    let total_pendiente: f64 = ventas.iter().map(|(_, p)| p).sum();
    if ventas.is_empty() {
        return Err("Ese cliente ya no tiene deuda pendiente.".to_string());
    }
    if input.monto_usd > total_pendiente + EPS {
        return Err(format!(
            "Ese monto equivale a USD {:.2}, pero la deuda total es de solo USD {:.2}.",
            input.monto_usd, total_pendiente
        ));
    }

    let mut restante = input.monto_usd;

    for (venta_id, pendiente) in ventas {
        if restante <= EPS {
            break;
        }
        let aplicado = restante.min(pendiente);
        let nuevo_pendiente = (pendiente - aplicado).max(0.0);

        tx.execute(
            "INSERT INTO cobros_cliente (id, venta_id, monto_usd, tasa_cambio_dia, monto_bs, metodo)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
            libsql::params![
                venta_id.clone(),
                aplicado,
                input.tasa_cambio_dia,
                aplicado * input.tasa_cambio_dia,
                input.metodo.clone(),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE ventas
             SET monto_pendiente_usd = ?1,
                 estado = CASE WHEN ?1 <= 0.01 THEN 'CREDITO_PAGADO' ELSE estado END
             WHERE id = ?2",
            libsql::params![nuevo_pendiente, venta_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;

        restante -= aplicado;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct PagoProveedorInput {
    factura_compra_id: String,
    monto_usd: f64,
    tasa_cambio_dia: f64,
    monto_bs: f64,
    metodo: Option<String>,
    referencia: Option<String>,
}

/// Pago a una factura de proveedor. Misma idea que registrar_abono_cliente:
/// el saldo se lee de la factura dentro de la transacción, no del valor
/// que traía el frontend.
#[tauri::command]
pub async fn registrar_pago_proveedor(app: tauri::AppHandle, input: PagoProveedorInput) -> Result<(), String> {
    if input.monto_usd <= 0.0 {
        return Err("El monto debe ser mayor a 0.".to_string());
    }

    let conn = conexion(&app).await?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let fila = tx
        .query(
            "SELECT monto_total_usd, monto_pagado_usd FROM facturas_compra WHERE id = ?1 AND estado != 'PAGADA'",
            libsql::params![input.factura_compra_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Esa factura ya está pagada o no existe.".to_string())?;
    let total: f64 = fila.get(0).map_err(|e| e.to_string())?;
    let pagado: f64 = fila.get(1).map_err(|e| e.to_string())?;
    let saldo = total - pagado;

    if input.monto_usd > saldo + EPS {
        return Err(format!(
            "Ese monto equivale a USD {:.2}, pero el saldo es de solo USD {:.2}.",
            input.monto_usd, saldo
        ));
    }

    let nuevo_pagado = pagado + input.monto_usd;
    let saldada = total - nuevo_pagado <= EPS;

    tx.execute(
        "INSERT INTO pagos_proveedor (id, factura_compra_id, monto_usd, tasa_cambio_dia, monto_bs, metodo, referencia)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6)",
        libsql::params![
            input.factura_compra_id.clone(),
            input.monto_usd,
            input.tasa_cambio_dia,
            input.monto_bs,
            input.metodo.clone(),
            input.referencia.clone(),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE facturas_compra SET monto_pagado_usd = ?1, estado = ?2 WHERE id = ?3",
        libsql::params![
            nuevo_pagado,
            if saldada { "PAGADA" } else { "PARCIAL" },
            input.factura_compra_id.clone(),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ItemConsumoInternoInput {
    producto_id: String,
    cantidad: f64,
    motivo: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ConsumoInternoInput {
    fecha_hora: String,
    items: Vec<ItemConsumoInternoInput>,
}

/// Consumo interno: productos que salen del inventario sin ser una venta
/// (mermas, muestras, uso propio del negocio). El cajero los va agregando
/// a una lista en pantalla durante el día (ver Venta.tsx) y esto se llama
/// una sola vez, con todo lo acumulado, al cerrar — en una transacción
/// atómica igual que confirmar_venta y ajustar_stock. Funciona igual
/// contra la conexión remota o la caché local.
async fn registrar_consumo_interno_interna(
    conn: &libsql::Connection,
    input: &ConsumoInternoInput,
) -> Result<(), String> {
    if input.items.is_empty() {
        return Err("No hay productos en la lista de consumo interno.".to_string());
    }

    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    for item in &input.items {
        if item.cantidad <= 0.0 {
            return Err("Hay una línea con cantidad inválida.".to_string());
        }
        let motivo = item.motivo.trim();
        let motivo = if motivo.is_empty() { "Consumo interno" } else { motivo };

        tx.execute(
            "UPDATE productos
             SET stock_actual = stock_actual - ?1,
                 activo = CASE WHEN stock_actual - ?1 <= 0 THEN 0 ELSE activo END
             WHERE id = ?2",
            libsql::params![item.cantidad, item.producto_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;

        consumir_stock_fifo(&tx, &item.producto_id, item.cantidad).await?;

        tx.execute(
            "INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, created_at)
             VALUES (lower(hex(randomblob(16))), ?1, 'SALIDA', ?2, ?3, ?4)",
            libsql::params![item.producto_id.clone(), item.cantidad, motivo, input.fecha_hora.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ConsumoInternoOutput {
    sin_conexion: bool,
}

#[tauri::command]
pub async fn registrar_consumo_interno(
    app: tauri::AppHandle,
    input: ConsumoInternoInput,
) -> Result<ConsumoInternoOutput, String> {
    if en_linea(&app).await {
        let conn = conexion(&app).await?;
        registrar_consumo_interno_interna(&conn, &input).await?;
        return Ok(ConsumoInternoOutput { sin_conexion: false });
    }

    let cache = app.state::<crate::offline::EstadoCache>();
    crate::offline::encolar(&cache, "registrar_consumo_interno", &input).await?;

    let conn_cache = cache.conectar().await?;
    registrar_consumo_interno_interna(&conn_cache, &input).await?;
    Ok(ConsumoInternoOutput { sin_conexion: true })
}

#[derive(Debug, Deserialize)]
pub struct ItemFacturaCompraInput {
    /// Id del producto — ya generado en el frontend con crypto.randomUUID()
    /// tanto si es nuevo (todavía no existe en la tabla) como si ya existe.
    producto_id: String,
    es_nuevo: bool,
    codigo_barra: String,
    /// Código interno del proveedor (como aparece en su factura) — NO es
    /// el código de barras de venta. Solo sirve para reconocer el mismo
    /// producto en compras futuras a ese proveedor antes de que tenga un
    /// código de barras real asignado en tienda.
    codigo_proveedor: Option<String>,
    nombre: String,
    /// Solo se usa si es_nuevo — se busca por nombre y se crea si no existe.
    categoria_nombre: Option<String>,
    cajas: f64,
    unidad_suelta: f64,
    unidades_por_paquete: f64,
    /// = cajas * unidades_por_paquete + unidad_suelta, ya calculado en JS.
    cantidad_total: f64,
    costo_unitario_usd: f64,
    margen_aplicado: f64,
    precio_venta_bs: f64,
    /// Solo informativo — el IVA y el descuento ya vienen incluidos en
    /// costo_unitario_usd (calculado en el frontend); esto se guarda aparte
    /// para poder mostrarlo en el detalle de la factura.
    aplica_iva: bool,
    tasa_iva_aplicada: f64,
    aplica_descuento: bool,
    descuento_aplicado: f64,
    /// Costo/margen/precio que queda VIGENTE para el producto tras esta
    /// compra — el promedio ponderado entre el stock que ya tenía (a su
    /// costo anterior) y esta compra nueva, ya confirmado por la persona en
    /// Compras.tsx antes de guardar. Si el producto es nuevo o no tenía
    /// stock, es igual a costo_unitario_usd/margen_aplicado/precio_venta_bs
    /// de esta línea. Reemplaza al viejo esquema "el lote más viejo manda
    /// hasta agotarse": ahora el precio de venta cambia de una vez, sin
    /// esperar a que se venda el stock que ya había.
    costo_vigente_usd: f64,
    margen_vigente: f64,
    precio_venta_vigente_bs: f64,
}

#[derive(Debug, Deserialize)]
pub struct FacturaCompraInput {
    id: String,
    proveedor_id: String,
    numero_factura: String,
    fecha_hora: String,
    moneda: String,
    tasa_cambio_dia: f64,
    items: Vec<ItemFacturaCompraInput>,
}

#[derive(Debug, Serialize)]
pub struct FacturaCompraOutput {
    monto_total_usd: f64,
}

/// Inserta las líneas de una factura de compra (productos nuevos si hace
/// falta, la línea en `items_factura_compra`, el lote FIFO y el
/// movimiento de inventario de cada una) contra una factura ya existente
/// en `factura_id` — lo comparten `guardar_factura_compra` (factura recién
/// creada) y `editar_factura_compra` (factura existente, tras deshacer sus
/// líneas viejas con `revertir_factura_compra_interna`).
async fn insertar_items_factura_interna(
    tx: &libsql::Transaction,
    factura_id: &str,
    proveedor_id: &str,
    fecha_hora: &str,
    items: &[ItemFacturaCompraInput],
) -> Result<(), String> {
    for item in items {
        if item.es_nuevo {
            let categoria_id: Option<String> = match item
                .categoria_nombre
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(nombre) => {
                    let existente = tx
                        .query("SELECT id FROM categorias WHERE nombre = ?1", libsql::params![nombre.to_string()])
                        .await
                        .map_err(|e| e.to_string())?
                        .next()
                        .await
                        .map_err(|e| e.to_string())?;
                    match existente {
                        Some(f) => Some(f.get::<String>(0).map_err(|e| e.to_string())?),
                        None => {
                            let nueva_id = Uuid::new_v4().simple().to_string();
                            tx.execute(
                                "INSERT INTO categorias (id, nombre) VALUES (?1, ?2)",
                                libsql::params![nueva_id.clone(), nombre.to_string()],
                            )
                            .await
                            .map_err(|e| e.to_string())?;
                            Some(nueva_id)
                        }
                    }
                }
                None => None,
            };

            tx.execute(
                "INSERT INTO productos (id, codigo_barra, codigo_proveedor, nombre, categoria_id, costo_actual_usd, margen_porcentaje, precio_venta_bs, stock_actual, unidades_por_paquete)
                 VALUES (?1,?2,?3,?4,?5,0,?6,0,0,?7)",
                libsql::params![
                    item.producto_id.clone(),
                    item.codigo_barra.clone(),
                    item.codigo_proveedor.clone(),
                    item.nombre.clone(),
                    categoria_id,
                    item.margen_aplicado,
                    item.unidades_por_paquete,
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        tx.execute(
            "INSERT INTO items_factura_compra (id, factura_compra_id, producto_id, cantidad, costo_unitario_usd, margen_aplicado, precio_venta_calculado, cajas, unidad_suelta, unidades_por_paquete, aplica_iva, tasa_iva_aplicada, aplica_descuento, descuento_aplicado)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            libsql::params![
                factura_id.to_string(),
                item.producto_id.clone(),
                item.cantidad_total,
                item.costo_unitario_usd,
                item.margen_aplicado,
                item.precio_venta_bs,
                item.cajas,
                item.unidad_suelta,
                item.unidades_por_paquete,
                item.aplica_iva,
                item.tasa_iva_aplicada,
                item.aplica_descuento,
                item.descuento_aplicado,
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        // El costo/margen/precio vigente pasa a ser el promedio ponderado
        // ya confirmado en el frontend (costo_vigente_usd/margen_vigente/
        // precio_venta_vigente_bs) — de una vez, sin esperar a que se agote
        // el stock que ya había. `lotes_producto` (abajo) igual se sigue
        // llevando con el costo REAL de esta compra (costo_unitario_usd),
        // para el costeo de stock, el desglose y la reversión de facturas.
        tx.execute(
            "UPDATE productos
             SET costo_actual_usd = ?1,
                 margen_porcentaje = ?2,
                 precio_venta_bs = ?3,
                 stock_actual = stock_actual + ?5,
                 unidades_por_paquete = ?6,
                 codigo_proveedor = ?7,
                 activo = 1
             WHERE id = ?4",
            libsql::params![
                item.costo_vigente_usd,
                item.margen_vigente,
                item.precio_venta_vigente_bs,
                item.producto_id.clone(),
                item.cantidad_total,
                item.unidades_por_paquete,
                item.codigo_proveedor.clone(),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT INTO lotes_producto (id, producto_id, costo_unitario_usd, margen_porcentaje, cantidad_inicial, cantidad_restante, factura_compra_id)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?4, ?5)",
            libsql::params![
                item.producto_id.clone(),
                item.costo_unitario_usd,
                item.margen_aplicado,
                item.cantidad_total,
                factura_id.to_string(),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT INTO movimientos_inventario (id, producto_id, tipo, cantidad, motivo, referencia, created_at)
             VALUES (lower(hex(randomblob(16))), ?1, 'ENTRADA', ?2, 'Compra a proveedor', ?3, ?4)",
            libsql::params![item.producto_id.clone(), item.cantidad_total, factura_id.to_string(), fecha_hora.to_string()],
        )
        .await
        .map_err(|e| e.to_string())?;

        // Recuerda el código de ESTE proveedor para este producto — un
        // mismo producto puede tener un código distinto por cada
        // proveedor al que se le compra, así que se guardan todos (no solo
        // el último) para reconocerlo la próxima vez sin duplicar.
        if let Some(codigo) = item.codigo_proveedor.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tx.execute(
                "INSERT INTO codigos_proveedor_producto (id, producto_id, proveedor_id, codigo)
                 VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3)
                 ON CONFLICT(proveedor_id, codigo) DO UPDATE SET producto_id = excluded.producto_id",
                libsql::params![item.producto_id.clone(), proveedor_id.to_string(), codigo.to_string()],
            )
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Guarda una factura de compra completa: cabecera, creación de
/// productos/categorías nuevas si hace falta, líneas de la factura,
/// actualización de costo/margen/precio/stock de cada producto y su
/// movimiento de inventario — todo en una sola transacción atómica, igual
/// que confirmar_venta.
#[tauri::command]
pub async fn guardar_factura_compra(
    app: tauri::AppHandle,
    input: FacturaCompraInput,
) -> Result<FacturaCompraOutput, String> {
    if input.items.is_empty() {
        return Err("Agrega al menos un producto a la factura.".to_string());
    }

    let mut monto_total_usd = 0.0;
    for item in &input.items {
        if item.cantidad_total <= 0.0 {
            return Err(format!("\"{}\" tiene una cantidad inválida.", item.nombre));
        }
        monto_total_usd += item.costo_unitario_usd * item.cantidad_total;
    }

    let conn = conexion(&app).await?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO facturas_compra (id, proveedor_id, numero_factura, fecha, moneda, tasa_cambio_dia, monto_total_usd)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        libsql::params![
            input.id.clone(),
            input.proveedor_id.clone(),
            input.numero_factura.clone(),
            input.fecha_hora.clone(),
            input.moneda.clone(),
            input.tasa_cambio_dia,
            monto_total_usd,
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    insertar_items_factura_interna(&tx, &input.id, &input.proveedor_id, &input.fecha_hora, &input.items).await?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(FacturaCompraOutput { monto_total_usd })
}

/// Si devuelve `Some(motivo)`, la factura NO se puede editar ni eliminar
/// (ya se vendió algo de su stock, o ya tiene pagos al proveedor
/// registrados) — en ese caso, la corrección segura es un ajuste de stock
/// manual (Movimientos), no reescribir historia ya en movimiento.
async fn factura_compra_bloqueo(tx: &libsql::Transaction, factura_id: &str) -> Result<Option<String>, String> {
    let fila = tx
        .query(
            "SELECT monto_pagado_usd FROM facturas_compra WHERE id = ?1",
            libsql::params![factura_id.to_string()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?;
    let Some(fila) = fila else {
        return Ok(Some("La factura no existe.".to_string()));
    };
    let monto_pagado: f64 = fila.get(0).map_err(|e| e.to_string())?;
    if monto_pagado > 0.0001 {
        return Ok(Some(
            "Esta factura ya tiene pagos registrados al proveedor — no se puede editar ni eliminar.".to_string(),
        ));
    }

    let vendido: i64 = tx
        .query(
            "SELECT COUNT(*) FROM lotes_producto
             WHERE factura_compra_id = ?1 AND cantidad_restante < cantidad_inicial - 0.0001",
            libsql::params![factura_id.to_string()],
        )
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?
        .map(|f| f.get::<i64>(0).unwrap_or(0))
        .unwrap_or(0);
    if vendido > 0 {
        return Ok(Some(
            "Ya se vendió stock que llegó con esta factura — no se puede editar ni eliminar. Usa un ajuste de stock (pestaña Movimientos) para corregirlo.".to_string(),
        ));
    }

    Ok(None)
}

/// Deshace por completo el efecto de una factura de compra sobre el
/// inventario: descuenta de `productos.stock_actual` lo que había sumado,
/// borra sus lotes y sus movimientos de ENTRADA, y borra sus líneas —
/// dejando la cabecera de `facturas_compra` intacta para que
/// `editar_factura_compra` la reutilice, o lista para borrarla en
/// `eliminar_factura_compra`. Solo se llama tras confirmar con
/// `factura_compra_bloqueo` que nada de esto se vendió ni se pagó todavía.
async fn revertir_factura_compra_interna(tx: &libsql::Transaction, factura_id: &str) -> Result<(), String> {
    let mut filas = tx
        .query(
            "SELECT producto_id, cantidad FROM items_factura_compra WHERE factura_compra_id = ?1",
            libsql::params![factura_id.to_string()],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut productos_afectados: Vec<String> = Vec::new();
    while let Some(fila) = filas.next().await.map_err(|e| e.to_string())? {
        let producto_id: String = fila.get(0).map_err(|e| e.to_string())?;
        let cantidad: f64 = fila.get(1).map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE productos SET stock_actual = stock_actual - ?1 WHERE id = ?2",
            libsql::params![cantidad, producto_id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;

        productos_afectados.push(producto_id);
    }
    drop(filas);

    tx.execute(
        "DELETE FROM lotes_producto WHERE factura_compra_id = ?1",
        libsql::params![factura_id.to_string()],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM movimientos_inventario WHERE referencia = ?1 AND tipo = 'ENTRADA'",
        libsql::params![factura_id.to_string()],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM items_factura_compra WHERE factura_compra_id = ?1",
        libsql::params![factura_id.to_string()],
    )
    .await
    .map_err(|e| e.to_string())?;

    for producto_id in productos_afectados {
        actualizar_costo_vigente(tx, &producto_id).await?;
    }

    Ok(())
}

/// Elimina por completo una factura de compra — solo si todavía no se
/// vendió nada de lo que trajo ni se le pagó nada al proveedor (ver
/// factura_compra_bloqueo). El stock que había sumado se resta de nuevo.
#[tauri::command]
pub async fn eliminar_factura_compra(app: tauri::AppHandle, factura_id: String) -> Result<(), String> {
    let conn = conexion(&app).await?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    if let Some(motivo) = factura_compra_bloqueo(&tx, &factura_id).await? {
        return Err(motivo);
    }

    revertir_factura_compra_interna(&tx, &factura_id).await?;

    tx.execute("DELETE FROM facturas_compra WHERE id = ?1", libsql::params![factura_id.clone()])
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Reemplaza cabecera y líneas de una factura de compra existente — solo
/// si todavía es elegible (ver factura_compra_bloqueo). Por debajo es
/// "deshacer todo y volver a cargar", en una sola transacción atómica, para
/// no arrastrar lotes/movimientos inconsistentes de la versión vieja.
#[tauri::command]
pub async fn editar_factura_compra(
    app: tauri::AppHandle,
    factura_id: String,
    input: FacturaCompraInput,
) -> Result<FacturaCompraOutput, String> {
    if input.items.is_empty() {
        return Err("Agrega al menos un producto a la factura.".to_string());
    }
    let mut monto_total_usd = 0.0;
    for item in &input.items {
        if item.cantidad_total <= 0.0 {
            return Err(format!("\"{}\" tiene una cantidad inválida.", item.nombre));
        }
        monto_total_usd += item.costo_unitario_usd * item.cantidad_total;
    }

    let conn = conexion(&app).await?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    if let Some(motivo) = factura_compra_bloqueo(&tx, &factura_id).await? {
        return Err(motivo);
    }

    revertir_factura_compra_interna(&tx, &factura_id).await?;

    tx.execute(
        "UPDATE facturas_compra
         SET proveedor_id = ?1, numero_factura = ?2, fecha = ?3, moneda = ?4, tasa_cambio_dia = ?5, monto_total_usd = ?6
         WHERE id = ?7",
        libsql::params![
            input.proveedor_id.clone(),
            input.numero_factura.clone(),
            input.fecha_hora.clone(),
            input.moneda.clone(),
            input.tasa_cambio_dia,
            monto_total_usd,
            factura_id.clone(),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    insertar_items_factura_interna(&tx, &factura_id, &input.proveedor_id, &input.fecha_hora, &input.items).await?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(FacturaCompraOutput { monto_total_usd })
}
