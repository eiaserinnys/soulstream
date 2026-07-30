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
  readonly path: string;
  readonly source: CodexCliPathSource;
}

type EnvLike = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

const WINDOWS_SPAWNABLE_EXTENSIONS = [".cmd", ".exe", ".bat", ".com"] as const;

export function resolveCodexCliPath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): CodexCliPathResolution | undefined {
  const explicit = nonEmpty(env.CODEX_CLI_PATH);
  if (explicit !== undefined) {
    return { path: explicit, source: "CODEX_CLI_PATH" };
  }
  for (const candidate of candidateCodexCliPaths(env, platform)) {
    if (isSpawnable(candidate.path, platform)) return candidate;
  }
  return undefined;
}

function candidateCodexCliPaths(
  env: EnvLike,
  platform: NodeJS.Platform,
): CodexCliPathResolution[] {
  const candidates: CodexCliPathResolution[] = [];
  const pathValue = nonEmpty(env.PATH) ??
    (platform === "win32" ? nonEmpty(env.Path) : undefined);
  if (pathValue !== undefined) {
    for (const directory of pathValue.split(
      platform === "win32" ? ";" : delimiter,
    )) {
      if (!directory) continue;
      if (platform === "win32") {
        candidates.push(...windowsCodexCandidates(directory, "PATH"));
      } else {
        candidates.push({
          path: joinPath(directory, "codex"),
          source: "PATH",
        });
      }
    }
  }
  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA);
    if (appData !== undefined) {
      candidates.push(
        ...windowsCodexCandidates(
          joinPath(appData, "npm"),
          "WINDOWS_APPDATA_NPM",
        ),
      );
    }
    const userProfile = nonEmpty(env.USERPROFILE);
    if (userProfile !== undefined) {
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
  if (home !== undefined) {
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
  directory: string,
  source: CodexCliPathSource,
): CodexCliPathResolution[] {
  return WINDOWS_SPAWNABLE_EXTENSIONS.map((extension) => ({
    path: joinPath(directory, `codex${extension}`),
    source,
  }));
}

function isSpawnable(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    try {
      return statSync(path).isFile() &&
        WINDOWS_SPAWNABLE_EXTENSIONS.some((extension) =>
          path.toLowerCase().endsWith(extension)
        );
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

function joinPath(base: string, ...segments: string[]): string {
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const separator = trimmedBase.includes("\\") || /^[a-zA-Z]:/.test(trimmedBase)
    ? "\\"
    : "/";
  return [trimmedBase, ...segments].join(separator);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
