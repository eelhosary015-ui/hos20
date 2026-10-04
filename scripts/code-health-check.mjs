import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'modules', 'scripts'];
const exts = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);
const files = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (exts.has(path.extname(ent.name))) files.push(full);
  }
}
for (const root of roots) if (fs.existsSync(root)) walk(root);
let emptyCatch = 0;
let directInventoryWrites = 0;
for (const file of files) {
  const s = fs.readFileSync(file, 'utf8');
  emptyCatch += (s.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
  directInventoryWrites += (s.match(/(?:UPDATE|INSERT\s+INTO)\s+(?:inventory_items|stock_balances)/gi) || []).length;
}
console.log(JSON.stringify({ files_scanned: files.length, empty_catches: emptyCatch, direct_inventory_writes: directInventoryWrites }, null, 2));
