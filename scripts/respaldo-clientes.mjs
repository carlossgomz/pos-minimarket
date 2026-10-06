// Respaldo diario de las bases Turso de los CLIENTES de Kaxa (As de Oro y
// cualquiera que se registre después en licencias-panel) — mismo formato
// que respaldo-turso.mjs, así que restaurar-turso.mjs sirve igual para
// restaurar cualquiera de estos archivos.
//
// La lista de bases sale del registro privado de licencias
// (%USERPROFILE%\.pos-licencias\clientes.db), que es un archivo local —
// leerlo no gasta cupo de Turso. Así un cliente nuevo queda respaldado
// solo, sin tocar este script. Day Express se salta porque ya tiene su
// propio respaldo (respaldo-turso.mjs).
//
// Costo en Turso: cada respaldo lee TODAS las filas de cada base una vez
// al día. Con bases chicas (miles de filas) es despreciable frente al
// límite de 500M filas leídas por mes, pero si algún cliente crece mucho
// conviene revisar `ver-uso-turso.bat`.
//
// Uso manual:   node scripts/respaldo-clientes.mjs
// Programado:   ver scripts/instalar-tarea-respaldo-clientes.ps1
import { createClient } from "@libsql/client";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

const REGISTRO_CLIENTES = "file:C:/Users/carlo/.pos-licencias/clientes.db";
const CONFIG_DAY_EXPRESS = "C:/Users/carlo/AppData/Roaming/com.minimarket.pos/sync-config.json";
const DESTINO = "C:/Users/carlo/OneDrive/Documents/WEB DEVELOPER/SISTEMA/respaldos-clientes";
const DIAS_A_CONSERVAR = 30;

function reemplazarBigInt(_clave, valor) {
  return typeof valor === "bigint" ? Number(valor) : valor;
}

// "libsql://as-de-oro-infocarloscode-cmd.aws-eu-west-1.turso.io" -> "as-de-oro-infocarloscode-cmd"
function carpetaDesdeUrl(url) {
  return url.replace(/^libsql:\/\//, "").split(".")[0].replace(/[^a-zA-Z0-9-]/g, "_");
}

function urlDayExpress() {
  try {
    return JSON.parse(readFileSync(CONFIG_DAY_EXPRESS, "utf8")).turso_url;
  } catch {
    return null;
  }
}

async function respaldarBase(url, token, negocios) {
  const db = createClient({ url, authToken: token });
  try {
    const tablas = await db.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const respaldo = { generado_en: new Date().toISOString(), negocio: negocios, tablas: {} };
    let totalFilas = 0;
    for (const tabla of tablas.rows) {
      const nombre = String(tabla.name);
      const filas = await db.execute(`SELECT * FROM "${nombre}"`);
      respaldo.tablas[nombre] = { sql_creacion: tabla.sql, filas: filas.rows };
      totalFilas += filas.rows.length;
    }

    const carpeta = path.join(DESTINO, carpetaDesdeUrl(url));
    mkdirSync(carpeta, { recursive: true });
    const marca = new Date().toISOString().replace(/[:.]/g, "-");
    const archivo = path.join(carpeta, `respaldo-${marca}.json`);
    writeFileSync(archivo, JSON.stringify(respaldo, reemplazarBigInt));
    console.log(`OK ${negocios}: ${archivo} (${Object.keys(respaldo.tablas).length} tablas, ${totalFilas} filas)`);

    const limite = Date.now() - DIAS_A_CONSERVAR * 86_400_000;
    for (const f of readdirSync(carpeta)) {
      if (!f.startsWith("respaldo-") || !f.endsWith(".json")) continue;
      const ruta = path.join(carpeta, f);
      if (statSync(ruta).mtimeMs < limite) unlinkSync(ruta);
    }
  } finally {
    db.close();
  }
}

async function main() {
  const registro = createClient({ url: REGISTRO_CLIENTES });
  const r = await registro.execute(
    "SELECT negocio, turso_url, turso_token FROM clientes WHERE turso_url IS NOT NULL AND turso_url <> '' AND turso_token IS NOT NULL AND turso_token <> '' ORDER BY fecha DESC"
  );
  registro.close();

  // Una misma base puede aparecer varias veces (ej. As de Oro con licencia
  // de Medio y de Lite) — se respalda una sola vez, con el token más nuevo.
  const omitir = urlDayExpress();
  const bases = new Map();
  for (const f of r.rows) {
    const url = String(f.turso_url);
    if (url === omitir) continue;
    if (!bases.has(url)) bases.set(url, { token: String(f.turso_token), negocios: new Set() });
    bases.get(url).negocios.add(String(f.negocio));
  }

  // Un cliente que falla (token vencido, sin internet) no frena a los
  // demás — pero el proceso sale con error para que la tarea programada
  // lo marque como fallida.
  let fallos = 0;
  for (const [url, { token, negocios }] of bases) {
    const nombre = [...negocios].join(" / ");
    try {
      await respaldarBase(url, token, nombre);
    } catch (e) {
      fallos++;
      console.error(`ERROR ${nombre} (${url}):`, e?.message ?? e);
    }
  }
  if (bases.size === 0) console.log("No hay bases de clientes para respaldar.");
  if (fallos > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Error al respaldar clientes:", e);
  process.exit(1);
});
