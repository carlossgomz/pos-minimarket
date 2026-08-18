// Integración con la app de delivery (Next.js + Postgres/Supabase, en
// Vercel — repo aparte, sin base de datos compartida). Todo pasa por HTTP
// contra los endpoints /api/pos/* de esa app, con un token compartido
// guardado en config.delivery_api_url / config.delivery_sync_token (ver
// migración 0019). Si esos campos están vacíos, las tareas de acá no hacen
// nada — es una función opcional, no rompe la app si no se configura.
//
// Dos tareas de fondo, arrancadas una sola vez desde lib.rs:
//   - sincronizar_catalogo: cada 5 min, empuja productos activos (nombre,
//     precio calculado, categoría, si se vende por delivery) — también
//     expuesta como comando manual para el botón "sincronizar ahora".
//   - revisar_pedidos: cada ~30s, 1) cuenta pedidos recién llegados sin
//     revisar (para el aviso del encabezado) y 2) importa como venta cada
//     pedido ya entregado que la delivery-app todavía no tiene marcado
//     como importado — reutilizando confirmar_venta_interna tal cual la
//     usa una venta normal de mostrador (mismo descuento de stock FIFO,
//     mismo movimiento de inventario).

use chrono::{DateTime, FixedOffset, Utc};
use serde::Deserialize;
use tauri::Manager;
use tokio::sync::RwLock;

use crate::comandos::{self, ConfirmarVentaInput, ItemVentaInput, PagoVentaInput};
use crate::db::{self, EstadoBaseDatos};

/// Estado en memoria con el conteo de pedidos pendientes de revisar, que
/// el frontend lee vía `obtener_pedidos_delivery_pendientes` — evita que
/// cada poll del encabezado (cada ~20-30s) tenga que ir hasta la
/// delivery-app; lo actualiza la tarea de fondo de acá.
pub struct EstadoPedidosDelivery(pub RwLock<i64>);

impl Default for EstadoPedidosDelivery {
    fn default() -> Self {
        EstadoPedidosDelivery(RwLock::new(0))
    }
}

#[tauri::command]
pub async fn obtener_pedidos_delivery_pendientes(
    estado: tauri::State<'_, EstadoPedidosDelivery>,
) -> Result<i64, String> {
    Ok(*estado.0.read().await)
}

struct ConfigDelivery {
    api_url: String,
    token: String,
    sync_automatico: bool,
}

async fn leer_config_delivery(conn: &libsql::Connection) -> Option<ConfigDelivery> {
    let mut filas = conn
        .query(
            "SELECT delivery_api_url, delivery_sync_token, delivery_sync_automatico FROM config WHERE id = 1",
            (),
        )
        .await
        .ok()?;
    let fila = filas.next().await.ok()??;
    let api_url: Option<String> = fila.get(0).ok()?;
    let token: Option<String> = fila.get(1).ok()?;
    let sync_automatico: i64 = fila.get(2).ok()?;
    let api_url = api_url.filter(|s| !s.trim().is_empty())?;
    let token = token.filter(|s| !s.trim().is_empty())?;
    // Sin barra final, para poder concatenar "{api_url}/api/pos/..." sin dobles barras.
    Some(ConfigDelivery {
        api_url: api_url.trim_end_matches('/').to_string(),
        token,
        sync_automatico: sync_automatico != 0,
    })
}

/// Mismo cálculo que precioVentaUsd en src/precios.ts — margen bruto sobre
/// el precio de venta, topado en 99.99% para no dividir por cero.
fn precio_venta_usd(costo: f64, margen: Option<f64>) -> f64 {
    let margen = margen.unwrap_or(0.0).clamp(0.0, 99.99);
    costo / (1.0 - margen / 100.0)
}

