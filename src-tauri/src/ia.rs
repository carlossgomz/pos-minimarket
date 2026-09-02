// Lectura de facturas de proveedor con IA (Google Gemini, nivel gratuito).
// Solo hace UNA cosa: mandarle la foto a Gemini y devolver los datos que
// extrajo. No toca la base de datos ni guarda nada — el frontend usa esta
// respuesta para PRE-LLENAR el formulario normal de Compras.tsx, y sigue
// siendo un humano quien revisa cada línea y aprieta "Guardar factura"
// (mismo comando de siempre, guardar_factura_compra, sin cambios).

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::{self, EstadoBaseDatos};

// Los nombres de modelo fijos (gemini-2.0-flash, gemini-2.5-flash) se
// quedan obsoletos o pierden cuota gratuita para cuentas nuevas sin
// aviso — confirmado en la práctica con esta misma cuenta. El alias
// "-latest" lo mantiene Google apuntando siempre al modelo flash vigente
// para evitar tener que perseguir el número de versión cada vez que
// cambian algo.
const MODELO_GEMINI: &str = "gemini-flash-latest";

#[derive(Debug, Serialize, Deserialize)]
pub struct ProveedorExtraido {
    pub nombre: String,
    pub rif: Option<String>,
    pub direccion: Option<String>,
    pub telefono: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ItemExtraido {
    pub codigo: Option<String>,
    pub nombre: String,
    pub cajas: f64,
    pub unidad_suelta: f64,
    pub unidades_por_caja: Option<f64>,
    pub precio_unitario: f64,
    pub aplica_iva: bool,
    pub tasa_iva: Option<f64>,
    pub aplica_descuento: bool,
    pub descuento_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FacturaExtraida {
    pub proveedor: ProveedorExtraido,
    pub numero_factura: Option<String>,
    pub moneda: Option<String>,
    pub items: Vec<ItemExtraido>,
}

const PROMPT: &str = "Esta es una foto de una factura de un proveedor para un minimarket en \
Venezuela. Extrae los datos exactamente como aparecen en la imagen, sin inventar ni completar \
información que no esté visible (usa null cuando falte un dato).

Del proveedor (el que EMITE la factura, no el minimarket que compra): nombre o razón social, \
RIF, dirección y teléfono si aparecen.

De cada línea de producto: código (el que traiga la factura, de barra o interno del proveedor — \
si no hay ninguno, usa null), nombre o descripción tal cual aparece, cantidad en cajas/bultos y \
cantidad en unidades sueltas por separado si la factura las distingue; si la factura solo trae \
una columna de cantidad total, ponla completa en unidad_suelta y deja cajas en 0. Precio unitario \
tal cual aparece (sin IVA ni descuento aplicado, si la factura los separa). Si una línea tiene \
IVA o descuento indicado, márcalo junto con su porcentaje; si no, aplica_iva y aplica_descuento \
en false.

No calcules ni infieras el margen de ganancia del minimarket — eso no está en la factura, \
ignóralo.

También extrae, si aparece: número de factura, y si los montos están en bolívares (Bs, VES) o \
dólares (USD, $) — devuelve moneda como \"VES\" o \"USD\" según corresponda, o null si no es claro.";

fn schema_respuesta() -> serde_json::Value {
    serde_json::json!({
        "type": "OBJECT",
        "properties": {
            "proveedor": {
                "type": "OBJECT",
                "properties": {
                    "nombre": { "type": "STRING" },
                    "rif": { "type": "STRING", "nullable": true },
                    "direccion": { "type": "STRING", "nullable": true },
                    "telefono": { "type": "STRING", "nullable": true }
                },
                "required": ["nombre"]
            },
            "numero_factura": { "type": "STRING", "nullable": true },
            "moneda": { "type": "STRING", "nullable": true },
            "items": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "codigo": { "type": "STRING", "nullable": true },
                        "nombre": { "type": "STRING" },
                        "cajas": { "type": "NUMBER" },
                        "unidad_suelta": { "type": "NUMBER" },
                        "unidades_por_caja": { "type": "NUMBER", "nullable": true },
                        "precio_unitario": { "type": "NUMBER" },
                        "aplica_iva": { "type": "BOOLEAN" },
                        "tasa_iva": { "type": "NUMBER", "nullable": true },
                        "aplica_descuento": { "type": "BOOLEAN" },
                        "descuento_pct": { "type": "NUMBER", "nullable": true }
                    },
                    "required": ["nombre", "cajas", "unidad_suelta", "precio_unitario", "aplica_iva", "aplica_descuento"]
                }
            }
        },
        "required": ["proveedor", "items"]
    })
}

