/**
 * Tauri webview 환경 감지.
 *
 * Tauri 2.x는 webview 컨텍스트에 `window.__TAURI_INTERNALS__`를 주입한다.
 * (Tauri 1.x의 `window.__TAURI__`는 deprecated.)
 *
 * `typeof window !== "undefined"` 가드로 SSR/Node 환경에서 false 반환.
 * `in` 연산자로 prototype lookup을 회피하여 globalThis 오염에 안전.
 */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}
