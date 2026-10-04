import { pool } from "../server-db.js";
import {
  SCHEMA_CONTRACTS,
  formatSchemaGuardFailures,
  normalizeInventoryAvailability,
  runSchemaGuard,
} from "../modules/system/services/schema-guard.service.js";

/**
 * CLI لتشغيل حارس المخططات يدويًا:
 *   npm run schema:guard          → يفحص ويضيف الأعمدة الناقصة تلقائيًا
 *   npm run schema:guard -- --check → فحص فقط بدون أي تعديل
 */

const checkOnly = process.argv.includes("--check") || process.argv.includes("-c");

async function main() {
  console.log("── Schema Guard ──");
  console.log(`الوضع: ${checkOnly ? "فحص فقط (بدون تعديل)" : "فحص + إصلاح تلقائي"}`);
  console.log(`الجداول المتعاقد عليها: ${SCHEMA_CONTRACTS.length}`);

  const report = await runSchemaGuard({ fix: !checkOnly });

  for (const table of report.tables) {
    const mark = table.present >= table.required ? "✅" : "⚠️ ";
    console.log(`${mark} ${table.table.padEnd(22)} ${table.present}/${table.required} — ${table.purpose}`);
  }

  const fixedAvailability = await normalizeInventoryAvailability();
  if (fixedAvailability > 0) {
    console.log(`\nتم تصحيح ${fixedAvailability} صف في inventory_items.available (quantity - reserved).`);
  }

  console.log(`\nالإجمالي: ${report.totals.ok}/${report.totals.columns} عمود موجود`);
  if (report.totals.added > 0) {
    console.log(`\nتمت إضافة ${report.totals.added} عمود:`);
    for (const column of report.added) {
      console.log(`  + ${column.table}.${column.column} (${column.type})`);
    }
  }
  if (report.totals.missing > 0 || report.totals.missingTables > 0) {
    console.error("\nمشكلات لم يتم حلها:\n");
    console.error(formatSchemaGuardFailures(report));
  }

  console.log(report.ok ? "\nSCHEMA_GUARD_OK" : "\nSCHEMA_GUARD_FAILED");
  await pool.end();
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("Schema guard failed to run:", error);
  process.exit(1);
});
