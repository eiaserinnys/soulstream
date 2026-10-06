import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const output = path.resolve("../../../.local/artifacts", stamp + "-pas-ui2-turn-end-web");
mkdirSync(output, { recursive: true });

for (const width of [1440, 340]) {
  test("PAS turn end captions " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => {
      localStorage.setItem("soul-dashboard-theme", "dark");
      localStorage.setItem("ls.webglGlass", "0");
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
      });
      Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
    });
    await installV3VisualQaRoutes(page, {
      unifiedFolderView: true,
      timelineEventCount: 1,
      liveEventText: "대화 본문",
    });
    await page.route("**/api/auth/config", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ authEnabled: true, devModeEnabled: false }),
    }));
    await page.route("**/api/auth/status", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }),
    }));

    await page.goto("/components");
    const review = page.getByTestId("components-review");
    await expect(review).toBeVisible();
    const sample = page.getByTestId("persistent-turn-end-captions-review");
    await expect(sample).toBeVisible();
    await sample.scrollIntoViewIfNeeded();
    const agentReview = page.getByTestId("persistent-agent-message-group-review");
    await expect(agentReview).toBeVisible();
    const collapsedAgentSample = page.getByTestId("agent-message-group-collapsed");
    const expandedAgentSample = page.getByTestId("agent-message-group-expanded");
    await expect(collapsedAgentSample.locator("button")).toHaveText("다른 세션 메시지 3건");
    await expect(collapsedAgentSample.locator("button")).toHaveAttribute("aria-expanded", "false");
    await expect(expandedAgentSample.locator("button")).toHaveText("다른 세션 메시지 3건");
    await expect(expandedAgentSample.locator("button")).toHaveAttribute("aria-expanded", "true");
    await expect(expandedAgentSample.locator('[data-slot="chat-body"]')).toHaveCount(3);
    await agentReview.screenshot({ path: path.join(output, String(width) + "-agent-groups.png"), animations: "disabled" });
    const combined = page.getByTestId("turn-end-both").locator('[data-slot="turn-end-captions"]');
    const headers = combined.getByRole("button");
    await expect(headers).toHaveCount(2);
    await expect(headers.nth(0)).toHaveAttribute("aria-expanded", "false");
    await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "false");

    const geometry = await combined.evaluate(element => {
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width };
      };
      const buttons = [...element.querySelectorAll("button")];
      const header = element.firstElementChild?.firstElementChild ?? null;
      return {
        row: box(element),
        header: header ? box(header) : null,
        buttons: buttons.map(box),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    });
    // The shared caption header's -me-px alignment rounds to a 2px scroll extent in Chromium.
    expect(geometry.scrollWidth - geometry.clientWidth).toBeLessThanOrEqual(2);
    expect(geometry.buttons[1]!.right).toBeLessThanOrEqual(geometry.row.right + 1);
    expect(geometry.buttons[0]!.right).toBeLessThanOrEqual(geometry.buttons[1]!.x);
    await sample.screenshot({ path: path.join(output, String(width) + "-collapsed.png"), animations: "disabled" });

    await headers.nth(0).click();
    await headers.nth(1).click();
    await expect(headers.nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "true");
    const bodies = combined.locator("[id]");
    await expect(bodies).toHaveCount(2);
    const usageBody = bodies.nth(0);
    const summaryBody = bodies.nth(1);
    await expect(usageBody).toContainText("컨텍스트 6,300 / 10,000");
    await expect(usageBody).toContainText("턴 완료 · 입력 1,200");
    await expect(summaryBody).toContainText("요청한 화면 변경");
    const bodyGeometry = await Promise.all([
      usageBody.boundingBox(),
      summaryBody.boundingBox(),
    ]);
    expect(bodyGeometry[0]).not.toBeNull();
    expect(bodyGeometry[1]).not.toBeNull();
    expect(bodyGeometry[0]!.y + bodyGeometry[0]!.height).toBeLessThanOrEqual(bodyGeometry[1]!.y);
    await sample.screenshot({ path: path.join(output, String(width) + "-expanded.png"), animations: "disabled" });

    const manuscript = page.getByTestId("manuscript-review-column");
    await expect(manuscript).toBeVisible();
    await expect(manuscript).not.toContainText("담당 카드 없음");
    await expect(manuscript.getByRole("button", { name: "요약", exact: true })).toHaveCount(1);
    const transcriptAgentGroups = manuscript.locator('[data-slot="manuscript-agent-message-group"]');
    await expect(transcriptAgentGroups).toHaveCount(2);
    await expect(transcriptAgentGroups.nth(0).locator("button")).toHaveText("다른 세션 메시지 3건");
    await expect(transcriptAgentGroups.nth(1).locator("button")).toHaveText("다른 세션 메시지 2건");
    await expect(manuscript).toContainText("사람이 보낸 발언은 그대로 보입니다.");
    await expect(manuscript).toContainText("서소영 응답도 지금처럼 보입니다.");
    await expect(manuscript).toContainText("시스템 개입은 지금처럼 보입니다.");
    await manuscript.screenshot({ path: path.join(output, String(width) + "-manuscript.png"), animations: "disabled" });
    const defaultChat = page.getByTestId("default-review-column");
    await expect(defaultChat).toBeVisible();
    await defaultChat.screenshot({ path: path.join(output, String(width) + "-default-chat.png"), animations: "disabled" });
    const defaultComplete = defaultChat.locator('[data-tree-node-id="review-default-complete"]');
    await expect(defaultComplete).toContainText("턴 완료");
    await defaultComplete.screenshot({ path: path.join(output, String(width) + "-default-complete.png"), animations: "disabled" });
    const defaultSummary = page.locator('[data-tree-node-id="caption-sample-summary"]');
    await expect(defaultSummary).toContainText("기존 요약");
    await expect(defaultSummary.getByRole("button")).toHaveCount(0);
    await defaultSummary.screenshot({ path: path.join(output, String(width) + "-default-summary.png"), animations: "disabled" });
    writeFileSync(path.join(output, String(width) + "-geometry.json"), JSON.stringify({ geometry, expandedBodies: bodyGeometry }, null, 2));
  });
}
