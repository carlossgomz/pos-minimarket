// Caché local de respaldo (cache.db) + cola de comandos pendientes
// (outbox) para que la caja pueda seguir vendiendo sin internet. Ver el
// plan de la sesión: nunca hay dos dispositivos vendiendo a la vez, así
// que no hace falta resolver conflictos de escritura concurrente — solo
// que UN dispositivo pueda seguir trabajando offline y ponerse al día
// solo cuando vuelva la conexión.
//
// Alcance deliberado: no es un motor de sincronización genérico, solo
// cubre lo que la caja necesita para seguir vendiendo (confirmar_venta,
// ajustar_stock, registrar_consumo_interno). Los flujos administrativos
// (abonos, pagos a proveedor, facturas de compra) siguen requiriendo
// conexión.

use libsql::{Builder, Database};
use std::path::PathBuf;
use tauri::Manager;

use crate::db::{self, EstadoBaseDatos};

pub struct EstadoCache(pub Database);

impl EstadoCache {
    /// Conexión nueva a la caché local, con un tiempo de espera si otra
    /// conexión la tiene ocupada — sin esto, dos accesos casi simultáneos
    /// (la tarea de sincronización refrescando la caché mientras el
    /// indicador de conexión del frontend pregunta cuántos pendientes
    /// hay, por ejemplo) chocan con "database is locked" en vez de que
    /// uno espere al otro un momento. `busy_timeout` es por conexión, así
    /// que se configura cada vez.
    pub async fn conectar(&self) -> Result<libsql::Connection, String> {
        let conn = self.0.connect().map_err(|e| e.to_string())?;
        // PRAGMA busy_timeout devuelve una fila con el valor nuevo, así
        // que hay que usar query() — execute() falla si la sentencia
        // devuelve filas.
        conn.query("PRAGMA busy_timeout = 5000", ())
            .await
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }
}

const TABLAS_CACHEADAS: &[&str] =
    &["categorias", "productos", "clientes", "proveedores", "vendedores", "config", "lotes_producto"];

fn ruta_cache(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No se pudo ubicar la carpeta de datos de la app: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("cache.db"))
}

/// Abre (o crea) la base local de respaldo y le aplica las mismas
/// migraciones que a Turso, más la tabla de la cola de pendientes. A
/// diferencia de la conexión a Turso (que puede no existir si falta
/// configurar el dispositivo o no hay internet), esta base SIEMPRE está
/// disponible — se crea sola en el primer arranque.
pub async fn inicializar(app: &tauri::AppHandle) -> anyhow::Result<EstadoCache> {
    let ruta = ruta_cache(app).map_err(|e| anyhow::anyhow!(e))?;
    let db = Builder::new_local(&ruta).build().await?;
    let conn = db.connect()?;
    // WAL en vez del modo por defecto: permite que una lectura (el
    // indicador de conexión, por ejemplo) no bloquee ni sea bloqueada por
    // una escritura larga (refrescar_cache) en la misma base local.
    // PRAGMA journal_mode devuelve una fila con el modo resultante, así
    // que hay que usar query() en vez de execute().
    conn.query("PRAGMA journal_mode = WAL", ()).await?;
    db::ejecutar_migraciones(&conn).await?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY,
            comando TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            estado TEXT NOT NULL DEFAULT 'pendiente',
            creado_at TEXT NOT NULL DEFAULT (datetime('now')),
            intentos INTEGER NOT NULL DEFAULT 0,
            ultimo_error TEXT
        );",
    )
    .await?;
    Ok(EstadoCache(db))
}

/// Guarda un comando pendiente en la cola local para reintentar cuando
/// vuelva la conexión.
pub async fn encolar(
    cache: &EstadoCache,
    comando: &str,
    payload: &impl serde::Serialize,
) -> Result<(), String> {
    let conn = cache.conectar().await?;
    let payload_json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO outbox (id, comando, payload_json) VALUES (lower(hex(randomblob(16))), ?1, ?2)",
        libsql::params![comando.to_string(), payload_json],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct EstadoConexion {
    en_linea: bool,
    pendientes: i64,
}

/// Comando liviano para el indicador de conexión del frontend.
#[tauri::command]
pub async fn estado_conexion(
    estado: tauri::State<'_, EstadoBaseDatos>,
    cache: tauri::State<'_, EstadoCache>,
) -> Result<EstadoConexion, String> {
    let en_linea = db::esta_en_linea(&estado).await;

    let conn = cache.conectar().await?;
    let mut filas = conn
        .query("SELECT COUNT(*) FROM outbox WHERE estado = 'pendiente'", ())
        .await
        .map_err(|e| e.to_string())?;
    let pendientes: i64 = match filas.next().await.map_err(|e| e.to_string())? {
        Some(f) => f.get(0).map_err(|e| e.to_string())?,
        None => 0,
    };

    Ok(EstadoConexion { en_linea, pendientes })
}

/// Arranca la tarea de fondo que, cada ~5s, reproduce la cola pendiente y
/// refresca la caché de lectura si hay conexión. Se llama una sola vez
/// desde `.setup()` en lib.rs. Antes eran 20s — se acortó porque ahora los
/// buscadores en vivo (ver db_select_cache) leen de esta caché para
/// sentirse instantáneos, así que le conviene quedar más al día.
pub fn arrancar_tarea_sincronizacion(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut intervalo = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            intervalo.tick().await;
            sincronizar_una_vez(&app).await;
        }
    });
}

