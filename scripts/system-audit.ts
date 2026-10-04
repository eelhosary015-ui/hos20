import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const extensions = new Set([".ts", ".tsx", ".js", ".cjs"]);
const ignored = new Set(["node_modules", "dist", ".git", "android/build", "backups"]);
const findings: Array<{ level: string; file: string; line: number; message: string }> = [];

function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (extensions.has(path.extname(entry.name))) scan(full);
  }
}
function scan(file: string) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/MAX\s*\(\s*id\s*\)\s*\+\s*1/i.test(line)) findings.push({level:"HIGH", file:path.relative(root,file), line:i+1, message:"MAX(id)+1 sequence pattern"});
    if (/callback\(null,\s*true\)/.test(line)) findings.push({level:"MEDIUM", file:path.relative(root,file), line:i+1, message:"Unrestricted callback(null,true)"});
    if (/unsafe-eval/.test(line) && /production/i.test(lines.slice(Math.max(0,i-3), i+1).join(" "))) findings.push({level:"HIGH", file:path.relative(root,file), line:i+1, message:"unsafe-eval near production security configuration"});
  });
}
walk(root);
console.log(`System audit: ${findings.length} finding(s)`);
for (const f of findings) console.log(`[${f.level}] ${f.file}:${f.line} ${f.message}`);
if (findings.some(f => f.level === "HIGH")) process.exitCode = 2;
