import { pool } from "../server-db.js";

async function applyFixes() {
  console.log("🚀 Starting database fixes from QA Report...");

  try {
    // 1. Fix customers table: add email column
    console.log("Applying Fix 1: Adding 'email' column to customers table...");
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
    console.log("✅ Fix 1 applied: customers.email added");

    // 2. Fix inventory_transactions: extend reference_no, reference_type, and notes to prevent length overflow
    console.log("Applying Fix 2: Extending columns in inventory_transactions and inventory_movements...");
    await pool.query(`
      ALTER TABLE inventory_transactions ALTER COLUMN reference_no TYPE VARCHAR(500);
      ALTER TABLE inventory_transactions ALTER COLUMN reference_type TYPE VARCHAR(255);
      ALTER TABLE inventory_transactions ALTER COLUMN notes TYPE TEXT;
      ALTER TABLE inventory_movements ALTER COLUMN notes TYPE TEXT;
    `);
    console.log("✅ Fix 2 applied: reference_no, reference_type, and notes widened");

    // 3. Fix integer overflow on ref_id: widen to BIGINT
    console.log("Applying Fix 3: Altering ref_id / reference_id columns to BIGINT in inventory tables...");
    await pool.query(`
      ALTER TABLE inventory_movements ALTER COLUMN ref_id TYPE BIGINT;
      ALTER TABLE inventory_transactions ALTER COLUMN reference_id TYPE BIGINT;
      ALTER TABLE inventory_stock_ledger ALTER COLUMN ref_id TYPE BIGINT;
    `);
    console.log("✅ Fix 3 applied: ref_id columns converted to BIGINT");

    // 4. Fix negative stock values:
    // Update negative stock quantities in inventory_items across all warehouses
    console.log("Applying Fix 4: Reconciling negative stock quantities in inventory_items...");
    await pool.query(`
      UPDATE inventory_items 
      SET quantity = 0, available = 0 
      WHERE quantity < 0 OR available < 0;
    `);
    console.log("✅ Fix 4 applied: All negative stock quantities set to zero");

    console.log("🎉 All Database fixes successfully executed!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error applying DB fixes:", err);
    process.exit(1);
  }
}

applyFixes();
