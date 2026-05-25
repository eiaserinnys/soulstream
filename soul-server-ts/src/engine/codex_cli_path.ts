import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type CodexCliPathSource =
  | "CODEX_CLI_PATH"
  | "PATH"
  | "HOME_NPM_GLOBAL"
  | "HOME_LOCAL_BIN";

export interface CodexCliPathResolution {
  path: string;
  source: CodexCliPathSource;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

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
): CodexCliPathResolution | undefined {
  const explicit = nonEmpty(env.CODEX_CLI_PATH);
  if (explicit) {
    return { path: explicit, source: "CODEX_CLI_PATH" };
  }

  for (const candidate of candidateCodexCliPaths(env)) {
    if (isExecutable(candidate.path)) {
      return candidate;
    }
  }

  return undefined;
}

function candidateCodexCliPaths(env: EnvLike): CodexCliPathResolution[] {
  const candidates: CodexCliPathResolution[] = [];
  const pathValue = nonEmpty(env.PATH);
  if (pathValue) {
    for (const dir of pathValue.split(delimiter)) {
      if (!dir) continue;
      candidates.push({ path: join(dir, "codex"), source: "PATH" });
    }
  }

  const home = nonEmpty(env.HOME);
  if (home) {
    candidates.push(
      { path: join(home, ".npm-global", "bin", "codex"), source: "HOME_NPM_GLOBAL" },
      { path: join(home, ".local", "bin", "codex"), source: "HOME_LOCAL_BIN" },
    );
  }

  return candidates;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
