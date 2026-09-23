import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function runReleaseBuild({
  packageRoot,
  envFile,
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
  exitImpl = process.exit,
}) {
  const invocation = buildInvocation(platform, env);
  const result = spawnSyncImpl(invocation.command, invocation.args, {
    cwd: packageRoot,
    env: {
      ...env,
      SOULSTREAM_RELEASE_ENV_FILE: resolve(envFile),
    },
    shell: false,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) exitImpl(result.status ?? 1);
  return result;
}

function buildInvocation(platform, env) {
  if (platform !== "win32") {
    return { command: "pnpm", args: ["run", "build"] };
  }
  const commandProcessor = env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe";
  return {
    command: commandProcessor,
    // Fixed command only: no paths or caller-provided arguments enter cmd parsing.
    args: ["/d", "/s", "/c", "pnpm.cmd run build"],
  };
}
