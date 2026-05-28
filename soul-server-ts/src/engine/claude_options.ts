export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_PROMPT_SUGGESTION_ENV = "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION";

export function normalizeClaudeModel(model: string | null | undefined): string | undefined {
  if (model === null || model === undefined) return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildClaudeEnvironment(params: {
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  extraEnv?: Record<string, string | undefined>;
} = {}): Record<string, string> | undefined {
  const hasExtraEnv = Object.values(params.extraEnv ?? {}).some(
    (value) => value !== undefined,
  );
  if (params.processEnv === undefined && !hasExtraEnv) {
    return undefined;
  }

  const out: Record<string, string> = {};
  const baseEnv = params.processEnv ?? process.env;
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  out[CLAUDE_PROMPT_SUGGESTION_ENV] = "1";

  for (const [key, value] of Object.entries(params.extraEnv ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
