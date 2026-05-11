import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri 측 외부 navigation 가드가 참조하는 dashboard origin을 등록한다.
 *
 * `App.tsx`의 `navigateToServer`가 reachability 통과 후, `window.location.href = url` 직전에
 * 호출한다. 가드가 origin을 모르면 dashboard 안의 모든 HTTP(S) navigation이 외부로 분류되어
 * SPA 라우팅까지 OS 브라우저로 빠져나간다 — 즉 이 함수가 실패하면 dashboard 진입을 막아야 한다
 * (호출자 catch가 error 페이지로 전환, design-principles §4 명시적 실패).
 *
 * @param url full URL (path/query 포함 가능). 내부에서 origin만 추출한다.
 *            잘못된 URL 입력은 `new URL(url)`가 `TypeError` throw한다.
 */
export async function registerDashboardOrigin(url: string): Promise<void> {
  const origin = new URL(url).origin;
  await invoke("set_dashboard_origin", { origin });
}
