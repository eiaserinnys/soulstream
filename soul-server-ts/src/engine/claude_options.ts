export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_PROMPT_SUGGESTION_ENV = "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION";
export const CLAUDE_MAX_RETRIES_ENV = "CLAUDE_CODE_MAX_RETRIES";

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
  out[CLAUDE_PROMPT_SUGGESTION_ENV] = out[CLAUDE_PROMPT_SUGGESTION_ENV] ?? "1";

  for (const [key, value] of Object.entries(params.extraEnv ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }

  // `ANTHROPIC_BASE_URL` 경유 구독은 업스트림 셀 용량 부족 429에서 같은 연결로
  // CLI 내부 재시도(기본 10회, 약 5분 30초)를 반복하며 공회전한다. 연결을 끊고
  // 어댑터가 새 세션으로 재시도하도록 내부 재시도는 1회로 제한한다.
  const baseUrl = out.ANTHROPIC_BASE_URL;
  if (
    typeof baseUrl === "string"
    && baseUrl.length > 0
    && out[CLAUDE_MAX_RETRIES_ENV] === undefined
  ) {
    out[CLAUDE_MAX_RETRIES_ENV] = "1";
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
