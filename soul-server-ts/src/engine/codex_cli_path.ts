import {
  executableCandidatesInDirectory,
  executableCandidatesInPath,
  findSpawnableExecutable,
  inspectExecutablePath,
  joinExecutablePath,
} from "./executable_path.js";

export type CodexCliPathSource =
  | "CODEX_CLI_PATH"
  | "PATH"
  | "WINDOWS_APPDATA_NPM"
  | "WINDOWS_USERPROFILE_NPM"
  | "HOME_NPM_GLOBAL"
  | "HOME_LOCAL_BIN";

export interface CodexCliPathResolution {
  path: string;
  source: CodexCliPathSource;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type PlatformLike = NodeJS.Platform;

/**
 * Resolve the target-node Codex CLI executable used by both SDK exec mode and
 * app-server mode.
 *
 * The TS service often runs under a process manager with a narrower PATH than an
 * interactive shell. Codex is commonly installed in ~/.npm-global/bin on those
 * nodes, so relying on process PATH or the SDK's bundled binary can select the
 * wrong executable. Local and remote session creation converge before this
 * boundary, so executable resolution belongs to target-node startup.
 */
export function resolveCodexCliPath(
  env: EnvLike = process.env,
  platform: PlatformLike = process.platform,
): CodexCliPathResolution | undefined {
  const explicit = nonEmpty(env.CODEX_CLI_PATH);
  if (explicit && inspectExecutablePath(explicit, platform).spawnable) {
    return { path: explicit, source: "CODEX_CLI_PATH" };
  }

  return findSpawnableExecutable(candidateCodexCliPaths(env, platform), platform);
}

function candidateCodexCliPaths(
  env: EnvLike,
  platform: PlatformLike,
): CodexCliPathResolution[] {
  const candidates: CodexCliPathResolution[] = executableCandidatesInPath(
    "codex",
    env,
    platform,
    "PATH",
  );

  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA);
    if (appData) {
      candidates.push(
        ...executableCandidatesInDirectory(
          joinExecutablePath(appData, "npm"),
          "codex",
          "WINDOWS_APPDATA_NPM",
          env.PATHEXT,
          platform,
        ),
      );
    }
    const userProfile = nonEmpty(env.USERPROFILE);
    if (userProfile) {
      candidates.push(
        ...executableCandidatesInDirectory(
          joinExecutablePath(userProfile, "AppData", "Roaming", "npm"),
          "codex",
          "WINDOWS_USERPROFILE_NPM",
          env.PATHEXT,
          platform,
        ),
      );
    }
    return candidates;
  }

  const home = nonEmpty(env.HOME);
  if (home) {
    candidates.push(
      ...executableCandidatesInDirectory(
        joinExecutablePath(home, ".npm-global", "bin"),
        "codex",
        "HOME_NPM_GLOBAL",
        env.PATHEXT,
        platform,
      ),
      ...executableCandidatesInDirectory(
        joinExecutablePath(home, ".local", "bin"),
        "codex",
        "HOME_LOCAL_BIN",
        env.PATHEXT,
        platform,
      ),
    );
  }

  return candidates;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
