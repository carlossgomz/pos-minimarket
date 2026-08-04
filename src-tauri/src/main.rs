// Ventana sin consola en Windows cuando es build de producción.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // libsql (la base remota, Turso) desborda el stack de 1MB por defecto
    // de un hilo en Windows al parsear SQL — confirmado con una prueba real
    // contra la base de producción antes de escribir el resto de esta
    // migración. La mitigación es correr todo el trabajo async en hilos
    // con un stack grande: acá se instala un runtime de tokio propio (con
    // ese stack grande en todos sus hilos) como el runtime que usa Tauri
    // para todos los comandos async, así ningún comando individual tiene
    // que preocuparse por esto.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(64 * 1024 * 1024)
        .build()
        .expect("no se pudo crear el runtime de tokio");

    tauri::async_runtime::set(runtime.handle().clone());

    // El runtime debe seguir vivo mientras corre la app — si se soltara acá
    // (fin del scope), tokio lo apagaría. std::mem::forget lo mantiene
    // vivo hasta que el proceso termine, que es exactamente cuánto dura la
    // app de todas formas.
    std::mem::forget(runtime);

    pos_minimarket_lib::run();
}
