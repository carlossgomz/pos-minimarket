// Conexión a la base de datos compartida (Turso/libSQL, modo remoto puro —
// sin réplica local, ver el plan en docs de la sesión: el modo réplica
// embebida tiene un bug de escritura offline en beta y un crash de stack
// overflow conocido en Windows). Cada dispositivo (PC de caja, laptop del
// admin) se conecta directo a la misma base en la nube por HTTPS.
//
// El bug de stack overflow en Windows SÍ se reprodujo también en este modo
// remoto puro durante la prueba de validación — el parser de SQL de
// libsql se desborda con el stack de 1MB por defecto de un hilo en
// Windows. La mitigación (confirmada funcionando) es correr todo el
// trabajo de tokio en hilos con un stack grande — eso se configura una
// sola vez en main.rs, instalando un runtime de tokio propio como el
// runtime async de Tauri, así que este archivo no necesita preocuparse
// por eso.

use libsql::{Builder, Database};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::RwLock;

/// Estado gestionado por Tauri: la conexión puede no existir todavía si el
/// dispositivo no se ha configurado (primera vez que se abre la app en esa
/// PC). Empieza en None; `guardar_config_sync` la llena sin necesitar
/// reiniciar la app.
pub struct EstadoBaseDatos(pub RwLock<Option<Database>>);

#[derive(Debug, Serialize, Deserialize)]
struct ConfigDispositivo {
    turso_url: String,
    turso_auth_token: String,
}

fn ruta_config(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No se pudo ubicar la carpeta de datos de la app: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sync-config.json"))
}

fn leer_config_local(app: &tauri::AppHandle) -> Option<ConfigDispositivo> {
    let ruta = ruta_config(app).ok()?;
    let contenido = std::fs::read_to_string(ruta).ok()?;
    serde_json::from_str(&contenido).ok()
}

/// Abre la conexión remota y aplica las migraciones pendientes. Se llama
/// tanto al arrancar (si ya hay configuración guardada) como justo después
/// de que el usuario guarda la configuración por primera vez en un
/// dispositivo nuevo.
async fn abrir_y_migrar(url: String, token: String) -> anyhow::Result<Database> {
    let db = Builder::new_remote(url, token).build().await?;
    let conn = db.connect()?;
    ejecutar_migraciones(&conn).await?;
    Ok(db)
}

/// Al arrancar la app: si ya existe sync-config.json en esta PC, conecta de
/// una vez. Si no existe (primera vez en este dispositivo), deja el estado
/// vacío — el frontend lo detecta con `tiene_config_sync` y muestra la
/// pantalla de configuración antes de llegar al login.
pub async fn inicializar(app: &tauri::AppHandle) -> EstadoBaseDatos {
    let Some(cfg) = leer_config_local(app) else {
        return EstadoBaseDatos(RwLock::new(None));
    };
    match abrir_y_migrar(cfg.turso_url, cfg.turso_auth_token).await {
        Ok(db) => EstadoBaseDatos(RwLock::new(Some(db))),
        Err(e) => {
            // No se puede conectar (¿sin internet al prender la PC?) — se
            // deja vacío en vez de tumbar la app; los comandos devolverán
            // un error claro hasta que haya conexión. El usuario puede
            // reintentar reabriendo la app cuando tenga internet.
            eprintln!("No se pudo conectar a la base remota al arrancar: {e}");
            EstadoBaseDatos(RwLock::new(None))
        }
    }
}

#[tauri::command]
pub fn tiene_config_sync(app: tauri::AppHandle) -> bool {
    leer_config_local(&app).is_some()
}

