import * as XLSX from "xlsx";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export type HojaExcel = {
  // Nombre de la pestaña — Excel no acepta más de 31 caracteres, se recorta solo.
  nombre: string;
  columnas: string[];
  filas: (string | number)[][];
};

// Arma un .xlsx real (varias hojas, columnas y números bien tipados) y deja
// que el usuario elija dónde guardarlo con el diálogo nativo de Windows —
// no se guarda solo en Descargas ni en ningún lado fijo.
export async function exportarExcel(nombreSugerido: string, hojas: HojaExcel[]): Promise<boolean> {
  const libro = XLSX.utils.book_new();
  for (const hoja of hojas) {
    const datos: (string | number)[][] = [hoja.columnas, ...hoja.filas];
    const worksheet = XLSX.utils.aoa_to_sheet(datos);
    XLSX.utils.book_append_sheet(libro, worksheet, hoja.nombre.slice(0, 31));
  }
  const buffer = XLSX.write(libro, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const ruta = await save({
    defaultPath: nombreSugerido,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!ruta) return false; // el usuario cerró el diálogo sin elegir dónde guardar
  await invoke("guardar_archivo", { ruta, contenido: Array.from(new Uint8Array(buffer)) });
  return true;
}
