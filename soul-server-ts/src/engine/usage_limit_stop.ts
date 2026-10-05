export const CLAUDE_RATE_LIMIT_STOP_ERROR_CODE =
  "claude_rate_limit_stop_failure";
export const CODEX_USAGE_LIMIT_ERROR_CODE = "codex_usage_limit_exceeded";

export function isUsageLimitStopErrorCode(code: unknown): boolean {
  return code === CLAUDE_RATE_LIMIT_STOP_ERROR_CODE ||
    code === CODEX_USAGE_LIMIT_ERROR_CODE;
}
