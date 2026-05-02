/**
 * 진단 로그 헬퍼 — localStorage.SOULSTREAM_DIAG === "1"일 때만 출력.
 *
 * 운영 사용자에게는 noise 0.
 * Playwright e2e가 page.addInitScript로 활성화한 뒤 console 캡처:
 *   await context.addInitScript(() => { localStorage.SOULSTREAM_DIAG = "1"; });
 *   page.on("console", msg => { if (msg.text().startsWith("[DIAG]")) ... });
 */

let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    cachedEnabled = false;
    return false;
  }
  try {
    cachedEnabled = localStorage.getItem("SOULSTREAM_DIAG") === "1";
  } catch {
    cachedEnabled = false;
  }
  return cachedEnabled;
}

/**
 * 진단 로그. 첫 인자는 [DIAG] 접두사 카테고리, 나머지는 console.log 그대로.
 * 카테고리 예: "history", "tree-placer", "event-processor"
 */
export function diag(category: string, ...args: unknown[]): void {
  if (!isEnabled()) return;
  console.log(`[DIAG][${category}]`, ...args);
}

/** 캐시 무효화 (테스트용 — 일반적으로 불필요) */
export function _resetDiagCache(): void {
  cachedEnabled = null;
}
