// 카드 #1735 화면 시험 공용 준비: 뷰포트, 어두운 테마, WebGL 저장값, 인증 픽스처.
// radius-glass-review.e2e.ts와 mobile-chat-glass-toolbar.e2e.ts가 함께 쓴다(시험 파일끼리 import하지 않는다).
import type { Page } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

export async function prepare(
  page: Page,
  width: number,
  webgl: boolean,
  opts: Parameters<typeof installV3VisualQaRoutes>[1] = {},
) {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript((webgl) => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", webgl ? "1" : "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  }, webgl);
  await installV3VisualQaRoutes(page, opts);
  await page.route("**/api/auth/config", (r) => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", (r) => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
}
