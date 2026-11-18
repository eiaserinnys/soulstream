import { spawnSync } from "node:child_process";
import { access, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildDist({ packageRoot = defaultPackageRoot, run = runNode } = {}) {
  const dist = join(packageRoot, "dist");
  const next = join(packageRoot, "dist.next");
  const old = join(packageRoot, "dist.old");
  await rm(next, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });

  const env = { ...process.env, SOUL_DIST_DIR: "dist.next" };
  const steps = [
    [join(packageRoot, "node_modules/tsup/dist/cli-default.js"), "--config", "tsup.config.ts", "--target", "node22"],
    [join(packageRoot, "node_modules/tsup/dist/cli-default.js"), "--config", "tsup.runner.config.ts", "--target", "node22"],
    [join(packageRoot, "scripts/write_runner_release_package.mjs")],
    [join(packageRoot, "node_modules/tsx/dist/cli.mjs"), "scripts/write_release_manifest.ts"],
    [join(packageRoot, "scripts/verify_bundle.mjs")],
    [join(packageRoot, "../scripts/verify-bundle-load.mjs"), "dist.next"],
  ];
  for (const args of steps) await run(args, { cwd: packageRoot, env });

  const hasDist = await access(dist).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (hasDist) await renameWithRetry(dist, old);
  await renameWithRetry(next, dist);
  await rm(old, { recursive: true, force: true });
}

function runNode(args, options) {
  const result = spawnSync(process.execPath, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`build step failed (${result.status}): ${args[0]}`);
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if ((error.code !== "EPERM" && error.code !== "EBUSY") || attempt >= 4) throw error;
      await delay(200);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDist();
}
