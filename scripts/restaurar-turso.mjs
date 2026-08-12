// Restaura un respaldo generado por respaldo-turso.mjs hacia una base de
// datos Turso NUEVA (nunca hacia la base de producción actual — a
// propósito, para no arriesgarse a pisar datos reales por accidente).
//
// Pasos para una restauración real de emergencia:
//   1. turso db create pos-minimarket-restaurado
//   2. turso db tokens create pos-minimarket-restaurado
//   3. node scripts/restaurar-turso.mjs "<ruta al .json>" "<url libsql de la base nueva>" "<token>"
//   4. Revisar que los datos estén correctos, y recién ahí decidir cómo
//      pasarlos a producción (normalmente: apuntar sync-config.json de cada
//      PC a la base nueva, después de confirmar que está completa).
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const [, , rutaRespaldo, urlDestino, tokenDestino] = process.argv;

if (!rutaRespaldo || !urlDestino || !tokenDestino) {
  console.error(
    "Uso: node scripts/restaurar-turso.mjs <ruta-al-respaldo.json> <url-libsql-destino> <token-destino>\n" +
      "La base destino debe ser una base NUEVA y vacía — este script no está pensado para pisar producción."
  );
  process.exit(1);
}

async function main() {
  const respaldo = JSON.parse(readFileSync(rutaRespaldo, "utf8"));
  const db = createClient({ url: urlDestino, authToken: tokenDestino });

  // Chequeo de seguridad: si la base destino YA tiene tablas con datos, se
  // aborta — evita sobreescribir algo que no debería tocarse a mano.
  const existentes = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  );
  if (existentes.rows.length > 0) {
    console.error(
      `La base destino ya tiene ${existentes.rows.length} tabla(s) — este script solo restaura sobre una base nueva y vacía, para no arriesgarse a mezclar o pisar datos. Crea una base Turso nueva y usa esa URL/token.`
    );
    process.exit(1);
  }

  const nombresTablas = Object.keys(respaldo.tablas);
  console.log(`Restaurando ${nombresTablas.length} tablas desde ${rutaRespaldo} (generado ${respaldo.generado_en})...`);

  for (const nombre of nombresTablas) {
    const { sql_creacion, filas } = respaldo.tablas[nombre];
    if (sql_creacion) await db.execute(sql_creacion);
  }

  for (const nombre of nombresTablas) {
    const { filas } = respaldo.tablas[nombre];
    for (const fila of filas) {
      const columnas = Object.keys(fila);
      if (columnas.length === 0) continue;
      const marcadores = columnas.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO "${nombre}" (${columnas.map((c) => `"${c}"`).join(", ")}) VALUES (${marcadores})`;
      await db.execute({ sql, args: columnas.map((c) => fila[c]) });
    }
    console.log(`  ${nombre}: ${filas.length} filas restauradas`);
  }

  console.log("Restauración completa.");
}

main().catch((e) => {
  console.error("Error al restaurar:", e);
  process.exit(1);
});
