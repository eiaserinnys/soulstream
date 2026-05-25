import { accessSync, constants, statSync } from "node:fs";
import { delimiter } from "node:path";

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

const WINDOWS_SPAWNABLE_EXTENSIONS = [".cmd", ".exe", ".bat", ".com"] as const;

/**
 * Resolve the target-node Codex CLI executable used by both SDK exec mode and
 * app-server mode.
 *
 * The TS service often runs under a supervisor with a narrower PATH than an
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
  if (explicit) {
    return { path: explicit, source: "CODEX_CLI_PATH" };
  }

  for (const candidate of candidateCodexCliPaths(env, platform)) {
    if (isSpawnable(candidate.path, platform)) {
      return candidate;
    }
  }

  return undefined;
}

function candidateCodexCliPaths(
  env: EnvLike,
  platform: PlatformLike,
): CodexCliPathResolution[] {
  const candidates: CodexCliPathResolution[] = [];
  const pathValue = getPathValue(env, platform);
  if (pathValue) {
    for (const dir of pathValue.split(pathDelimiter(platform))) {
      if (!dir) continue;
      if (platform === "win32") {
        candidates.push(...windowsCodexCandidates(dir, "PATH"));
      } else {
        candidates.push({ path: joinPath(dir, "codex"), source: "PATH" });
      }
    }
  }

  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA);
    if (appData) {
      candidates.push(
        ...windowsCodexCandidates(
          joinPath(appData, "npm"),
          "WINDOWS_APPDATA_NPM",
        ),
      );
    }
    const userProfile = nonEmpty(env.USERPROFILE);
    if (userProfile) {
      candidates.push(
        ...windowsCodexCandidates(
          joinPath(userProfile, "AppData", "Roaming", "npm"),
          "WINDOWS_USERPROFILE_NPM",
        ),
      );
    }
    return candidates;
  }

  const home = nonEmpty(env.HOME);
  if (home) {
    candidates.push(
      {
        path: joinPath(home, ".npm-global", "bin", "codex"),
        source: "HOME_NPM_GLOBAL",
      },
      {
        path: joinPath(home, ".local", "bin", "codex"),
        source: "HOME_LOCAL_BIN",
      },
    );
  }

  return candidates;
}

function windowsCodexCandidates(
  dir: string,
  source: CodexCliPathSource,
): CodexCliPathResolution[] {
  return WINDOWS_SPAWNABLE_EXTENSIONS.map((extension) => ({
    path: joinPath(dir, `codex${extension}`),
    source,
  }));
}

function isSpawnable(path: string, platform: PlatformLike): boolean {
  if (platform === "win32") {
    try {
      const stat = statSync(path);
      return stat.isFile() && hasWindowsSpawnableExtension(path);
    } catch {
      return false;
    }
  }

  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasWindowsSpawnableExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return WINDOWS_SPAWNABLE_EXTENSIONS.some((extension) =>
    lower.endsWith(extension),
  );
}

function pathDelimiter(platform: PlatformLike): string {
  return platform === "win32" ? ";" : delimiter;
}

function getPathValue(
  env: EnvLike,
  platform: PlatformLike,
): string | undefined {
  return (
    nonEmpty(env.PATH) ??
    (platform === "win32" ? nonEmpty(env.Path) : undefined)
  );
}

function joinPath(base: string, ...segments: string[]): string {
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const separator = usesBackslashPath(trimmedBase) ? "\\" : "/";
  return [trimmedBase, ...segments].join(separator);
}

function usesBackslashPath(path: string): boolean {
  return path.includes("\\") || /^[a-zA-Z]:/.test(path);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
