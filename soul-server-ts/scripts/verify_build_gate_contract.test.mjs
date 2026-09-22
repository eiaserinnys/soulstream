import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

test("release build scripts spawn Windows command shims through a shell", async () => {
  const scriptsRoot = join(packageRoot, "scripts");
  const sources = (await readdir(scriptsRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs")
      && !entry.name.endsWith(".test.mjs"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
  const shimSpawners = [];
  for (const source of sources) {
    const text = await readFile(source, "utf8");
    if (!/["'][^"']*\.(?:cmd|bat)["']/.test(text)) continue;
    shimSpawners.push(source);
    // Node 22 refuses to spawn .cmd/.bat without a shell (EINVAL), which takes the
    // Haniel build hook - and the whole Windows node - down on the next deployment.
    assert.match(text, /shell:/, `${source} spawns a Windows shim without a shell option`);
  }
  assert.deepEqual(
    shimSpawners.map((source) => source.slice(scriptsRoot.length + 1)),
    ["build_with_release_env.mjs"],
  );
});
