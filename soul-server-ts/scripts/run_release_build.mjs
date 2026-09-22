import { spawnSync } from "node:child_process";

/**
 * Runs the release build the way the Haniel post_pull hook needs it run.
 *
 * Node 22 refuses to spawn a .cmd/.bat shim without a shell (EINVAL), so the
 * Windows branch has to opt into one - the branch that took the build hook, and
 * with it the whole Windows node, down for seven hours. The spawn is injectable
 * so both platform branches are verifiable from either kind of host.
 */
export function runReleaseBuild({ platform, cwd, env, spawn = spawnSync }) {
  const windows = platform === "win32";
  return spawn(windows ? "pnpm.cmd" : "pnpm", ["run", "build"], {
    cwd,
    env,
    shell: windows,
    stdio: "inherit",
  });
}
