import {
  executableCandidatesInPath,
  findSpawnableExecutable,
  inspectExecutablePath,
} from "./executable_path.js";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ClaudeExecutablePathLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";

export function resolveClaudeExecutableFromPath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return findSpawnableExecutable(
    claudePathCandidates(env, platform).map((path) => ({ path })),
    platform,
  )?.path;
}

function requireClaudeExecutablePath(
  env: EnvLike,
  platform: NodeJS.Platform,
  logger: ClaudeExecutablePathLogger,
): string {
  const explicit = nonEmpty(env[CLAUDE_CODE_EXECPATH_ENV]);
  const candidates = claudePathCandidates(env, platform);
  if (explicit) {
    const explicitStatus = inspectExecutablePath(explicit, platform);
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

  const resolved = findSpawnableExecutable(candidates.map((path) => ({ path })), platform)?.path;
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
  return executableCandidatesInPath("claude", env, platform, "PATH")
    .map((candidate) => candidate.path);
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
