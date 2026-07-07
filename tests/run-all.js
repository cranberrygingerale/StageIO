// Runs every tests/verify_*.js harness in a fresh Node process and summarizes.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.startsWith("verify_") && f.endsWith(".js"))
  .sort();

let failed = [];
for (const f of files) {
  console.log(`\n━━━ ${f} ━━━`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(f);
}

console.log("\n══════════════════════════════════");
if (failed.length === 0) {
  console.log(`ALL ${files.length} SUITES PASSED ✅`);
} else {
  console.log(`${failed.length}/${files.length} SUITES FAILED ❌: ${failed.join(", ")}`);
}
process.exit(failed.length === 0 ? 0 : 1);
