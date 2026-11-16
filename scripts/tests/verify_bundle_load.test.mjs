import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../verify-bundle-load.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/bundle-load/${name}.mjs`, import.meta.url));

test("rejects an ESM bundle that dynamically requires events at load time", () => {
  const result = spawnSync(process.execPath, [checker, fixture("broken")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Dynamic require of "events" is not supported/);
});

test("accepts a bundle that loads successfully", () => {
  const result = spawnSync(process.execPath, [checker, fixture("valid")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("checks chunks in a build directory without running its entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bundle-load-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(join(directory, "main.js"), 'throw new Error("entry executed")');
    await copyFile(fixture("valid"), join(directory, "chunk-valid.js"));
    let result = spawnSync(process.execPath, [checker, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await copyFile(fixture("broken"), join(directory, "chunk-broken.js"));
    result = spawnSync(process.execPath, [checker, directory], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Dynamic require of "events" is not supported/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
