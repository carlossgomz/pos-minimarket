import { invoke } from "@tauri-apps/api/core";

// Ya no es un archivo SQLite local — es Turso (libSQL) en modo remoto,
// compartido por todos los dispositivos (ver src-tauri/src/db.rs). Esta
// clase mantiene la MISMA forma externa que tenía el objeto del plugin
// viejo (@tauri-apps/plugin-sql) a propósito, para que ninguna pantalla
// tuviera que cambiar cómo llama a getDb().select()/.execute().
class BaseDatosRemota {
  select<T>(sql: string, bindValues: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { sql, params: bindValues });
  }

  execute(sql: string, bindValues: unknown[] = []): Promise<{ rowsAffected: number; lastInsertId: number }> {
    return invoke("db_execute", { sql, params: bindValues });
  }
}

let db: BaseDatosRemota | null = null;

export function getDb(): Promise<BaseDatosRemota> {
  if (!db) {
    db = new BaseDatosRemota();
  }
  return Promise.resolve(db);
}
