import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, process.env.SOUL_DIST_DIR ?? "dist");
const steps = [
  ["--test", "--test-timeout=60000", "../scripts/verify-workspace-bundle.test.mjs", "scripts/verify_build_gate_contract.test.mjs"],
  ["../scripts/verify-workspace-bundle.mjs", distRoot],
  ["scripts/verify_runner_release_isolation.mjs"],
];
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { cwd: packageRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bundle verification failed (${result.status}): ${args[0]}`);
}
