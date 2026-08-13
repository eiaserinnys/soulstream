import { accessSync, constants, statSync } from "node:fs";
import { delimiter } from "node:path";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function resolveClaudeExecutableFromPath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const candidate of claudePathCandidates(env, platform)) {
    if (isSpawnable(candidate, platform)) {
      return candidate;
    }
  }
  return undefined;
}

export function requireClaudeExecutablePath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = nonEmpty(env[CLAUDE_CODE_EXECPATH_ENV]);
  if (explicit) {
    if (isSpawnable(explicit, platform)) return explicit;
    throw resolutionError(platform, [explicit], CLAUDE_CODE_EXECPATH_ENV);
  }

  const candidates = claudePathCandidates(env, platform);
  const resolved = candidates.find((candidate) => isSpawnable(candidate, platform));
  if (resolved) return resolved;
  throw resolutionError(platform, candidates, "PATH/PATHEXT");
}

export function configureClaudeExecutablePath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = requireClaudeExecutablePath(env, platform);
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

function isSpawnable(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    try {
      return statSync(path).isFile();
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