#[tauri::command]
pub async fn guardar_config_sync(
    app: tauri::AppHandle,
    estado: tauri::State<'_, EstadoBaseDatos>,
    turso_url: String,
    turso_auth_token: String,
) -> Result<(), String> {
    let turso_url = turso_url.trim().to_string();
    let turso_auth_token = turso_auth_token.trim().to_string();
    if turso_url.is_empty() || turso_auth_token.is_empty() {
        return Err("Faltan la URL o el token.".to_string());
    }

    let db = abrir_y_migrar(turso_url.clone(), turso_auth_token.clone())
        .await
        .map_err(|e| format!("No se pudo conectar con esos datos: {e}"))?;

    let ruta = ruta_config(&app)?;
    let cfg = ConfigDispositivo { turso_url, turso_auth_token };
    std::fs::write(&ruta, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    *estado.0.write().await = Some(db);
    Ok(())
}

/// Cada entrada: (versión, descripción, SQL). El contenido de los 10
/// archivos no cambia — solo el mecanismo que los aplica (antes lo hacía
/// tauri-plugin-sql solo).
const MIGRACIONES: &[(i64, &str, &str)] = &[
    (1, "esquema inicial", include_str!("../migrations/0001_init.sql")),
    (2, "cuadre de caja diario", include_str!("../migrations/0002_cuadre_caja.sql")),
    (3, "vendedores", include_str!("../migrations/0003_vendedores.sql")),
    (4, "productos de prueba", include_str!("../migrations/0004_productos_prueba.sql")),
    (5, "inventario avanzado", include_str!("../migrations/0005_inventario_avanzado.sql")),
    (6, "compras por paquete", include_str!("../migrations/0006_compras_por_paquete.sql")),
    (7, "referencia pago proveedor", include_str!("../migrations/0007_referencia_pago_proveedor.sql")),
    (8, "iva compras", include_str!("../migrations/0008_iva_compras.sql")),
    (9, "descuento compras", include_str!("../migrations/0009_descuento_compras.sql")),
    (10, "usuarios", include_str!("../migrations/0010_usuarios.sql")),
    (11, "gemini api key", include_str!("../migrations/0011_gemini_api_key.sql")),
    (12, "lotes de producto (fifo)", include_str!("../migrations/0012_lotes_producto.sql")),
    (13, "codigo de proveedor", include_str!("../migrations/0013_codigo_proveedor.sql")),
    (14, "clientes delivery", include_str!("../migrations/0014_clientes_delivery.sql")),
    (15, "direccion venta", include_str!("../migrations/0015_direccion_venta.sql")),
    (16, "avances de efectivo", include_str!("../migrations/0016_avances_efectivo.sql")),
    (17, "capital externo", include_str!("../migrations/0017_capital_externo.sql")),
    (18, "codigos de proveedor por producto", include_str!("../migrations/0018_codigos_proveedor_producto.sql")),
    (19, "delivery", include_str!("../migrations/0019_delivery.sql")),
    (20, "interruptor de sincronizacion automatica de delivery", include_str!("../migrations/0020_delivery_sync_toggle.sql")),
    (21, "verificacion admin de pago movil", include_str!("../migrations/0021_pago_movil_verificado.sql")),
];

pub async fn ejecutar_migraciones(conn: &libsql::Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version     INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )
    .await?;

    let mut aplicadas = std::collections::HashSet::new();
    let mut filas = conn.query("SELECT version FROM _migrations", ()).await?;
    while let Some(fila) = filas.next().await? {
        aplicadas.insert(fila.get::<i64>(0)?);
    }

    for (version, descripcion, sql) in MIGRACIONES {
        if aplicadas.contains(version) {
            continue;
        }
        conn.execute_transactional_batch(sql).await.map_err(|e| {
            anyhow::anyhow!("migración {version} ({descripcion}) falló: {e}")
        })?;
        conn.execute(
            "INSERT INTO _migrations (version, description) VALUES (?1, ?2)",
            libsql::params![*version, *descripcion],
        )
        .await?;
    }
    Ok(())
}

pub async fn obtener_conexion(
    estado: &tauri::State<'_, EstadoBaseDatos>,
) -> Result<libsql::Connection, String> {
    let guard = estado.0.read().await;
    let db = guard
        .as_ref()
        .ok_or_else(|| "Este dispositivo todavía no está configurado (o no hay conexión). Revisa Configuración de sincronización.".to_string())?;
    db.connect().map_err(|e| e.to_string())
}

/// Chequeo de conectividad real (no solo "¿hay Database configurada?"):
/// intenta una consulta corta contra Turso. Lo usan tanto los comandos
/// críticos de caja (para decidir si encolar) como la tarea de fondo de
/// sincronización y el indicador de conexión del frontend.
pub async fn esta_en_linea(estado: &tauri::State<'_, EstadoBaseDatos>) -> bool {
    let Ok(conn) = obtener_conexion(estado).await else {
        return false;
    };
    conn.query("SELECT 1", ()).await.is_ok()
}

