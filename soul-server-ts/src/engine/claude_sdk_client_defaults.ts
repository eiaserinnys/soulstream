export const DEFAULT_INPUT_REQUEST_TIMEOUT_MS = 300_000;

/** Result 도착 후 SDK `prompt_suggestion`을 받기 위한 short drain 시간. */
export const DEFAULT_POST_RESULT_DRAIN_MS = 2_000;

/** 장기 실행 runtime task를 허용하되 drain이 끝없이 붙잡히지 않게 하는 상한. */
export const DEFAULT_CLAUDE_RUNTIME_DRAIN_MAX_MS = 6 * 60 * 60 * 1_000;