// Lee la clave de Gemini configurada en `config` — la usan tanto el
// escaneo de facturas como la sugerencia de reposición, así que queda acá
// en vez de repetirse.
async fn obtener_api_key(app: &tauri::AppHandle) -> Result<String, String> {
    let estado = app.state::<EstadoBaseDatos>();
    let conn = db::obtener_conexion(&estado).await?;

    let fila = conn
        .query("SELECT gemini_api_key FROM config WHERE id = 1", ())
        .await
        .map_err(|e| e.to_string())?
        .next()
        .await
        .map_err(|e| e.to_string())?;
    let api_key: Option<String> = match fila {
        Some(f) => f.get(0).map_err(|e| e.to_string())?,
        None => None,
    };
    api_key
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "Configura tu API key de Gemini en Compras primero.".to_string())
}

// Llamado compartido a Gemini: manda `contents` (texto y/o imagen) y,
// opcionalmente, un `generation_config` (para pedir JSON con schema fijo,
// como hace escanear_factura) — sin él, Gemini responde en texto plano.
// Devuelve el texto crudo que contestó el modelo, sin interpretarlo, para
// que cada llamador lo parsee como le corresponda.
async fn llamar_gemini(
    api_key: &str,
    contents: serde_json::Value,
    generation_config: Option<serde_json::Value>,
) -> Result<String, String> {
    let mut body = serde_json::json!({ "contents": contents });
    if let Some(config) = generation_config {
        body["generationConfig"] = config;
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{MODELO_GEMINI}:generateContent"
    );

    let cliente = reqwest::Client::new();
    let respuesta = cliente
        .post(&url)
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("No se pudo contactar a Gemini: {e}"))?;

    let status = respuesta.status();
    let texto = respuesta.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Gemini devolvió un error ({status}): {texto}"));
    }

    let cruda: serde_json::Value =
        serde_json::from_str(&texto).map_err(|e| format!("Respuesta inesperada de Gemini: {e}"))?;

    cruda
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .map(|t| t.to_string())
        .ok_or_else(|| format!("Gemini no devolvió texto extraíble: {texto}"))
}

#[tauri::command]
pub async fn escanear_factura(
    app: tauri::AppHandle,
    imagen_base64: String,
    mime_type: String,
) -> Result<FacturaExtraida, String> {
    let api_key = obtener_api_key(&app).await?;

    let contents = serde_json::json!([{
        "parts": [
            { "text": PROMPT },
            { "inline_data": { "mime_type": mime_type, "data": imagen_base64 } }
        ]
    }]);
    let generation_config = serde_json::json!({
        "responseMimeType": "application/json",
        "responseSchema": schema_respuesta()
    });

    let contenido = llamar_gemini(&api_key, contents, Some(generation_config)).await?;

    serde_json::from_str::<FacturaExtraida>(&contenido)
        .map_err(|e| format!("No se pudo interpretar lo que extrajo la IA: {e}"))
}

// Ventana de historial para calcular la venta diaria promedio, y a
// cuántos días de cobertura se repone — mismo criterio de quincena (15
// días) que ya se usa para pagar a los repartidores.
const DIAS_HISTORIAL: i64 = 30;
const DIAS_COBERTURA_OBJETIVO: i64 = 15;

#[derive(Debug, Serialize, Deserialize)]
pub struct CandidatoReposicion {
    pub producto_id: String,
    pub nombre: String,
    pub stock_actual: f64,
    pub venta_diaria_promedio: f64,
    pub dias_restantes: Option<f64>,
    pub cantidad_sugerida: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SugerenciaReposicion {
    pub candidatos: Vec<CandidatoReposicion>,
    pub resumen_ia: Option<String>,
}

#[tauri::command]
pub async fn sugerir_reposicion(app: tauri::AppHandle) -> Result<SugerenciaReposicion, String> {
    // La consulta contra el catálogo completo (cientos de productos)
    // necesita más stack del que dan por defecto los hilos de
    // Tauri/Tokio — confirmado en producción: era un stack overflow real
    // (no un panic común), reproducido fuera de la app contra la misma
    // base. Por eso corre en un hilo aparte con stack más grande, y el
    // resultado vuelve por un canal para no bloquear el runtime async.
    let (tx, rx) = tokio::sync::oneshot::channel();
    let resultado_spawn = std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tx.send(Err(format!("No se pudo iniciar el cálculo: {e}")));
                    return;
                }
            };
            let resultado = runtime.block_on(sugerir_reposicion_interna(app));
            let _ = tx.send(resultado);
        });

    if let Err(e) = resultado_spawn {
        return Err(format!("No se pudo iniciar el cálculo: {e}"));
    }

    rx.await
        .map_err(|_| "El cálculo de reposición no terminó correctamente.".to_string())?
}

