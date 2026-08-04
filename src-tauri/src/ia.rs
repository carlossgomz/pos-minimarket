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

#[tauri::command]
pub async fn escanear_factura(
    app: tauri::AppHandle,
    imagen_base64: String,
    mime_type: String,
) -> Result<FacturaExtraida, String> {
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
    let api_key = api_key
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "Configura tu API key de Gemini en Compras primero.".to_string())?;

    let body = serde_json::json!({
        "contents": [{
            "parts": [
                { "text": PROMPT },
                { "inline_data": { "mime_type": mime_type, "data": imagen_base64 } }
            ]
        }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema_respuesta()
        }
    });

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

    let contenido = cruda
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| format!("Gemini no devolvió texto extraíble: {texto}"))?;

    serde_json::from_str::<FacturaExtraida>(contenido)
        .map_err(|e| format!("No se pudo interpretar lo que extrajo la IA: {e}"))
}
