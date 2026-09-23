import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runReleaseBuild } from "./release-build-child.mjs";

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

test("release build uses an explicit command processor for the Windows pnpm cmd shim", () => {
  const calls = [];
  const envFile = "/service env/.env.soul-server-ts";
  const env = {
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATH: "C:\\tools",
  };

  runReleaseBuild({
    packageRoot: "/repo/soul-server-ts",
    envFile,
    platform: "win32",
    env,
    spawnSyncImpl: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [[
    env.ComSpec,
    ["/d", "/s", "/c", "pnpm.cmd run build"],
    {
      cwd: "/repo/soul-server-ts",
      env: {
        ...env,
        SOULSTREAM_RELEASE_ENV_FILE: resolve(envFile),
      },
      shell: false,
      stdio: "inherit",
    },
  ]]);
});

test("release build keeps direct argv execution on non-Windows platforms", () => {
  const calls = [];
  runReleaseBuild({
    packageRoot: "/repo/soul-server-ts",
    envFile: "/service/.env.soul-server-ts",
    platform: "linux",
    env: { PATH: "/tools" },
    spawnSyncImpl: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(calls[0][0], "pnpm");
  assert.deepEqual(calls[0][1], ["run", "build"]);
  assert.equal(calls[0][2].shell, false);
});

test("release build falls back to cmd.exe when Windows has no ComSpec value", () => {
  const calls = [];
  runReleaseBuild({
    packageRoot: "/repo/soul-server-ts",
    envFile: "/service/.env.soul-server-ts",
    platform: "win32",
    env: { ComSpec: " " },
    spawnSyncImpl: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(calls[0][0], "cmd.exe");
  assert.deepEqual(calls[0][1], ["/d", "/s", "/c", "pnpm.cmd run build"]);
  assert.equal(calls[0][2].shell, false);
});

test("release build enters a real Linux child with env and preserves its exit code", {
  skip: process.platform !== "linux",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "release-build-child-"));
  try {
    const childPackageRoot = join(root, "package root");
    const bin = join(root, "bin");
    const capture = join(root, "capture.txt");
    const envFile = join(root, "service env", ".env.soul-server-ts");
    mkdirSync(childPackageRoot, { recursive: true });
    mkdirSync(bin);
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(envFile, "SOULSTREAM_NODE_ID=test\n");
    const pnpm = join(bin, "pnpm");
    writeFileSync(pnpm, [
      "#!/bin/sh",
      "printf '%s\\n' \"$PWD\" \"$SOULSTREAM_RELEASE_ENV_FILE\" \"$1\" \"$2\" > \"$CAPTURE_FILE\"",
      "exit \"$CHILD_EXIT_CODE\"",
      "",
    ].join("\n"));
    chmodSync(pnpm, 0o755);
    const env = {
      PATH: bin,
      CAPTURE_FILE: capture,
      CHILD_EXIT_CODE: "0",
    };

    runReleaseBuild({ packageRoot: childPackageRoot, envFile, platform: "linux", env });
    assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n"), [
      childPackageRoot,
      resolve(envFile),
      "run",
      "build",
    ]);

    let exitCode;
    assert.throws(() => runReleaseBuild({
      packageRoot: childPackageRoot,
      envFile,
      platform: "linux",
      env: { ...env, CHILD_EXIT_CODE: "17" },
      exitImpl: (code) => {
        exitCode = code;
        throw new Error(`exit ${code}`);
      },
    }), /exit 17/);
    assert.equal(exitCode, 17);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release build propagates child startup errors and exit status", () => {
  const startupError = new Error("spawn failed");
  assert.throws(() => runReleaseBuild({
    packageRoot: "/repo/soul-server-ts",
    envFile: "/service/.env.soul-server-ts",
    platform: "linux",
    env: {},
    spawnSyncImpl: () => ({ error: startupError, status: null }),
  }), startupError);

  let exitCode;
  assert.throws(() => runReleaseBuild({
    packageRoot: "/repo/soul-server-ts",
    envFile: "/service/.env.soul-server-ts",
    platform: "linux",
    env: {},
    spawnSyncImpl: () => ({ status: 23 }),
    exitImpl: (code) => {
      exitCode = code;
      throw new Error(`exit ${code}`);
    },
  }), /exit 23/);
  assert.equal(exitCode, 23);
});
