import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runReleaseBuild } from "./run_release_build.mjs";

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

function recordReleaseBuild(platform) {
  const calls = [];
  const result = runReleaseBuild({
    platform,
    cwd: "/srv/app",
    env: { SOULSTREAM_RELEASE_ENV_FILE: "/srv/.env.soul-server-ts" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { status: 0 }, "the spawn result has to reach the caller");
  assert.equal(calls.length, 1);
  return calls[0];
}

test("the release build spawns the Windows pnpm shim through a shell", () => {
  // Node 22 refuses to spawn a .cmd shim without a shell: `spawnSync pnpm.cmd
  // EINVAL` failed the Haniel post_pull hook and dropped the Windows node.
  assert.deepEqual(recordReleaseBuild("win32"), {
    command: "pnpm.cmd",
    args: ["run", "build"],
    options: {
      cwd: "/srv/app",
      env: { SOULSTREAM_RELEASE_ENV_FILE: "/srv/.env.soul-server-ts" },
      shell: true,
      stdio: "inherit",
    },
  });
  // POSIX keeps the bare binary and the spawnSync default of no shell.
  assert.deepEqual(recordReleaseBuild("linux"), {
    command: "pnpm",
    args: ["run", "build"],
    options: {
      cwd: "/srv/app",
      env: { SOULSTREAM_RELEASE_ENV_FILE: "/srv/.env.soul-server-ts" },
      shell: false,
      stdio: "inherit",
    },
  });
});
