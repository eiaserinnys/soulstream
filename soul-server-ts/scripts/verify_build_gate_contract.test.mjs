import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

test("verify:bundle keeps the build gate free of the main server startup contract", () => {
  assert.equal(
    packageJson.scripts["verify:bundle"],
    "node --test ../scripts/verify-workspace-bundle.test.mjs "
      + "scripts/verify_build_gate_contract.test.mjs "
      + "&& node ../scripts/verify-workspace-bundle.mjs dist "
      + "&& node scripts/verify_runner_release_isolation.mjs",
  );
  assert.doesNotMatch(
    packageJson.scripts["verify:bundle"],
    /verify_main_bundle_runner_startup\.test\.mjs/,
  );
});

test("the main bundle startup contract remains an explicit opt-in verifier", () => {
  assert.equal(
    packageJson.scripts["verify:startup"],
    "node --test scripts/verify_main_bundle_runner_startup.test.mjs",
  );
});
