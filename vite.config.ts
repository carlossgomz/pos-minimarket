import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ajustes recomendados por Tauri: puerto fijo, no limpiar la consola de
// Rust, e ignorar la carpeta src-tauri para que Vite no recargue por los
// archivos que Rust va generando al compilar.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
