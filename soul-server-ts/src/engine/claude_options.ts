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
} = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.processEnv ?? process.env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }

  // Python client_lifecycle.py keeps prompt suggestions enabled by default and lets extra_env override it.
  out[CLAUDE_PROMPT_SUGGESTION_ENV] = out[CLAUDE_PROMPT_SUGGESTION_ENV] ?? "1";

  for (const [key, value] of Object.entries(params.extraEnv ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
