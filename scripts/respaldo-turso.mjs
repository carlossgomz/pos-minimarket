// Respaldo independiente de la base de datos (Turso). El plan gratis de
// Turso YA incluye point-in-time recovery, pero solo cubre las últimas 24
// horas — y ese respaldo vive DENTRO de la misma cuenta de Turso. Esto es
// una copia aparte, fuera de Turso por completo, para cubrir lo que el PITR
// no cubre: un error que no se nota en menos de un día, o cualquier
// problema con la cuenta de Turso en sí. Se guarda en una carpeta dentro de
// OneDrive (fuera del repo, no se sube a git) para que además quede
// respaldada en la nube de Microsoft sin depender de un solo lugar.
//
// Uso manual:   node scripts/respaldo-turso.mjs
// Programado:   ver scripts/instalar-tarea-respaldo.ps1 (corre esto una vez
//               al día con el Programador de tareas de Windows).
import { createClient } from "@libsql/client";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = "C:/Users/carlo/AppData/Roaming/com.minimarket.pos/sync-config.json";
const DESTINO = "C:/Users/carlo/OneDrive/Documents/WEB DEVELOPER/SISTEMA/respaldos-pos-minimarket";
const DIAS_A_CONSERVAR = 30;

// JSON.stringify no sabe serializar BigInt — el cliente de libsql puede
// devolver algunos valores enteros así. Se convierten a Number (los montos
// y cantidades de este negocio nunca se acercan al límite seguro de un
// Number de JS).
function reemplazarBigInt(_clave, valor) {
  return typeof valor === "bigint" ? Number(valor) : valor;
}

async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const db = createClient({ url: cfg.turso_url, authToken: cfg.turso_auth_token });

  const tablas = await db.execute(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  const respaldo = { generado_en: new Date().toISOString(), tablas: {} };
  let totalFilas = 0;
  for (const tabla of tablas.rows) {
    const nombre = String(tabla.name);
    const filas = await db.execute(`SELECT * FROM "${nombre}"`);
    respaldo.tablas[nombre] = { sql_creacion: tabla.sql, filas: filas.rows };
    totalFilas += filas.rows.length;
  }

  mkdirSync(DESTINO, { recursive: true });
  const marca = new Date().toISOString().replace(/[:.]/g, "-");
  const archivo = path.join(DESTINO, `respaldo-${marca}.json`);
  writeFileSync(archivo, JSON.stringify(respaldo, reemplazarBigInt));

  console.log(
    `Respaldo guardado: ${archivo} (${Object.keys(respaldo.tablas).length} tablas, ${totalFilas} filas)`
  );

  // No conservar respaldos más viejos que DIAS_A_CONSERVAR, para que la
  // carpeta no crezca sin límite.
  const limite = Date.now() - DIAS_A_CONSERVAR * 86_400_000;
  for (const f of readdirSync(DESTINO)) {
    if (!f.startsWith("respaldo-") || !f.endsWith(".json")) continue;
    const ruta = path.join(DESTINO, f);
    if (statSync(ruta).mtimeMs < limite) {
      unlinkSync(ruta);
      console.log(`Respaldo viejo eliminado: ${f}`);
    }
  }
}

main().catch((e) => {
  console.error("Error al respaldar:", e);
  process.exit(1);
});
