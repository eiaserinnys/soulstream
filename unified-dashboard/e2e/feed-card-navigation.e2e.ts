import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { reviewCard } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4198";
const output = path.resolve("../../../.local/artifacts/20261005-feed-card-navigation");

test("selecting an affiliated feed session opens its card and that session chat", async ({ page }) => {
  const browserErrors: string[] = [];
  const card = {
    ...reviewCard,
    id: "feed-card",
    folderId: "rb-alpha",
    title: "피드 연결 카드",
    assigneeSessionId: "run-alpha-2",
  };

  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, {
    unifiedFolderView: true,
    postitCards: [card],
    excludeSessionIdsFromInitialStream: ["run-alpha-1"],
    timelineEventCount: 2,
    liveEventText: "피드에서 연결 카드를 선택했습니다.",
  });
  await page.route("**/api/cards/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id !== card.id) return route.fallback();
    return route.fulfill({ json: {
      card,
      reports: [],
      questions: [],
      comments: [],
      sessions: [{
        sessionId: "run-alpha-2",
        cardId: card.id,
        displayName: "시각 QA 순회",
        nodeId: "eiaserinnys",
        agentId: "roselin_codex",
        status: "running",
        createdAt: "2026-07-14",
        updatedAt: "2026-07-14",
        callerSessionId: null,
      }],
    } });
  });

  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  const feed = page.getByTestId("v3-session-panel");
  const feedRow = feed.getByTestId("v3-session-row-run-alpha-2");
  await expect(feedRow).toBeVisible();
  await feedRow.locator(".v3-run-open").click();

  const workspace = page.getByTestId("v3-card-workspace");
  const detail = workspace.getByTestId("card-detail");
  const chat = workspace.getByTestId("v3-card-session-chat");
  await expect(detail).toContainText("피드 연결 카드");
  await expect(chat.locator(".v3-chat-session-title")).toHaveText("시각 QA 순회");
  await expect(chat.getByText("피드에서 연결 카드를 선택했습니다. run-alpha-2", { exact: true })).toBeVisible();
  await expect(browserErrors).toEqual([]);

  mkdirSync(output, { recursive: true });
  await workspace.screenshot({
    path: path.join(output, "web-feed-card-and-selected-chat.png"),
    animations: "disabled",
  });
});
