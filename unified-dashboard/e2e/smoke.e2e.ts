import { expect, test } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { installChatUiRoutes, openChatUi } from "./chat-ui-fixtures";

test("renders the built v3 dashboard with its deterministic API fixture", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  });
  await installV3VisualQaRoutes(page);

  await page.goto("/v3", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "세션 첫 메시지" })).toBeVisible();
  const inbox = page.locator(".v3-card-inbox");
  await expect(inbox.locator("[data-board-column]")).toHaveCount(0);
  await expect(inbox.locator(".v3-card-board-empty")).toHaveText("카드가 없습니다");
  await expect(inbox.locator('[data-board-column="done"]')).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "새 카드", exact: true })).toBeVisible();
  await expect(inbox.getByRole("button", { name: "보드 확대", exact: true })).toBeVisible();
  await inbox.getByRole("button", { name: "기록", exact: true }).click();
  await expect(page.locator(".v3-date-head")).toBeVisible();
  await expect(page.getByTestId("persistent-session-entry")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("HTTP history and SSE UI append through the actual chat composer without sending", async ({ page }) => {
  const harness = await installChatUiRoutes(page, { live: true });
  const root = await openChatUi(page);
  const draft = root.locator('textarea[data-slot="chat-input-body"]');
  await draft.fill("스모크 초안");
  harness.releaseLive();
  await expect(root.locator(".chat-ui")).toHaveCount(2);
  await root.getByRole("button", { name: "이 조건으로 질문", exact: true }).last().click();
  await expect(draft).toHaveValue("스모크 초안\n\n8명, 연간 결제: 아니오, 월 232,000원 조건으로 비교해 줘.");
  await expect(draft).toBeFocused();
  expect(harness.sends).toEqual([]);
  harness.releaseFinal(); harness.releaseDuplicate();
  await expect(root.getByText("앞뒤 최종 답", { exact: true })).toBeVisible();
  expect(harness.errors).toEqual([]);
});