/// "2026-08-06T15:37:39.095Z" (UTC, como lo manda Prisma) -> "2026-08-06
/// 11:37:39" (hora de Venezuela, UTC-4 fijo, sin horario de verano) — mismo
/// formato que fechaHoraVenezuela() en el frontend, para que esta venta
/// caiga en el día correcto en Cuadre de Caja/Reportes.
fn a_hora_venezuela(iso_utc: &str) -> String {
    let venezuela = FixedOffset::west_opt(4 * 3600).expect("offset fijo válido");
    match DateTime::parse_from_rfc3339(iso_utc) {
        Ok(dt) => dt.with_timezone(&venezuela).format("%Y-%m-%d %H:%M:%S").to_string(),
        // No debería pasar (el formato lo controla Prisma), pero si llega
        // algo raro, mejor la hora actual que reventar la importación.
        Err(_) => Utc::now().with_timezone(&venezuela).format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct ProductoParaEmpuje {
    id: String,
    codigo_barra: String,
    nombre: String,
    costo_actual_usd: f64,
    margen_porcentaje: Option<f64>,
    categoria_nombre: Option<String>,
    disponible_delivery: i64,
}

/// Empuja el catálogo activo completo (no solo lo que cambió — a esta
/// escala, unos cientos de productos, es más simple y suficientemente
/// barato que llevar un diff). Se manda TODO lo activo, no solo lo
/// disponible_delivery=1: así, si un producto se acaba de excluir, la
/// delivery-app recibe el disponibleDelivery=false que lo saca de su
/// catálogo — si solo mandara lo incluido, nunca se enteraría del cambio.
async fn sincronizar_catalogo(conn: &libsql::Connection, cfg: &ConfigDelivery) -> Result<usize, String> {
    let mut filas = conn
        .query(
            "SELECT p.id, p.codigo_barra, p.nombre, p.costo_actual_usd, p.margen_porcentaje,
                    c.nombre as categoria_nombre, p.disponible_delivery
             FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
             WHERE p.activo = 1",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut productos = Vec::new();
    while let Some(fila) = filas.next().await.map_err(|e| e.to_string())? {
        productos.push(ProductoParaEmpuje {
            id: fila.get(0).map_err(|e| e.to_string())?,
            codigo_barra: fila.get(1).map_err(|e| e.to_string())?,
            nombre: fila.get(2).map_err(|e| e.to_string())?,
            costo_actual_usd: fila.get(3).map_err(|e| e.to_string())?,
            margen_porcentaje: fila.get(4).map_err(|e| e.to_string())?,
            categoria_nombre: fila.get(5).map_err(|e| e.to_string())?,
            disponible_delivery: fila.get(6).map_err(|e| e.to_string())?,
        });
    }

    if productos.is_empty() {
        return Ok(0);
    }

    let payload: Vec<serde_json::Value> = productos
        .iter()
        .map(|p| {
            serde_json::json!({
                "posId": p.id,
                "codigo": p.codigo_barra,
                "nombre": p.nombre,
                "precioUsd": precio_venta_usd(p.costo_actual_usd, p.margen_porcentaje),
                "categoria": p.categoria_nombre.clone().unwrap_or_else(|| "Sin categoría".to_string()),
                "disponibleDelivery": p.disponible_delivery != 0,
            })
        })
        .collect();

    let cliente = reqwest::Client::new();
    let respuesta = cliente
        .post(format!("{}/api/pos/productos/sync", cfg.api_url))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({ "productos": payload }))
        .send()
        .await
        .map_err(|e| format!("No se pudo contactar la app de delivery: {e}"))?;

    if !respuesta.status().is_success() {
        let status = respuesta.status();
        let texto = respuesta.text().await.unwrap_or_default();
        return Err(format!("La app de delivery devolvió un error ({status}): {texto}"));
    }

    Ok(productos.len())
}

/// Comando para el botón "sincronizar con delivery ahora" en Inventario.
#[tauri::command]
pub async fn sincronizar_catalogo_delivery(
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let estado = app.state::<EstadoBaseDatos>();
    let conn = db::obtener_conexion(&estado).await?;
    let cfg = leer_config_delivery(&conn)
        .await
        .ok_or_else(|| "Configura primero la URL y el token de la app de delivery.".to_string())?;
    sincronizar_catalogo(&conn, &cfg).await
}

#[derive(Debug, Deserialize)]
struct PedidosPendientesRespuesta {
    total: i64,
}

#[derive(Debug, Deserialize)]
struct ItemPedidoEntregado {
    codigo: String,
    cantidad: f64,
    // Ya incluye el recargo de delivery ($0.10/producto) — ver el
    // comentario en importar_pedido_como_venta.
    #[serde(rename = "totalBsLinea")]
    total_bs_linea: f64,
}

#[derive(Debug, Deserialize)]
struct PedidoEntregado {
    id: String,
    #[serde(rename = "clienteNombre")]
    cliente_nombre: String,
    direccion: String,
    #[serde(rename = "tasaCambio")]
    tasa_cambio: f64,
    #[serde(rename = "entregadoAt")]
    entregado_at: Option<String>,
    items: Vec<ItemPedidoEntregado>,
}

#[derive(Debug, Deserialize)]
struct PedidosEntregadosRespuesta {
    pedidos: Vec<PedidoEntregado>,
}

async fn revisar_pendientes(
    cliente: &reqwest::Client,
    cfg: &ConfigDelivery,
    estado_pedidos: &EstadoPedidosDelivery,
) {
    let respuesta = cliente
        .get(format!("{}/api/pos/pedidos/pendientes", cfg.api_url))
        .bearer_auth(&cfg.token)
        .send()
        .await;
    let Ok(respuesta) = respuesta else { return };
    let Ok(cuerpo) = respuesta.json::<PedidosPendientesRespuesta>().await else { return };
    *estado_pedidos.0.write().await = cuerpo.total;
}

/// Importa cada pedido entregado sin importar, y SOLO SI la venta quedó
/// creada de verdad, avisa a la delivery-app con el PATCH marcar-importado.
///
/// Antes era al revés (reclamar primero, crear después): si algo fallaba
/// creando la venta — un error transitorio, un dato raro de un pedido en
/// particular — el pedido ya había quedado marcado como importado en la
/// delivery-app, así que nunca se reintentaba, y esa venta se perdía para
/// siempre sin que nadie se enterara (pasó de verdad con un pedido real el
/// 2026-08-16). Invertir el orden hace que un fallo se reintente solo en el
/// próximo ciclo (cada 5s) hasta que funcione.
///
/// Para que esto siga siendo seguro con más de una PC corriendo el POS a
/// la vez (ya no hay "reclamo" que evite que dos PCs importen el mismo
/// pedido en paralelo), `importar_pedido_como_venta` es idempotente: si la
/// venta ya existe (la creó esta misma PC en un ciclo anterior que falló
/// después de crearla pero antes de marcarla, o la ganó otra PC en la
/// carrera) simplemente no hace nada y deja que se marque igual. Como
/// respaldo también hay un índice único en ventas.pedido_delivery_id (ver
/// migración 0022) que hace fallar limpio el INSERT si dos PCs llegan a
/// intentarlo exactamente al mismo tiempo.
async fn revisar_entregados(
    cliente: &reqwest::Client,
    cfg: &ConfigDelivery,
    conn: &libsql::Connection,
) {
    let respuesta = cliente
        .get(format!("{}/api/pos/pedidos/entregados-sin-importar", cfg.api_url))
        .bearer_auth(&cfg.token)
        .send()
        .await;
    let Ok(respuesta) = respuesta else { return };
    let Ok(cuerpo) = respuesta.json::<PedidosEntregadosRespuesta>().await else { return };

    for pedido in cuerpo.pedidos {
        if let Err(e) = importar_pedido_como_venta(conn, &pedido).await {
            eprintln!(
                "Delivery: no se pudo registrar la venta del pedido {} — se reintenta en el próximo ciclo: {e}",
                pedido.id
            );
            continue; // no se marca importado, para que se reintente
        }

        let _ = cliente
            .patch(format!("{}/api/pos/pedidos/{}/marcar-importado", cfg.api_url, pedido.id))
            .bearer_auth(&cfg.token)
            .send()
            .await;
        // Si el PATCH falla (red caída, etc.) no pasa nada grave: la venta
        // ya quedó creada, y como importar_pedido_como_venta es idempotente,
        // el próximo ciclo simplemente vuelve a marcarlo sin duplicar nada.
    }
}

async fn importar_pedido_como_venta(
    conn: &libsql::Connection,
    pedido: &PedidoEntregado,
) -> Result<(), String> {
    let mut filas_existentes = conn
        .query(
            "SELECT id FROM ventas WHERE pedido_delivery_id = ?1",
            libsql::params![pedido.id.clone()],
        )
        .await
        .map_err(|e| e.to_string())?;
    if filas_existentes.next().await.map_err(|e| e.to_string())?.is_some() {
        return Ok(()); // ya se había creado la venta — solo falta (re)marcarla
    }

    let mut items = Vec::new();
    let mut subtotal_bs = 0.0;

    for item in &pedido.items {
        let mut filas = conn
            .query(
                "SELECT id FROM productos WHERE codigo_barra = ?1",
                libsql::params![item.codigo.clone()],
            )
            .await
            .map_err(|e| e.to_string())?;
        let Some(fila) = filas.next().await.map_err(|e| e.to_string())? else {
            eprintln!(
                "Delivery: pedido {} tiene un producto (código {}) que no existe en el POS — se omite esa línea.",
                pedido.id, item.codigo
            );
            continue;
        };
        let producto_id: String = fila.get(0).map_err(|e| e.to_string())?;

        // total_bs_linea ya trae el recargo de delivery incluido (lo
        // calcula la delivery-app con la misma fórmula que usa para
        // cobrarle al cliente) — se reparte entre la cantidad solo para
        // tener un precio unitario que guardar en venta_items; lo que
        // importa para el cuadre de caja es que la suma de las líneas
        // (subtotal_bs) coincida con lo que realmente se cobró.
        let precio_unit_bs = if item.cantidad > 0.0 { item.total_bs_linea / item.cantidad } else { 0.0 };
        subtotal_bs += item.total_bs_linea;
        items.push(ItemVentaInput { producto_id, cantidad: item.cantidad, precio_unit_bs });
    }

    if items.is_empty() {
        return Err("ningún producto del pedido existe en el catálogo del POS, no se registró venta".to_string());
    }

    let fecha_hora = pedido
        .entregado_at
        .as_deref()
        .map(a_hora_venezuela)
        .unwrap_or_else(|| a_hora_venezuela(&Utc::now().to_rfc3339()));

    let input = ConfirmarVentaInput {
        id: uuid::Uuid::new_v4().to_string(),
        fecha_hora,
        cliente_nombre: Some(pedido.cliente_nombre.clone()),
        cliente_cedula: None,
        cliente_direccion: Some(pedido.direccion.clone()),
        vendedor_id: None,
        vendedor_nombre: None,
        tasa_cambio_dia: pedido.tasa_cambio,
        subtotal_bs,
        iva_bs: 0.0,
        total_bs: subtotal_bs,
        estado: "COMPLETADA".to_string(),
        monto_pendiente_usd: None,
        canal: "DELIVERY".to_string(),
        pedido_delivery_id: Some(pedido.id.clone()),
        // La app todavía no captura quién entrega cada pedido — se asigna
        // después a mano desde Facturas (ver Cuentas → Comisiones de delivery).
        repartidor_id: None,
        items,
        // El método de pago real de un pedido de delivery es pago móvil
        // (así es como se cobra) — "canal" arriba ya deja la venta
        // etiquetada como delivery para Facturas/Reportes; esto es
        // aparte, para que el Cuadre de Caja sume el monto donde
        // realmente entra el dinero.
        pagos: vec![PagoVentaInput {
            metodo: "PAGO_MOVIL".to_string(),
            monto_bs: subtotal_bs,
            referencia: Some(pedido.id.clone()),
        }],
    };

    match comandos::confirmar_venta_interna(conn, &input).await {
        Ok(_) => Ok(()),
        // Dos PCs intentaron crear la misma venta casi al mismo tiempo — la
        // otra ganó la carrera (ver índice único de la migración 0022). No
        // es un error real: la venta ya existe, solo falta marcar el
        // pedido, que es justo lo que hace el llamador al recibir Ok acá.
        Err(e) if e.contains("UNIQUE constraint failed") && e.contains("pedido_delivery_id") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Arranca las dos tareas de fondo (catálogo cada 5 min, pedidos cada 5s
/// — el aviso de pedido pendiente necesita sentirse casi inmediato, y la
/// consulta es liviana). Se llama una sola vez desde .setup() en lib.rs,
/// igual que offline::arrancar_tarea_sincronizacion.
pub fn arrancar_tareas(app: tauri::AppHandle) {
    let app_catalogo = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut intervalo = tokio::time::interval(std::time::Duration::from_secs(5 * 60));
        loop {
            intervalo.tick().await;
            let estado = app_catalogo.state::<EstadoBaseDatos>();
            let Ok(conn) = db::obtener_conexion(&estado).await else { continue };
            let Some(cfg) = leer_config_delivery(&conn).await else { continue };
            // "Sincronizar con delivery ahora" (comando manual) siempre
            // funciona; esto solo apaga el empuje automático cada 5 min,
            // para cuando el dueño está ajustando precios/stock a mano y no
            // quiere que la delivery-app los reciba todavía.
            if !cfg.sync_automatico {
                continue;
            }
            if let Err(e) = sincronizar_catalogo(&conn, &cfg).await {
                eprintln!("Delivery: error sincronizando catálogo: {e}");
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        let cliente = reqwest::Client::new();
        let mut intervalo = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            intervalo.tick().await;
            let estado = app.state::<EstadoBaseDatos>();
            let Ok(conn) = db::obtener_conexion(&estado).await else { continue };
            let Some(cfg) = leer_config_delivery(&conn).await else { continue };

            let estado_pedidos = app.state::<EstadoPedidosDelivery>();
            revisar_pendientes(&cliente, &cfg, &estado_pedidos).await;
            revisar_entregados(&cliente, &cfg, &conn).await;
        }
    });
}
