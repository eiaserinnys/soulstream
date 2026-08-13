import { accessSync, constants, statSync } from "node:fs";
import { delimiter } from "node:path";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ClaudeExecutablePathLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

type Spawnability =
  | { spawnable: true }
  | { spawnable: false; reason: string };

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function resolveClaudeExecutableFromPath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const candidate of claudePathCandidates(env, platform)) {
    if (inspectSpawnability(candidate, platform).spawnable) {
      return candidate;
    }
  }
  return undefined;
}

function requireClaudeExecutablePath(
  env: EnvLike,
  platform: NodeJS.Platform,
  logger: ClaudeExecutablePathLogger,
): string {
  const explicit = nonEmpty(env[CLAUDE_CODE_EXECPATH_ENV]);
  const candidates = claudePathCandidates(env, platform);
  if (explicit) {
    const explicitStatus = inspectSpawnability(explicit, platform);
    if (explicitStatus.spawnable) return explicit;
    logger.error(
      {
        environmentVariable: CLAUDE_CODE_EXECPATH_ENV,
        configuredPath: explicit,
        reason: explicitStatus.reason,
        platform,
      },
      "Configured CLAUDE_CODE_EXECPATH is unusable; falling back to PATH/PATHEXT",
    );
  }

  const resolved = candidates.find(
    (candidate) => inspectSpawnability(candidate, platform).spawnable,
  );
  if (resolved) return resolved;
  throw resolutionError(
    platform,
    explicit ? [explicit, ...candidates] : candidates,
    explicit ? `${CLAUDE_CODE_EXECPATH_ENV} then PATH/PATHEXT` : "PATH/PATHEXT",
  );
}

export function configureClaudeExecutablePath(
  env: EnvLike,
  platform: NodeJS.Platform,
  logger: ClaudeExecutablePathLogger,
): string {
  const resolved = requireClaudeExecutablePath(env, platform, logger);
  env[CLAUDE_CODE_EXECPATH_ENV] = resolved;
  return resolved;
}

function claudePathCandidates(
  env: EnvLike,
  platform: NodeJS.Platform,
): string[] {
  const pathValue = getPathValue(env, platform);
  if (!pathValue) return [];
  const names = platform === "win32"
    ? windowsCandidateNames(env.PATHEXT)
    : ["claude"];
  const candidates: string[] = [];
  for (const rawDirectory of pathValue.split(pathDelimiter(platform))) {
    const directory = trimPathEntry(rawDirectory);
    if (!directory) continue;
    for (const name of names) {
      candidates.push(joinPath(directory, name));
    }
  }
  return candidates;
}

function windowsCandidateNames(pathExt: string | undefined): string[] {
  const extensions = (nonEmpty(pathExt) ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [...new Set(extensions.map((extension) => extension.toLowerCase()))]
    .map((extension) => `claude${extension}`);
}

function getPathValue(env: EnvLike, platform: NodeJS.Platform): string | undefined {
  return nonEmpty(env.PATH)
    ?? (platform === "win32" ? nonEmpty(env.Path) ?? nonEmpty(env.path) : undefined);
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : delimiter;
}

function trimPathEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function joinPath(directory: string, name: string): string {
  const base = directory.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") || /^[a-zA-Z]:/.test(base) ? "\\" : "/";
  return `${base}${separator}${name}`;
}

function inspectSpawnability(
  path: string,
  platform: NodeJS.Platform,
): Spawnability {
  try {
    if (!statSync(path).isFile()) {
      return { spawnable: false, reason: "path is not a regular file" };
    }
    if (platform !== "win32") {
      accessSync(path, constants.X_OK);
    }
    return { spawnable: true };
  } catch (error) {
    return {
      spawnable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolutionError(
  platform: NodeJS.Platform,
  candidates: readonly string[],
  source: string,
): Error {
  const searched = candidates.length > 0 ? candidates.join(", ") : "(no candidates)";
  return new Error(
    "Claude Code executable path resolution failed before host startup. "
      + `Platform: ${platform}. Source: ${source}. Searched candidates: ${searched}`,
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
