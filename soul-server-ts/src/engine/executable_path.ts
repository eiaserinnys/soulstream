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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