async fn sugerir_reposicion_interna(app: tauri::AppHandle) -> Result<SugerenciaReposicion, String> {
    let estado = app.state::<EstadoBaseDatos>();
    let conn = db::obtener_conexion(&estado).await?;

    // La fecha de corte se calcula acá (no con date('now', ?) del lado de
    // SQLite) para seguir el mismo patrón que ya usa el resto de la app:
    // los rangos de fecha siempre se resuelven a un literal antes de
    // mandarlo a la base (ver Estadisticas.tsx/Reportes.tsx), nunca con
    // aritmética de fechas dentro del SQL.
    let desde = (chrono::Utc::now() - chrono::Duration::days(DIAS_HISTORIAL))
        .format("%Y-%m-%d")
        .to_string();

    // Un producto por peso vende en kilos, no en "unidades" — hay que
    // comparar volumen real contra stock_actual (también en kilos) para
    // que la matemática de reposición tenga sentido; por eso acá NO se
    // cuenta "1 por línea" como sí hace Estadisticas.tsx para su ranking.
    // El 0.0 acá (no 0) importa: si fuera entero, esta columna cambia de
    // tipo fila a fila (entero cuando no hubo ventas, real cuando sí) —
    // eso rompe la decodificación remota de libsql 0.9.30, confirmado
    // reproduciendo el crash de producción contra el catálogo completo
    // (652 productos, 208 con el tipo mezclado, panic "invalid value
    // type" en todos esos hasta fijar el tipo acá).
    let mut filas = conn
        .query(
            "SELECT p.id, p.nombre, p.stock_actual, p.stock_minimo,
                    COALESCE((
                      SELECT SUM(vi.cantidad) FROM venta_items vi
                      JOIN ventas v ON v.id = vi.venta_id
                      WHERE vi.producto_id = p.id
                        AND date(v.fecha_hora) >= ?1
                    ), 0.0) as vendido_periodo
             FROM productos p
             WHERE p.activo = 1 AND p.id != 'f195fbac-103d-48fa-a27a-28371fba7745'",
            libsql::params![desde],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut candidatos: Vec<CandidatoReposicion> = Vec::new();
    while let Some(fila) = filas.next().await.map_err(|e| e.to_string())? {
        let producto_id: String = fila.get(0).map_err(|e| e.to_string())?;
        let nombre: String = fila.get(1).map_err(|e| e.to_string())?;
        let stock_actual: f64 = fila.get(2).map_err(|e| e.to_string())?;
        let stock_minimo: f64 = fila.get(3).map_err(|e| e.to_string())?;
        let vendido_periodo: f64 = fila.get(4).map_err(|e| e.to_string())?;

        let venta_diaria_promedio = vendido_periodo / DIAS_HISTORIAL as f64;
        let dias_restantes = if venta_diaria_promedio > 0.0 {
            Some(stock_actual / venta_diaria_promedio)
        } else {
            None
        };

        let necesita_reposicion = stock_actual <= stock_minimo
            || dias_restantes.is_some_and(|d| d < DIAS_COBERTURA_OBJETIVO as f64);
        if !necesita_reposicion {
            continue;
        }

        let por_venta = venta_diaria_promedio * DIAS_COBERTURA_OBJETIVO as f64 - stock_actual;
        let por_minimo = stock_minimo - stock_actual;
        let cantidad_sugerida = por_venta.max(por_minimo).max(0.0).ceil();

        candidatos.push(CandidatoReposicion {
            producto_id,
            nombre,
            stock_actual,
            venta_diaria_promedio,
            dias_restantes,
            cantidad_sugerida,
        });
    }

    candidatos.sort_by(|a, b| match (a.dias_restantes, b.dias_restantes) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    if candidatos.is_empty() {
        return Ok(SugerenciaReposicion {
            candidatos,
            resumen_ia: None,
        });
    }

    let resumen_ia = match obtener_api_key(&app).await {
        Ok(api_key) => {
            let lista = candidatos
                .iter()
                .map(|c| {
                    let dias = c
                        .dias_restantes
                        .map(|d| format!("{d:.0} días de stock restante"))
                        .unwrap_or_else(|| "sin ventas recientes".to_string());
                    format!("- {} ({dias}, repone {:.0})", c.nombre, c.cantidad_sugerida)
                })
                .collect::<Vec<_>>()
                .join("\n");
            let prompt = format!(
                "Esta es una lista de productos de un minimarket en Venezuela que necesitan \
                 reposición, ya calculada con ventas de los últimos {DIAS_HISTORIAL} días:\n\n\
                 {lista}\n\n\
                 Escribe un resumen corto (3 a 5 líneas, texto plano, en español simple para el \
                 dueño de la tienda) priorizando qué comprar primero y por qué. No inventes \
                 números que no estén en la lista."
            );
            let contents = serde_json::json!([{ "parts": [{ "text": prompt }] }]);
            llamar_gemini(&api_key, contents, None).await.ok()
        }
        Err(_) => None,
    };

    Ok(SugerenciaReposicion {
        candidatos,
        resumen_ia,
    })
}
