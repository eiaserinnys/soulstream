import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
const output = path.resolve(
  "../../../.local/artifacts/20261001-card-orchestration/ui",
);
mkdirSync(output, { recursive: true });
for (const width of [1440, 390])
  test(`central card policy real form ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => {
      localStorage.setItem("soul-dashboard-theme", "dark");
      localStorage.setItem("ls.webglGlass", "0");
    });
    await installV3VisualQaRoutes(page, {
      unifiedFolderView: true,
      timelineEventCount: 1,
    });
    await page.route("**/api/auth/config", (r) =>
      r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }),
    );
    await page.route("**/api/auth/status", (r) =>
      r.fulfill({
        json: {
          authenticated: true,
          user: { email: "qa@example.test", name: "QA", isAdmin: true },
        },
      }),
    );
    await page.route("**/api/user/preferences", (r) =>
      r.fulfill({
        json: { preferences: { chatFontSize: 17 }, hasBackground: false },
      }),
    );
    await page.goto("/components");
    await expect(page.getByTestId("components-review")).toBeVisible();
    const sample = page.locator(
      '[data-component="CardOrchestrationSettingsForm / Input / Button"]',
    );
    await sample.scrollIntoViewIfNeeded();
    const form = sample.getByRole("form", { name: "중앙 카드 배정 정책" });
    await expect(form).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(output, `components-${width}.png`),
      animations: "disabled",
    });
    await form.getByRole("button", { name: "2순위 위로", exact: true }).click();
    await expect(form.getByLabel("1순위 모델 프리셋")).toHaveValue(
      "codex-6-astra",
    );
    await form
      .getByRole("button", { name: "배정 정책 저장", exact: true })
      .click();
    await expect(form.getByRole("status")).toHaveText(
      "배정 정책을 저장했습니다.",
    );
    const metrics = await form.evaluate((form) => {
      const f = form.getBoundingClientRect();
      return {
        form: { left: f.left, right: f.right, width: f.width },
        inputs: [...form.querySelectorAll("input")].map((input) => {
          const r = input.getBoundingClientRect(),
            s = getComputedStyle(input);
          return {
            label: input.getAttribute("aria-label"),
            left: r.left,
            right: r.right,
            height: r.height,
            font: s.fontSize,
            padding: s.padding,
            browserFocus: s.outlineStyle,
          };
        }),
        buttons: [...form.querySelectorAll("button")].map((button) => {
          const r = button.getBoundingClientRect();
          return {
            label: button.textContent,
            width: r.width,
            height: r.height,
            left: r.left,
            right: r.right,
          };
        }),
      };
    });
    for (const input of metrics.inputs) {
      expect(input.right).toBeLessThanOrEqual(metrics.form.right + 1);
      expect(input.left).toBeGreaterThanOrEqual(metrics.form.left - 1);
    }
    const policy = {
      enabled: false,
      candidates: [
        {
          agentId: "ariella-orchestrator",
          nodeId: "eiaserinnys",
          modelPreset: "claude-opus",
          minimumRemainingPercent: 15,
        },
        {
          agentId: "ariella-orchestrator",
          nodeId: "eiaserinnys",
          modelPreset: "codex-6-astra",
          minimumRemainingPercent: 15,
        },
      ],
      usageMaxAgeMs: 300000,
      sessionFolderId: null,
      systemFolderParentId: null,
    };
    // The real settings surface uses the canonical payload through mocked network boundaries.
    await page.route("**/api/settings/card-dispatch", (r) =>
      r.fulfill({
        json: { settings: { version: 1, nodeConcurrency: { default: 2 } } },
      }),
    );
    await page.route("**/api/settings/card-orchestration", (r) =>
      r.fulfill({
        json: {
          settings: {
            key: "card_orchestration",
            version: 1,
            policy,
            updatedBy: "QA",
            updatedAt: "2026-10-01T00:00:00Z",
          },
          status: { state: "대기", reason: "새 사용량을 기다립니다." },
        },
      }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "서버 설정", exact: true }).click();
    await page.getByRole("tab", { name: "카드 실행", exact: true }).click();
    const operational = page.getByRole("form", { name: "중앙 카드 배정 정책" });
    await expect(operational.getByLabel("1순위 모델 프리셋")).toHaveValue(
      "claude-opus",
    );
    await operational.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(output, `settings-${width}-context.png`),
      animations: "disabled",
    });
    await operational.getByLabel("새 보관 폴더의 상위 폴더").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(output, `settings-${width}-form.png`),
      animations: "disabled",
    });
    writeFileSync(
      path.join(output, `metrics-${width}.json`),
      JSON.stringify(metrics, null, 2),
    );
  });
