/**
 * 일시적 HTTP 429(용량 부족) 응답 판별과 재시도 대기 계산.
 *
 * `ANTHROPIC_BASE_URL` 경유 구독(OpenCode Go 등)은 주간 할당량이 남아 있어도
 * 업스트림 셀 용량 부족으로 `429 [prefill_cap_refused] ...`를 돌려줄 수 있다.
 * 이것은 구독·계정 한도 소진과 다르므로, 같은 오류를 재시도 가능한 것으로 다룬다.
 */
export const DEFAULT_CLAUDE_TRANSIENT_429_MAX_RETRIES = 3;
export const DEFAULT_CLAUDE_TRANSIENT_429_RETRY_DELAY_MS = 15_000;
export const TRANSIENT_429_CONTINUATION_PROMPT =
  "일시적 API 429(용량 제한) 오류로 직전 응답이 중단되었습니다. 이미 끝낸 도구 작업은 반복하지 말고 직전 요청에 이어서 계속 진행하세요.";

const QUOTA_EXHAUSTION_PATTERN =
  /hit your usage limit|out of (extra )?usage|five_hour|seven_day|out_of_credits|spend_limit|billing_error|insufficient_quota/i;

const TRANSIENT_429_PATTERN =
  /\b429\b|prefill_cap_refused|cell is at capacity|rate_limit_error|Request rejected \(429\)/i;

export function isTransientClaude429ErrorMessage(
  message: string | null | undefined,
  errorCode?: string,
): boolean {
  if (errorCode === "claude_rate_limit_stop_failure" || errorCode === "claude_usage_limit_stop") {
    return false;
  }
  if (!message) return false;
  if (QUOTA_EXHAUSTION_PATTERN.test(message)) return false;
  return TRANSIENT_429_PATTERN.test(message);
}

export function parseTransient429RetryDelayMs(
  message: string,
  fallbackMs = DEFAULT_CLAUDE_TRANSIENT_429_RETRY_DELAY_MS,
): number {
  const match = /after\s+(\d+)\s*s/i.exec(message);
  if (!match) return fallbackMs;
  return Math.min(60_000, Math.max(1_000, Number(match[1]) * 1000));
}
