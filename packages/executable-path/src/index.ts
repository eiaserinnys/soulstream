import { accessSync, constants, statSync } from "node:fs";
import { delimiter } from "node:path";

export interface ExecutablePathCandidate<TSource extends string = string> {
  path: string;
  source: TSource;
}

export type ExecutablePathStatus =
  | { spawnable: true }
  | { spawnable: false; reason: string };

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function executableCandidatesInPath<TSource extends string>(
  name: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform: NodeJS.Platform,
  source: TSource,
): ExecutablePathCandidate<TSource>[] {
  const value = pathValue(env, platform);
  if (!value) return [];
  return value.split(platform === "win32" ? ";" : delimiter)
    .map(trimPathEntry)
    .filter(Boolean)
    .flatMap((directory) => executableCandidatesInDirectory(
      directory,
      name,
      source,
      env.PATHEXT,
      platform,
    ));
}

export function executableCandidatesInDirectory<TSource extends string>(
  directory: string,
  name: string,
  source: TSource,
  pathExt: string | undefined,
  platform: NodeJS.Platform,
): ExecutablePathCandidate<TSource>[] {
  return executableNames(name, pathExt, platform).map((filename) => ({
    path: joinExecutablePath(directory, filename),
    source,
  }));
}

export function joinExecutablePath(base: string, ...segments: string[]): string {
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const separator = trimmedBase.includes("\\") || /^[a-zA-Z]:/.test(trimmedBase)
    ? "\\"
    : "/";
  return [trimmedBase, ...segments].join(separator);
}

export function inspectExecutablePath(
  path: string,
  platform: NodeJS.Platform,
): ExecutablePathStatus {
  try {
    if (!statSync(path).isFile()) {
      return { spawnable: false, reason: "path is not a regular file" };
    }
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return { spawnable: true };
  } catch (error) {
    return {
      spawnable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function findSpawnableExecutable<T extends { path: string }>(
  candidates: readonly T[],
  platform: NodeJS.Platform,
): T | undefined {
  return candidates.find((candidate) =>
    inspectExecutablePath(candidate.path, platform).spawnable);
}

export type CodexCliPathSource =
  | "CODEX_CLI_PATH"
  | "PATH"
  | "WINDOWS_APPDATA_NPM"
  | "WINDOWS_USERPROFILE_NPM"
  | "HOME_NPM_GLOBAL"
  | "HOME_LOCAL_BIN"
  | "HOMEBREW_ARM64_BIN"
  | "HOMEBREW_INTEL_BIN";

export interface CodexCliPathResolution {
  path: string;
  source: CodexCliPathSource;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type PlatformLike = NodeJS.Platform;

export function resolveCodexCliPath(
  configuredPath: string | null | undefined,
  env: EnvLike,
  platform: PlatformLike = process.platform,
): CodexCliPathResolution | undefined {
  const explicit = nonEmpty(configuredPath);
  if (explicit && inspectExecutablePath(explicit, platform).spawnable) {
    return { path: explicit, source: "CODEX_CLI_PATH" };
  }

  return findSpawnableExecutable(candidateCodexCliPaths(env, platform), platform);
}

export type AntigravityCliPathSource =
  | "AGY_CLI_PATH"
  | "PATH"
  | "HOME_LOCAL_BIN"
  | "HOME_NPM_GLOBAL"
  | "HOMEBREW_ARM64_BIN"
  | "HOMEBREW_INTEL_BIN";

export interface AntigravityCliPathResolution {
  path: string;
  source: AntigravityCliPathSource;
}

/** Inspect files only; optional on nodes that do not run Antigravity. */
export function resolveAntigravityCliPath(
  configuredPath: string | null | undefined,
  env: EnvLike,
  platform: PlatformLike = process.platform,
): AntigravityCliPathResolution | undefined {
  const explicit = nonEmpty(configuredPath ?? env.AGY_CLI_PATH);
  if (explicit && inspectExecutablePath(explicit, platform).spawnable) {
    return { path: explicit, source: "AGY_CLI_PATH" };
  }
  const candidates: AntigravityCliPathResolution[] = executableCandidatesInPath("agy", env, platform, "PATH");
  const home = nonEmpty(env.HOME);
  if (home) {
    candidates.push(...executableCandidatesInDirectory(
      joinExecutablePath(home, ".local", "bin"), "agy", "HOME_LOCAL_BIN", env.PATHEXT, platform,
    ));
  }
  if (platform === "darwin") {
    if (home) {
      candidates.push(...executableCandidatesInDirectory(
        joinExecutablePath(home, ".npm-global", "bin"), "agy", "HOME_NPM_GLOBAL", env.PATHEXT, platform,
      ));
    }
    candidates.push(
      ...executableCandidatesInDirectory("/opt/homebrew/bin", "agy", "HOMEBREW_ARM64_BIN", env.PATHEXT, platform),
      ...executableCandidatesInDirectory("/usr/local/bin", "agy", "HOMEBREW_INTEL_BIN", env.PATHEXT, platform),
    );
  }
  return findSpawnableExecutable(candidates, platform);
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
  if (platform === "darwin") {
    candidates.push(
      ...executableCandidatesInDirectory(
        "/opt/homebrew/bin",
        "codex",
        "HOMEBREW_ARM64_BIN",
        env.PATHEXT,
        platform,
      ),
      ...executableCandidatesInDirectory(
        "/usr/local/bin",
        "codex",
        "HOMEBREW_INTEL_BIN",
        env.PATHEXT,
        platform,
      ),
    );
  }

  return candidates;
}

function executableNames(
  name: string,
  pathExt: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [name];
  const extensions = (nonEmpty(pathExt) ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [...new Set(extensions.map((extension) => extension.toLowerCase()))]
    .map((extension) => `${name}${extension}`);
}

function pathValue(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | undefined {
  return nonEmpty(env.PATH)
    ?? (platform === "win32" ? nonEmpty(env.Path) ?? nonEmpty(env.path) : undefined);
}

function trimPathEntry(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
