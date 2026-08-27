import { invoke } from "@tauri-apps/api/core";

// Ya no es un archivo SQLite local — es Turso (libSQL) en modo remoto,
// compartido por todos los dispositivos (ver src-tauri/src/db.rs). Esta
// clase mantiene la MISMA forma externa que tenía el objeto del plugin
// viejo (@tauri-apps/plugin-sql) a propósito, para que ninguna pantalla
// tuviera que cambiar cómo llama a getDb().select()/.execute().
// En SQLite, "$1/$2/$3" NO son parámetros posicionales aunque lo parezcan
// — son parámetros CON NOMBRE (el nombre es el texto "1", "2", "3"), y su
// posición real de bind se asigna según el orden en que aparecen por
// PRIMERA VEZ en el texto del SQL, no según el número escrito. Si una
// consulta tiene "$3" antes que "$1" en el texto (ej. un JOIN con $3
// seguido de un WHERE con $1 y $2, como pasaba en el reporte de
// comisiones de delivery), SQLite los pasa como si $3 fuera el primer
// parámetro — silencioso, sin error, con datos mal calculados. La forma
// segura de verdad es "?1/?2/?3" (numerados de verdad, bind por el número
// literal, sin importar el orden en el texto) — se convierte acá, en el
// único lugar por el que pasan TODAS las consultas del frontend, para no
// tener que revisar cada SQL de cada pantalla a mano ni depender de que
// se escriban siempre en orden ascendente de ahora en más.
function paramsSeguros(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?$1");
}

class BaseDatosRemota {
  select<T>(sql: string, bindValues: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { sql: paramsSeguros(sql), params: bindValues });
  }

  // Lee directo de la caché local (sin ir a buscar a Turso primero) — para
  // buscadores mientras se escribe, donde la latencia hasta el servidor se
  // siente. El dato puede tener hasta unos segundos de atraso; no usar
  // esto para algo que necesite el valor exacto del momento.
  selectRapido<T>(sql: string, bindValues: unknown[] = []): Promise<T> {
    return invoke<T>("db_select_cache", { sql: paramsSeguros(sql), params: bindValues });
  }

  execute(sql: string, bindValues: unknown[] = []): Promise<{ rowsAffected: number; lastInsertId: number }> {
    return invoke("db_execute", { sql: paramsSeguros(sql), params: bindValues });
  }
}

let db: BaseDatosRemota | null = null;

export function getDb(): Promise<BaseDatosRemota> {
  if (!db) {
    db = new BaseDatosRemota();
  }
  return Promise.resolve(db);
}
