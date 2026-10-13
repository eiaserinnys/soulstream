import {
  executableCandidatesInDirectory, executableCandidatesInPath,
  findSpawnableExecutable, inspectExecutablePath, joinExecutablePath,
} from "./executable_path.js";

export interface AntigravityCliPathResolution {
  path: string;
  source: "AGY_CLI_PATH" | "PATH" | "HOME_LOCAL_BIN";
}

/** Inspect files only; optional on nodes that do not run Antigravity. */
export function resolveAntigravityCliPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): AntigravityCliPathResolution | undefined {
  const explicit = env.AGY_CLI_PATH?.trim();
  if (explicit && inspectExecutablePath(explicit, platform).spawnable) {
    return { path: explicit, source: "AGY_CLI_PATH" };
  }
  const candidates: AntigravityCliPathResolution[] = executableCandidatesInPath("agy", env, platform, "PATH");
  if (env.HOME) candidates.push(...executableCandidatesInDirectory(
    joinExecutablePath(env.HOME, ".local", "bin"), "agy", "HOME_LOCAL_BIN", env.PATHEXT, platform,
  ));
  return findSpawnableExecutable(candidates, platform);
}
