import { CLAUDE_OAUTH_TOKEN_ENV } from "./engine/claude_options.js";

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

type ProcessEnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function resolveModelPresetEnv(
  rawEnv: Record<string, string> | undefined,
  processEnv: ProcessEnvLike = process.env,
  sourceLabel = "model preset",
): Record<string, string> | undefined {
  if (rawEnv === undefined || Object.keys(rawEnv).length === 0) {
    return undefined;
  }
  const env = Object.fromEntries(
    Object.entries(rawEnv).map(([key, value]) => [
      key,
      resolveEnvValue(key, value, processEnv, sourceLabel),
    ]),
  );
  validateAnthropicAuthBundle(env, sourceLabel);
  return env;
}

export function isModelPresetEnvResolvable(
  rawEnv: Record<string, string> | undefined,
  processEnv: ProcessEnvLike = process.env,
): boolean {
  try {
    resolveModelPresetEnv(rawEnv, processEnv);
    return true;
  } catch {
    return false;
  }
}

function resolveEnvValue(
  envKey: string,
  rawValue: string,
  processEnv: ProcessEnvLike,
  sourceLabel: string,
): string {
  if (rawValue.startsWith("${") && rawValue.endsWith("}")) {
    const sourceKey = rawValue.slice(2, -1);
    if (sourceKey.length === 0) {
      throw new Error(`${sourceLabel} env '${envKey}' has an empty variable reference`);
    }
    const resolved = processEnv[sourceKey];
    if (resolved === undefined || resolved === "") {
      throw new Error(
        `${sourceLabel} env '${envKey}' references missing environment variable '${sourceKey}'`,
      );
    }
    return resolved;
  }
  return rawValue;
}

function validateAnthropicAuthBundle(
  env: Record<string, string>,
  sourceLabel: string,
): void {
  const hasApiKey = ANTHROPIC_API_KEY_ENV in env;
  const hasBaseUrl = ANTHROPIC_BASE_URL_ENV in env;
  if (hasApiKey !== hasBaseUrl) {
    throw new Error(
      `${sourceLabel} env must set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL together`,
    );
  }
  if (hasApiKey && CLAUDE_OAUTH_TOKEN_ENV in env) {
    throw new Error(
      `${sourceLabel} env cannot mix ANTHROPIC_API_KEY with CLAUDE_CODE_OAUTH_TOKEN`,
    );
  }
}