fn json_a_libsql(v: &serde_json::Value) -> Result<libsql::Value, String> {
    Ok(match v {
        serde_json::Value::Null => libsql::Value::Null,
        serde_json::Value::Bool(b) => libsql::Value::Integer(*b as i64),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                libsql::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                libsql::Value::Real(f)
            } else {
                return Err(format!("número no soportado: {n}"));
            }
        }
        serde_json::Value::String(s) => libsql::Value::Text(s.clone()),
        otro => return Err(format!("tipo de parámetro no soportado: {otro:?}")),
    })
}

fn libsql_a_json(v: libsql::Value) -> serde_json::Value {
    match v {
        libsql::Value::Null => serde_json::Value::Null,
        libsql::Value::Integer(i) => serde_json::json!(i),
        libsql::Value::Real(f) => serde_json::json!(f),
        libsql::Value::Text(s) => serde_json::Value::String(s),
        libsql::Value::Blob(b) => serde_json::Value::String(format!("<blob {} bytes>", b.len())),
    }
}

async fn filas_a_json(
    mut filas: libsql::Rows,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let mut resultado = Vec::new();
    while let Some(fila) = filas.next().await.map_err(|e| e.to_string())? {
        let n = fila.column_count();
        let mut mapa = serde_json::Map::with_capacity(n as usize);
        for i in 0..n {
            let nombre = fila.column_name(i).unwrap_or_default().to_string();
            let valor = fila.get_value(i).map_err(|e| e.to_string())?;
            mapa.insert(nombre, libsql_a_json(valor));
        }
        resultado.push(mapa);
    }
    Ok(resultado)
}

/// Reemplaza a `db.select()` del plugin viejo — misma idea, ahora contra
/// libSQL remoto. El frontend (src/db.ts) llama a esto sin saber que
/// cambió nada por debajo. Si no hay conexión (o la consulta remota
/// falla), cae a la caché local (ver src-tauri/src/offline.rs) — mismo
/// esquema, así que la mayoría de las pantallas siguen funcionando sin
/// cambiar nada, aunque con datos de la última vez que hubo conexión.
#[tauri::command]
pub async fn db_select(
    estado: tauri::State<'_, EstadoBaseDatos>,
    cache: tauri::State<'_, crate::offline::EstadoCache>,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let valores: Vec<libsql::Value> = params.iter().map(json_a_libsql).collect::<Result<_, _>>()?;

    if let Ok(conn) = obtener_conexion(&estado).await {
        if let Ok(filas) = conn.query(&sql, valores.clone()).await {
            if let Ok(resultado) = filas_a_json(filas).await {
                return Ok(resultado);
            }
        }
    }

    let conn_cache = cache.conectar().await?;
    let filas = conn_cache.query(&sql, valores).await.map_err(|e| e.to_string())?;
    filas_a_json(filas).await
}

/// Lectura contra la caché local directamente, SIN intentar la conexión
/// remota primero — para las barras de búsqueda mientras se escribe, donde
/// esperar cada letra a que vaya y vuelva hasta el servidor (Venezuela ↔
/// EE.UU.) se siente lento. La caché se refresca sola cada pocos segundos
/// (ver arrancar_tarea_sincronizacion en offline.rs), así que el dato
/// puede estar unos segundos desactualizado — aceptable para un buscador
/// mientras se escribe, ya que la venta/compra en sí sigue validándose
/// contra la base real al confirmarse. NO usar esto para nada que necesite
/// el dato exacto del momento (stock antes de vender, saldo de crédito).
#[tauri::command]
pub async fn db_select_cache(
    cache: tauri::State<'_, crate::offline::EstadoCache>,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let valores: Vec<libsql::Value> = params.iter().map(json_a_libsql).collect::<Result<_, _>>()?;
    let conn_cache = cache.conectar().await?;
    let filas = conn_cache.query(&sql, valores).await.map_err(|e| e.to_string())?;
    filas_a_json(filas).await
}

/// Reemplaza a `db.execute()` del plugin viejo.
#[tauri::command]
pub async fn db_execute(
    estado: tauri::State<'_, EstadoBaseDatos>,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let conn = obtener_conexion(&estado).await?;
    let valores: Vec<libsql::Value> = params.iter().map(json_a_libsql).collect::<Result<_, _>>()?;

    let filas_afectadas = conn.execute(&sql, valores).await.map_err(|e| e.to_string())?;
    let ultimo_id = conn.last_insert_rowid();

    Ok(serde_json::json!({ "rowsAffected": filas_afectadas, "lastInsertId": ultimo_id }))
}