async fn sincronizar_una_vez(app: &tauri::AppHandle) {
    let estado = app.state::<EstadoBaseDatos>();
    let cache = app.state::<EstadoCache>();

    let Ok(conn_remota) = db::obtener_conexion(&estado).await else {
        return;
    };
    if conn_remota.query("SELECT 1", ()).await.is_err() {
        return;
    }

    if let Err(e) = reproducir_outbox(&conn_remota, &cache).await {
        eprintln!("Sincronización: error reproduciendo la cola pendiente: {e}");
    }
    if let Err(e) = refrescar_cache(&conn_remota, &cache).await {
        eprintln!("Sincronización: error refrescando la caché local: {e}");
    }
}

/// Reproduce la cola en orden (más vieja primero) contra la conexión
/// remota, deteniéndose en el primer error real para no desordenar el
/// resto de la cola.
async fn reproducir_outbox(
    conn_remota: &libsql::Connection,
    cache: &EstadoCache,
) -> Result<(), String> {
    let conn_cache = cache.conectar().await?;

    loop {
        let mut filas = conn_cache
            .query(
                "SELECT id, comando, payload_json, intentos FROM outbox
                 WHERE estado = 'pendiente' ORDER BY creado_at ASC LIMIT 1",
                (),
            )
            .await
            .map_err(|e| e.to_string())?;
        let Some(fila) = filas.next().await.map_err(|e| e.to_string())? else {
            break;
        };
        let id: String = fila.get(0).map_err(|e| e.to_string())?;
        let comando: String = fila.get(1).map_err(|e| e.to_string())?;
        let payload_json: String = fila.get(2).map_err(|e| e.to_string())?;
        let intentos: i64 = fila.get(3).map_err(|e| e.to_string())?;
        drop(fila);
        drop(filas);

        match crate::comandos::ejecutar_desde_cola(conn_remota, &comando, &payload_json).await {
            Ok(()) => {
                conn_cache
                    .execute("DELETE FROM outbox WHERE id = ?1", libsql::params![id])
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Err(e) => {
                conn_cache
                    .execute(
                        "UPDATE outbox SET intentos = ?1, ultimo_error = ?2 WHERE id = ?3",
                        libsql::params![intentos + 1, e.clone(), id.clone()],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                eprintln!("Sincronización: comando {comando} ({id}) falló, se detiene la cola por ahora: {e}");
                break;
            }
        }
    }

    Ok(())
}

/// Refresca las tablas de solo-lectura de la caché local con lo último
/// de Turso — mismo patrón INSERT OR REPLACE que la herramienta de
/// migración de datos usó para la carga inicial.
///
/// Todo el refresco (las 7 tablas, cientos de filas) va en UNA sola
/// transacción — antes cada DELETE/INSERT confirmaba por separado, lo que
/// en un disco lento (una PC vieja, justo el hardware que más nos
/// importa) significa cientos de fsync individuales cada 5 segundos, y
/// eso sí se siente como que la app se traba a ratos. Con una sola
/// transacción es un solo commit para todo el ciclo.
async fn refrescar_cache(conn_remota: &libsql::Connection, cache: &EstadoCache) -> Result<(), String> {
    let conn_cache = cache.conectar().await?;

    // Sin esto, borrar "categorias" antes de haber borrado "productos"
    // (que todavía apunta a la fila vieja) rompe la FK — es solo un
    // espejo de lectura, no hace falta que la caché aplique integridad
    // referencial mientras se refresca.
    conn_cache
        .execute("PRAGMA foreign_keys = OFF", ())
        .await
        .map_err(|e| e.to_string())?;

    let tx = conn_cache.transaction().await.map_err(|e| e.to_string())?;

    for tabla in TABLAS_CACHEADAS {
        tx.execute(&format!("DELETE FROM {tabla}"), ())
            .await
            .map_err(|e| e.to_string())?;

        let mut filas = conn_remota
            .query(&format!("SELECT * FROM {tabla}"), ())
            .await
            .map_err(|e| e.to_string())?;

        let mut insert_sql: Option<String> = None;
        while let Some(fila) = filas.next().await.map_err(|e| e.to_string())? {
            let n = fila.column_count();
            if insert_sql.is_none() {
                let columnas: Vec<String> = (0..n)
                    .map(|i| fila.column_name(i).unwrap_or_default().to_string())
                    .collect();
                let placeholders: Vec<String> = (1..=n).map(|i| format!("?{i}")).collect();
                insert_sql = Some(format!(
                    "INSERT OR REPLACE INTO {tabla} ({}) VALUES ({})",
                    columnas.join(", "),
                    placeholders.join(", ")
                ));
            }
            let valores: Vec<libsql::Value> =
                (0..n).map(|i| fila.get_value(i).unwrap()).collect();
            tx.execute(insert_sql.as_ref().unwrap(), valores)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}
