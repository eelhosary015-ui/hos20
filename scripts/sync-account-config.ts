/**
 * Sync `account_config` from the live chart of accounts.
 * -------------------------------------------------------------------------
 * Why
 *   `getAccountConfig()` (modules/accounts/services/auto-posting.service.ts) reads
 *   account_config WHERE account_id IS NOT NULL. The rows seeded by the ERP
 *   accounting migration carry only a description (account_id = NULL), so at runtime
 *   every GL key falls back to scanning `accounts` by code + Arabic name keywords.
 *   This script connects each config key to a real accounts.id so that fallback is
 *   never needed in production.
 *
 * What it does (idempotent, safe to re-run):
 *   1. Ensures the structural core accounts (1150 / 3200 / 3300) exist.
 *   2. Backfills account_id on existing account_config rows (including the legacy
 *      `*_account`-suffixed seed rows) when it is NULL/invalid and the mapped code
 *      exists in the chart of accounts.
 *   3. Inserts canonical normalized keys (cash, bank, sales_revenue, ...) for any
 *      key that has no connected row yet.
 *   4. Prints a summary and exits non-zero if a critical key is still unconnected.
 *
 * Flags
 *   --force     also overwrite rows that are already connected but point to a
 *               different account than the code mapping says (never done by default,
 *               so manual remappings in the UI survive).
 *   --dry-run   run everything in a transaction and roll back at the end.
 *
 * Usage:  npx tsx scripts/sync-account-config.ts [--force] [--dry-run]
 */
import { pool } from "../server-db.js";
import {
  DEFAULT_ACCOUNT_CODES,
  CORE_ACCOUNTS,
} from "../modules/accounts/services/auto-posting.service.js";

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has("--force");
const DRY_RUN = argv.has("--dry-run");

// account_config keys seeded by scripts/erp-accounting-migration.ts that are NOT in
// DEFAULT_ACCOUNT_CODES. Its description is "Default purchases/COGS GL account" -> 5100.
const EXTRA_CONFIG_CODES: Record<string, string> = {
  purchases_expense: "5100",
};

// Keys whose absence silently breaks auto-posting; the script exits non-zero if any
// of these is still unconnected after the sync.
const CRITICAL_KEYS = [
  "cash",
  "bank",
  "accounts_receivable",
  "accounts_payable",
  "inventory_asset",
  "sales_revenue",
  "cost_of_goods_sold",
  "salary_expense",
  "tax_payable",
  "employee_advances",
  "income_summary",
  "retained_earnings",
];

/** Mirrors normalizeKey() in auto-posting.service.ts — keep in sync. */
function normalizeKey(rawKey: string): string {
  return rawKey.replace(/_account$/, "");
}

function isValidAccountId(id: any): boolean {
  return id !== null && id !== undefined && !isNaN(Number(id)) && Number(id) > 0;
}

interface Report {
  createdCore: string[];
  backfilled: number;
  forced: number;
  inserted: number;
  connectedKeys: number;
  unresolved: { key: string; code: string }[];
  missingCritical: string[];
}

/** Sentinel used to roll a --dry-run back while still returning the report. */
class DryRunRollback extends Error {
  constructor(public report: Report) {
    super("dry-run");
  }
}

