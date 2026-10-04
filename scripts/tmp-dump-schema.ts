import { pool } from "../server-db.js";

const TABLES = [
  "order_items", "categories", "products", "branches", "customers", "suppliers",
  "settings", "users", "attendance", "payroll", "accounts", "account_config",
  "journal_entries", "journal_items", "treasury_accounts", "hr_annual_increases",
];

async function main() {
  const res = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [TABLES]
  );
  const byTable = new Map<string, string[]>();
  for (const row of res.rows) {
    const list = byTable.get(row.table_name) || [];
    list.push(row.column_name);
    byTable.set(row.table_name, list);
  }
  for (const table of TABLES) {
    const cols = byTable.get(table);
    console.log(`\n── ${table} (${cols ? cols.length : 0}) ──`);
    console.log(cols ? cols.join(", ") : "!! TABLE MISSING");
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
