fn main() {
    // Los comandos propios de la app (no de un plugin) necesitan permiso
    // explícito en el sistema de ACL de Tauri v2. Esta línea genera el
    // permiso "allow-$comando" automáticamente para cada uno; hay que
    // habilitarlo en capabilities/default.json para que el frontend pueda
    // invocarlo.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "db_select",
                "db_execute",
                "tiene_config_sync",
                "guardar_config_sync",
                "estado_conexion",
                "escanear_factura",
                "confirmar_venta",
                "editar_venta_items",
                "eliminar_venta",
                "ajustar_stock",
                "registrar_abono_cliente",
                "registrar_abono_cliente_total",
                "registrar_pago_proveedor",
                "registrar_consumo_interno",
                "guardar_factura_compra",
                "editar_factura_compra",
                "eliminar_factura_compra",
                "desglosar_producto",
                "db_select_cache",
                "sincronizar_catalogo_delivery",
                "obtener_pedidos_delivery_pendientes",
            ]),
        ),
    )
    .expect("error al generar los permisos de la app");
}
