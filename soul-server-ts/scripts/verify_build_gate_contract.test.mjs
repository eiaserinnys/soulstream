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

// Node 22 refuses to spawn .cmd/.bat shims without a shell (EINVAL), which took the
// Haniel post_pull build hook - and with it the whole Windows node - down for hours.
// The hook runs this gate, so the invariant is checked where the shim is spawned.
// File scoped on purpose: a release script spawns one toolchain, not a mix.
const WINDOWS_SHIM_LITERAL = /\.(?:cmd|bat)(?=["'`])/i;
const PROCESS_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/;
const WIN32_SHELL_OPTION = /shell:\s*(?:true|process\.platform\s*===\s*["']win32["'])/;

test("release build scripts spawn Windows command shims through a shell", async () => {
  const scriptsRoot = join(packageRoot, "scripts");
  const entries = await readdir(scriptsRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(?:mjs|ts)$/.test(entry.name) || /\.test\.(?:mjs|ts)$/.test(entry.name)) continue;
    const source = join(entry.parentPath ?? entry.path, entry.name);
    const text = await readFile(source, "utf8");
    if (!WINDOWS_SHIM_LITERAL.test(text) || !PROCESS_SPAWN.test(text)) continue;
    assert.match(
      text,
      WIN32_SHELL_OPTION,
      `${source.slice(scriptsRoot.length + 1)} spawns a Windows .cmd/.bat shim `
        + "without enabling the shell on win32",
    );
  }
});
