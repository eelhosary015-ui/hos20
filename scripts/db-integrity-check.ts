import { pool } from '../server-db.js';

/** Read-only Phase 2 database integrity audit. */
async function tableExists(table: string): Promise<boolean> {
  const r = await pool.query('SELECT to_regclass($1) AS regclass', [table]);
  return !!r.rows[0]?.regclass;
}

async function main() {
  const checks: Array<{ name: string; sql: string }> = [
    { name: 'Duplicate inventory keys', sql: `SELECT COUNT(*)::int AS count FROM (SELECT warehouse_id, ingredient_id FROM inventory_items WHERE warehouse_id IS NOT NULL AND ingredient_id IS NOT NULL GROUP BY warehouse_id, ingredient_id HAVING COUNT(*) > 1) d` },
    { name: 'Orders without branch', sql: `SELECT COUNT(*)::int AS count FROM orders WHERE branch_id IS NULL` },
    { name: 'Employees without branch', sql: `SELECT COUNT(*)::int AS count FROM employees WHERE branch_id IS NULL` },
    { name: 'Users without company after branch backfill', sql: `SELECT COUNT(*)::int AS count FROM users WHERE company_id IS NULL AND branch_id IS NOT NULL` },
    { name: 'Customer transaction timestamp drift', sql: `SELECT COUNT(*)::int AS count FROM customer_transactions WHERE timestamp IS NULL OR created_at IS NULL` },
    { name: 'Journal items with both debit and credit', sql: `SELECT COUNT(*)::int AS count FROM journal_items WHERE COALESCE(debit,0) > 0 AND COALESCE(credit,0) > 0` },
    { name: 'Journal items with negative values', sql: `SELECT COUNT(*)::int AS count FROM journal_items WHERE COALESCE(debit,0) < 0 OR COALESCE(credit,0) < 0` },
    { name: 'Negative safe balances', sql: `SELECT COUNT(*)::int AS count FROM safes WHERE balance < 0` },
    { name: 'Negative inventory quantities', sql: `SELECT COUNT(*)::int AS count FROM inventory_items WHERE quantity < 0` },
  ];

  console.log('🔎 Phase 2 database integrity audit');
  for (const check of checks) {
    const table = check.sql.match(/FROM\s+([a-z_]+)/i)?.[1];
    if (table && !(await tableExists(table))) {
      console.log(`⏭️ ${check.name}: table ${table} not installed`);
      continue;
    }
    const r = await pool.query(check.sql);
    const count = Number(r.rows[0]?.count ?? 0);
    console.log(`${count === 0 ? '✅' : '⚠️'} ${check.name}: ${count}`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('❌ Database integrity audit failed:', err?.message || err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
