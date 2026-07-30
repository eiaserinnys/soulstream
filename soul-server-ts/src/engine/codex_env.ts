/**
 * Codex CLI 자식 프로세스에 전달할 env를 sanitize.
 *
 * 동기 (분석 캐시 `20260517-1157-codex-ts-oauth-401.md`):
 * pm2 god 또는 셸 부모가 *빈 문자열*로 inject한 `OPENAI_API_KEY` / `CODEX_API_KEY`가
 * 자식 codex-rs 바이너리에 그대로 상속되면, codex-rs가 "API key 모드 + 빈 키"로
 * 분기하여 `wss://api.openai.com/v1/responses`에 401로 막힌다. `~/.codex/auth.json`의
 * ChatGPT OAuth fallback이 실행되지 않는다.
 *
 * 본 함수는 어댑터 경계에서:
 * 1. `undefined` 값은 제거 (Codex SDK가 요구하는 `Record<string,string>` 타입 정합).
 * 2. `OPENAI_API_KEY`·`CODEX_API_KEY`가 *빈 문자열*이면 키 자체를 드롭.
 *    *비어있지 않은* 값은 보존한다 — 운영자가 실제로 API key 모드를 의도한 경우 막지 않는다.
 *
 * design-principles §1(지식 경계)·§6(전달은 파라미터로):
 * 어댑터는 자기 바깥(pm2 god 셸)이 무엇을 inject했는지에 영향받지 않도록
 * 경계에서 명시적으로 검증·정리한다.
 */
export function sanitizeCodexEnv(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    // 빈 문자열 핵심 키는 codex CLI를 API key 모드로 강제 분기시켜 401 유발.
    if (
      (key === "OPENAI_API_KEY" || key === "CODEX_API_KEY") &&
      value === ""
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