async function runSync(client: any): Promise<Report> {
  const q = (sql: string, params?: any[]) => client.query(sql, params);

  // ── 1. Structural accounts the GL engine needs but the setup wizard does not seed
  const createdCore: string[] = [];
  for (const acc of CORE_ACCOUNTS) {
    const existing = (await q("SELECT id FROM accounts WHERE code = $1 LIMIT 1", [acc.code])).rows[0];
    if (existing) continue;
    const parent = (await q("SELECT id FROM accounts WHERE code = $1 LIMIT 1", [acc.parentCode])).rows[0];
    await q(
      `INSERT INTO accounts (code, name, type, parent_id, balance, name_ar, name_en, account_type, account_nature, level, is_leaf, allow_posting, status, is_active, currency)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, 2, true, true, true, true, 'EGP')
       ON CONFLICT (code) DO NOTHING`,
      [acc.code, acc.name, acc.type, parent?.id ?? null, acc.name, acc.name_en, acc.account_type, acc.nature]
    );
    createdCore.push(`${acc.code} (${acc.configKey})`);
  }

  // ── 2. Desired normalized key -> live account code
  const desiredCodes: Record<string, string> = {};
  for (const [rawKey, code] of Object.entries(DEFAULT_ACCOUNT_CODES)) {
    desiredCodes[normalizeKey(rawKey)] = code;
  }
  for (const [key, code] of Object.entries(EXTRA_CONFIG_CODES)) {
    desiredCodes[normalizeKey(key)] = code;
  }

  // ── 3. Resolve codes -> accounts.id
  const accounts = (await q("SELECT id, code FROM accounts")).rows || [];
  const codeToId: Record<string, number> = {};
  for (const a of accounts) codeToId[String(a.code)] = Number(a.id);

  const keyToAccountId: Record<string, number> = {};
  const unresolved: { key: string; code: string }[] = [];
  for (const [key, code] of Object.entries(desiredCodes)) {
    const id = codeToId[code];
    if (isValidAccountId(id)) keyToAccountId[key] = id;
    else unresolved.push({ key, code });
  }

  // ── 4. Backfill existing rows (incl. legacy *_account seed rows)
  const rows = (await q("SELECT key, account_id FROM account_config")).rows || [];
  let backfilled = 0;
  let forced = 0;
  const connectedKeys = new Set<string>();

  for (const row of rows) {
    const nk = normalizeKey(String(row.key));
    const target = keyToAccountId[nk];

    if (!isValidAccountId(row.account_id)) {
      if (!target) continue; // no live account for this code — reported via `unresolved`
      await q("UPDATE account_config SET account_id = $2, updated_at = NOW() WHERE key = $1", [row.key, target]);
      backfilled++;
      connectedKeys.add(nk);
      console.log(`  [link]   ${row.key} -> account #${target} (code ${desiredCodes[nk]})`);
    } else if (target && Number(row.account_id) !== target && FORCE) {
      await q("UPDATE account_config SET account_id = $2, updated_at = NOW() WHERE key = $1", [row.key, target]);
      forced++;
      connectedKeys.add(nk);
      console.log(`  [force]  ${row.key}: #${row.account_id} -> #${target} (code ${desiredCodes[nk]})`);
    } else if (target) {
      connectedKeys.add(nk);
    }
  }

  // ── 5. Insert canonical keys that have no connected row yet
  let inserted = 0;
  for (const [key, accountId] of Object.entries(keyToAccountId)) {
    if (connectedKeys.has(key)) continue;
    await q(
      `INSERT INTO account_config (key, account_id, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = NOW()`,
      [key, accountId]
    );
    inserted++;
    console.log(`  [insert] ${key} -> account #${accountId} (code ${desiredCodes[key]})`);
  }

  // ── 6. Verify: which known keys are still unconnected?
  const finalRows = (await q("SELECT key, account_id FROM account_config WHERE account_id IS NOT NULL")).rows || [];
  const finalKeys = new Set<string>(finalRows.map((r: any) => normalizeKey(String(r.key))));
  const missingCritical = CRITICAL_KEYS.filter(k => !finalKeys.has(k));

  return {
    createdCore,
    backfilled,
    forced,
    inserted,
    connectedKeys: finalKeys.size,
    unresolved,
    missingCritical,
  };
}

function printReport(report: Report): void {
  console.log("");
  console.log("── account_config sync summary ──────────────────────────────");
  if (report.createdCore.length) console.log(`  core accounts created : ${report.createdCore.join(", ")}`);
  console.log(`  rows backfilled       : ${report.backfilled}`);
  console.log(
    `  rows overwritten      : ${report.forced}${FORCE ? "" : "   (use --force to rewrite connected-but-different rows)"}`
  );
  console.log(`  canonical keys added  : ${report.inserted}`);
  console.log(`  connected config keys : ${report.connectedKeys}`);
  if (report.unresolved.length) {
    console.log(`  UNRESOLVED (${report.unresolved.length}) — no account with these codes exists:`);
    for (const u of report.unresolved) console.log(`      - ${u.key} (code ${u.code})`);
  }
  if (report.missingCritical.length) {
    console.log(`  CRITICAL keys still unconnected: ${report.missingCritical.join(", ")}`);
    console.log("  -> getAccountConfig() would still run its code/name fallback scan for these.");
  } else {
    console.log("  all critical keys connected ✓ — getAccountConfig() needs no fallback scan.");
  }
}

async function main() {
  let report: Report;
  let rolledBack = false;

  try {
    report = await pool.transaction(async client => {
      const r = await runSync(client);
      if (DRY_RUN) throw new DryRunRollback(r);
      return r;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) {
      report = error.report;
      rolledBack = true;
    } else {
      throw error;
    }
  }

  printReport(report!);
  if (rolledBack) {
    console.log("\nDRY-RUN: transaction rolled back, nothing committed.");
    console.log("(In offline-fallback mode there is no real transaction; re-run without --dry-run only if that is intended.)");
  } else {
    console.log("\nCommitted.");
  }

  return report!.missingCritical.length;
}

main()
  .then(async missing => {
    await pool.end();
    process.exit(missing > 0 ? 1 : 0);
  })
  .catch(async error => {
    console.error("[sync-account-config] FAILED:", error?.message || error);
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  });
