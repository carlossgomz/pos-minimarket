mod comandos;
mod db;
mod delivery;
mod ia;
mod offline;

use tauri::Manager;

// Punto de entrada de la app. La base de datos ya NO es un archivo local —
// es Turso (libSQL) en modo remoto, compartida por todos los dispositivos
// (ver plan de la sesión). Cada PC guarda su propia URL/token en un
// archivo local (sync-config.json en la carpeta de datos de la app); si
// todavía no existe, el frontend muestra una pantalla de configuración
// antes del login.
//
// Además, cada dispositivo mantiene una caché local (cache.db, ver
// offline.rs) con el mismo esquema, para que la caja pueda seguir
// vendiendo si se corta la conexión — una tarea de fondo la sincroniza
// sola con Turso en cuanto vuelve internet.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // db::inicializar y offline::inicializar corren migraciones
            // (CREATE TABLE, etc.) que en libsql pueden desbordar el stack
            // de 1MB por defecto de un hilo en Windows — pero acá, durante
            // .setup(), todavía no arrancó el runtime async de 64MB que se
            // instaló en main.rs, así que un block_on directo corre sobre
            // el hilo principal (con su stack chico) y sí se desborda,
            // especialmente con cache.db (SQLite local de verdad, no HTTP
            // como Turso remoto). Se corre en un hilo aparte con stack
            // grande, igual que se validó en el spike de la sesión.
            let handle_hilo = handle.clone();
            let (estado, cache) = std::thread::Builder::new()
                .stack_size(64 * 1024 * 1024)
                .spawn(move || {
                    let estado = tauri::async_runtime::block_on(db::inicializar(&handle_hilo));
                    let cache = tauri::async_runtime::block_on(offline::inicializar(&handle_hilo))
                        .expect("no se pudo inicializar la caché local");
                    (estado, cache)
                })
                .expect("no se pudo crear el hilo de inicialización")
                .join()
                .expect("el hilo de inicialización entró en pánico");

            app.manage(estado);
            app.manage(cache);
            app.manage(delivery::EstadoPedidosDelivery::default());

            offline::arrancar_tarea_sincronizacion(handle.clone());
            delivery::arrancar_tareas(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_select,
            db::db_select_cache,
            db::db_execute,
            db::tiene_config_sync,
            db::guardar_config_sync,
            offline::estado_conexion,
            ia::escanear_factura,
            comandos::confirmar_venta,
            comandos::editar_venta_items,
            comandos::ajustar_stock,
            comandos::registrar_abono_cliente,
            comandos::registrar_abono_cliente_total,
            comandos::registrar_pago_proveedor,
            comandos::registrar_consumo_interno,
            comandos::guardar_factura_compra,
            comandos::editar_factura_compra,
            comandos::eliminar_factura_compra,
            comandos::desglosar_producto,
            delivery::sincronizar_catalogo_delivery,
            delivery::obtener_pedidos_delivery_pendientes
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}
