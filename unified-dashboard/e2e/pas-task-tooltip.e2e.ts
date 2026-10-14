import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, devices, type Page } from "@playwright/test";
import type { CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { reviewCard } from "../client/v3/components-review-fixtures";
import { reportReviewEntries } from "../client/v3/persistent-report-review-data";
import { installChatUiRoutes, chatUiSession } from "./chat-ui-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = "/home/eias/workspace/.local/artifacts/20261014-366-tooltip-impl";
const taskIds = ["pas-question-delayed", "pas-question-retry", "pas-question-no-now", "pas-question-multi", "pas-question-long"] as const;
const LONG_QUESTION = "구현 검수에서 발견한 질문입니다. 지금 보고 있는 툴팁은 카드의 열린 질문과 선택지를 함께 보여 줍니다. 선택지는 여러 개이고 질문 문장이 길어서 다섯 줄보다 더 많은 공간이 필요합니다. 이 문장은 모두 읽을 수 있어야 하며 버튼은 질문 바로 아래에 이어져야 합니다. 마지막 문장까지 잘리지 않고 답변을 고를 수 있을까요?";
const settings = {
  default_model: { model_preset: null, reasoning_effort: null }, fallback_model: null,
  show_generation_separator: true, show_character: false, animate_character: false,
  show_jev_candidates: true, show_turn_usage: true,
};
const now = { text: "세라피엘 설계안을 받아 시안 장면을 정리했습니다", turn: "user" as const,
  ask: "이 장면들로 시안을 만들까요?", updatedAt: "2026-10-14T10:00:00.000Z", sessionId: chatUiSession };

function taskCard(id: string, number: number, version = 1, status: CardRow["status"] = "blocked", cardNow: CardRow["now"] = now, title = `PAS 카드 ${number} 시안 구현 내용을 확인하고 선택지를 골라주세요`): CardRow {
  return { ...reviewCard, id, number, folderId: "rb-alpha", title,
    status, blockedKind: status === "blocked" ? "question" : null, blockedDetail: status === "blocked" ? cardNow?.ask ?? null : null,
    assigneeKind: null, assigneeAgentId: null, assigneeSessionId: null, nodeId: null,
    positionKey: String(number), queuePositionKey: null, version, now: cardNow };
}

function cardQuestion(id: string, text = now.ask, options = ["계속", "보류"], askedAt = "2026-10-14T10:00:00.000Z"): CardQuestion {
  return { id, text, options, answer: null, askedAt, answeredAt: null };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function installPasTooltip(page: Page, appearance: "dark" | "light", viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: appearance, reducedMotion: "reduce" });
  const unmocked: string[] = [];
  await page.route(/\/api\//, route => {
    unmocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 404, json: { detail: { error: { code: "UNMOCKED_E2E_REQUEST" } } } });
  });
  const fixture = await installChatUiRoutes(page, { example: "pas", ui: false, count: 3 });
  await page.addInitScript(theme => localStorage.setItem("soul-dashboard-theme", theme), appearance);

  let preferences: Record<string, unknown> = { appearance };
  await page.route("**/api/user/preferences", route => {
    if (route.request().method() !== "GET") preferences = route.request().postDataJSON();
    return route.fulfill({ json: { preferences, hasBackground: false } });
  });
  const session = {
    session_id: chatUiSession, display_name: "서소영 영구 세션", node_id: "eiaserinnys", folder_id: "rb-alpha",
    agent_id: "seosoyoung-pas", agent_name: "서소영 (PAS)", persistent: true, persistent_report: reportReviewEntries, settings,
    runtime: { current_model: { model_preset: null, reasoning_effort: null, model: "codex" }, pending: null },
  };
  await page.route("**/api/persistent-sessions**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions: [session], total: 1,
      create_defaults: { node_id: session.node_id, preferred_agent_id: session.agent_id, settings, initial_instruction: "", unavailable_reason: null } } });
    if (pathname.endsWith("/instructions")) return route.fulfill({ json: { instructions: [] } });
    return route.fulfill({ json: { session } });
  });

  let cards = [
    taskCard(taskIds[0], 366), taskCard(taskIds[1], 367),
    taskCard(taskIds[2], 368, 1, "blocked", null, "짧은 제목"),
    taskCard(taskIds[3], 369), taskCard(taskIds[4], 370),
  ];
  const questions = new Map<string, CardQuestion[]>(cards.map(card => {
    if (card.id === taskIds[0]) return [card.id, [cardQuestion(`question-${card.id}`, "첫 카드의 질문")]];
    if (card.id === taskIds[1]) return [card.id, [cardQuestion(`question-${card.id}`, "둘째 카드의 질문")]];
    if (card.id === taskIds[3]) return [card.id, [
      cardQuestion(`question-${card.id}-older`, "먼저 열린 질문", ["먼저 답하기", "보류"], "2026-10-14T09:00:00.000Z"),
      cardQuestion(`question-${card.id}-latest`, "가장 늦게 열린 질문", ["함께 갱신", "따로 진행"], "2026-10-14T10:00:00.000Z"),
    ]];
    if (card.id === taskIds[4]) return [card.id, [cardQuestion(`question-${card.id}`, LONG_QUESTION)]];
    return [card.id, [cardQuestion(`question-${card.id}`)]];
  }));
  const answerRequests: { cardId: string; questionId: string; body: Record<string, unknown> }[] = [];
  const firstAnswerGate = gate();
  const retryAnswerGate = gate();
  let failRetryAnswer = true;
  await page.route(url => url.pathname === "/api/cards", route => route.fulfill({ json: { cards } }));
  await page.route(url => /^\/api\/cards\/[^/]+$/.test(url.pathname), route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.slice("/api/cards/".length));
    const card = cards.find(item => item.id === id);
    if (!card) return route.fulfill({ status: 404, json: { detail: { error: { code: "CARD_NOT_FOUND" } } } });
    const detail: CardDetail = { card, reports: [], questions: questions.get(id) ?? [], sessions: [], comments: [], notes: [], nowHistory: [] };
    return route.fulfill({ json: detail });
  });
  await page.route(url => url.pathname.endsWith("/answer"), async route => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const cardId = decodeURIComponent(parts[3]!);
    const questionId = decodeURIComponent(parts[5]!);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    answerRequests.push({ cardId, questionId, body });
    if (cardId === taskIds[0] && answerRequests.filter(item => item.cardId === taskIds[0]).length === 1) {
      await firstAnswerGate.promise;
    }
    if (cardId === taskIds[1] && failRetryAnswer) {
      failRetryAnswer = false;
      await retryAnswerGate.promise;
      return route.fulfill({ status: 500, json: { detail: { error: { code: "ANSWER_FAILED", message: "answer failed" } } } });
    }
    const currentCard = cards.find(item => item.id === cardId)!;
    const openQuestions = questions.get(cardId) ?? [];
    const answeredQuestions = openQuestions.map(question => question.id === questionId
      ? { ...question, answer: String(body.answer), answeredAt: "2026-10-14T10:01:00.000Z" }
      : question);
    questions.set(cardId, answeredQuestions);
    const hasOpenQuestion = answeredQuestions.some(question => question.answer === null);
    cards = cards.map(card => card.id === cardId
      ? taskCard(card.id, card.number ?? 0, card.version + 1, hasOpenQuestion ? "blocked" : "running", currentCard.now)
      : card);
    return route.fulfill({ json: { folderId: currentCard.folderId, card: cards.find(item => item.id === cardId), operation: {}, idempotent: false } });
  });

  await page.addInitScript(() => {
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await page.goto(`/persistent/${chatUiSession}`);
  await expect(page.getByTestId("persistent-session-screen")).toBeVisible();
  await expect(page.getByRole("button", { name: "작업 목록", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
  await expect(page.locator("[data-testid='persistent-session-task-list'] [data-card-id]").first()).toBeVisible();
  return { fixture, unmocked, answerRequests, firstAnswerGate, retryAnswerGate, taskIds };
}

test("PAS task tooltip answer stays open during send, retries failure, and refreshes card status", async ({ page }) => {
  mkdirSync(output, { recursive: true });
  const { unmocked, answerRequests, firstAnswerGate, retryAnswerGate, taskIds: ids } = await installPasTooltip(page, "dark");
  const firstRow = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[0]}']`);
  await firstRow.hover();
  const tooltip = page.locator(".v3-persistent-task-tooltip .v3-surface");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('[data-tooltip-field="ask"]')).toHaveText("첫 카드의 질문");
  await expect(tooltip.getByRole("button", { name: "계속", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, "dark-question-options.png") });

  const continueButton = tooltip.getByRole("button", { name: "계속", exact: true });
  await continueButton.hover();
  await expect(tooltip).toBeVisible();
  await continueButton.click();
  await expect.poll(() => answerRequests.length).toBe(1);
  await expect(continueButton).toBeDisabled();
  await expect(tooltip).toBeVisible();
  await page.screenshot({ path: path.join(output, "sending.png") });
  await page.waitForTimeout(500);
  firstAnswerGate.release();
  await expect.poll(() => page.locator(`[data-task-status-group='running'] [data-card-id='${ids[0]}']`).count()).toBe(1);
  await expect(tooltip).not.toBeVisible();
  expect(answerRequests[0]).toMatchObject({ cardId: ids[0], questionId: `question-${ids[0]}`, body: { answer: "계속" } });

  const secondRow = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[1]}']`);
  await secondRow.hover();
  await expect(tooltip).toBeVisible();
  const retryButton = tooltip.getByRole("button", { name: "보류", exact: true });
  await retryButton.hover();
  await retryButton.click();
  await expect.poll(() => answerRequests.filter(item => item.cardId === ids[1]).length).toBe(1);
  await expect(retryButton).toBeDisabled();
  await page.mouse.move(8, 8);
  await expect(tooltip).toBeVisible();
  retryAnswerGate.release();
  await expect(tooltip.getByRole("alert")).toHaveText("답을 보내지 못했습니다");
  await expect(retryButton).toBeEnabled();
  await page.screenshot({ path: path.join(output, "send-error.png") });
  await retryButton.hover();
  await retryButton.click();
  await expect.poll(() => answerRequests.filter(item => item.cardId === ids[1]).length).toBe(2);
  await expect.poll(() => page.locator(`[data-task-status-group='running'] [data-card-id='${ids[1]}']`).count()).toBe(1);
  await expect(tooltip).not.toBeVisible();

  const reportTitle = page.locator(".pas-report-title").first();
  const reportBody = page.locator(".pas-report-context").first();
  await expect(reportTitle).toBeVisible();
  const reportStyles = await Promise.all([reportTitle, reportBody].map(locator => locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { wordBreak: style.wordBreak, overflowWrap: style.overflowWrap };
  })));
  expect(reportStyles).toEqual([{ wordBreak: "keep-all", overflowWrap: "anywhere" }, { wordBreak: "keep-all", overflowWrap: "anywhere" }]);
  await page.screenshot({ path: path.join(output, "report-bubble.png") });
  expect(unmocked).toEqual([]);
  expect(answerRequests).toHaveLength(3);
});

test("PAS task tooltip uses the light theme and stays absent below its viewport threshold", async ({ page }) => {
  mkdirSync(output, { recursive: true });
  const { unmocked, taskIds: ids } = await installPasTooltip(page, "light");
  const firstRow = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[0]}']`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, "1440-before-hover.png") });
  await firstRow.hover();
  const tooltip = page.locator(".v3-persistent-task-tooltip .v3-surface");
  await expect(tooltip).toBeVisible();
  await page.screenshot({ path: path.join(output, "light-question-options.png") });
  const wideGeometry = await readTooltipGeometry(page, ids[0]);
  expect(wideGeometry.titleTopDifference).toBeLessThanOrEqual(1);
  expect(wideGeometry.widthDifference).toBeLessThanOrEqual(1);
  writeFileSync(path.join(output, "1440-tooltip-geometry.json"), JSON.stringify(wideGeometry, null, 2));

  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.screenshot({ path: path.join(output, "820-before-hover.png") });
  await firstRow.hover();
  await expect(tooltip).toBeVisible();
  await page.screenshot({ path: path.join(output, "narrow-question-options.png") });
  const narrowGeometry = await readTooltipGeometry(page, ids[0]);
  expect(narrowGeometry.titleTopDifference).toBeLessThanOrEqual(1);
  expect(narrowGeometry.widthDifference).toBeLessThanOrEqual(1);
  writeFileSync(path.join(output, "820-tooltip-geometry.json"), JSON.stringify(narrowGeometry, null, 2));

  await page.setViewportSize({ width: 767, height: 900 });
  await expect.poll(() => page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine) and (min-width: 768px)").matches)).toBe(false);
  await page.mouse.move(0, 0);
  await firstRow.hover();
  await expect(page.locator(".v3-persistent-task-tooltip")).toHaveCount(0);
  expect(unmocked).toEqual([]);
});

async function readTooltipGeometry(page: Page, cardId: string) {
  return page.evaluate(id => {
    const row = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
    const title = row.querySelector<HTMLElement>(".v3-card-summary-title")!;
    const popup = document.querySelector<HTMLElement>(".v3-persistent-task-tooltip .v3-surface")!;
    const firstText = popup.querySelector<HTMLElement>("p")!;
    const rowBox = row.getBoundingClientRect();
    const popupBox = popup.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const textBox = firstText.getBoundingClientRect();
    return {
      row: { left: rowBox.left, right: rowBox.right, top: rowBox.top, width: rowBox.width },
      popup: { left: popupBox.left, right: popupBox.right, top: popupBox.top, width: popupBox.width },
      titleTextTop: titleBox.top,
      tooltipTextTop: textBox.top,
      titleTopDifference: Math.abs(textBox.top - titleBox.top),
      widthDifference: Math.abs(popupBox.width - rowBox.width),
    };
  }, cardId);
}

test("PAS task tooltip stays absent in a touch device context", async ({ browser }) => {
  mkdirSync(output, { recursive: true });
  const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const { unmocked, taskIds: ids } = await installPasTooltip(page, "light", { width: 390, height: 844 });
    const row = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[0]}']`);
    await expect.poll(() => page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine) and (min-width: 768px)").matches)).toBe(false);
    const box = await row.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(400);
    await expect(page.locator(".v3-persistent-task-tooltip")).toHaveCount(0);
    expect(unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

test("PAS task tooltip shows a question and answer choices when card now is null", async ({ page }) => {
  mkdirSync(output, { recursive: true });
  const { answerRequests, taskIds: ids } = await installPasTooltip(page, "dark");
  const row = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[2]}']`);
  await row.hover();
  const tooltip = page.locator(".v3-persistent-task-tooltip .v3-surface");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('[data-tooltip-field="title"]')).toHaveCount(0);
  await expect(tooltip.locator('[data-tooltip-field="now"]')).toHaveCount(0);
  await expect(tooltip.locator('[data-tooltip-field="ask"]')).toHaveText(now.ask);
  const option = tooltip.getByRole("button", { name: "계속", exact: true });
  await expect(option).toBeVisible();
  await page.screenshot({ path: path.join(output, "now-null-question.png") });
  await option.hover();
  await option.click();
  await expect.poll(() => answerRequests.length).toBe(1);
  expect(answerRequests[0]).toMatchObject({ cardId: ids[2], questionId: `question-${ids[2]}`, body: { answer: "계속" } });
});

test("question tooltip stays tied to its card across a diagonal pointer path", async ({ page }) => {
  mkdirSync(output, { recursive: true });
  const { answerRequests, firstAnswerGate, taskIds: ids } = await installPasTooltip(page, "dark");
  const firstRow = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[0]}']`);
  const tooltip = page.locator(".v3-persistent-task-tooltip .v3-surface");
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  const rowBox = (await firstRow.boundingBox())!;
  const from = { x: rowBox.x + rowBox.width / 2, y: rowBox.y + rowBox.height / 2 };
  await page.mouse.move(from.x, from.y);
  await expect(tooltip.locator('[data-tooltip-field="ask"]')).toHaveText("첫 카드의 질문");
  const button = tooltip.getByRole("button", { name: "보류", exact: true });
  const buttonBox = (await button.boundingBox())!;
  const to = { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 };
  await page.mouse.move(to.x, to.y, { steps: 24 });
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('[data-tooltip-field="ask"]')).toHaveText("첫 카드의 질문");
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => answerRequests.length).toBe(1);
  expect(answerRequests[0]).toMatchObject({ cardId: ids[0], questionId: `question-${ids[0]}`, body: { answer: "보류" } });
  firstAnswerGate.release();
});

test("latest open question closes after one answer and long question stays unclamped with report-matching button gaps", async ({ page }) => {
  mkdirSync(output, { recursive: true });
  const { answerRequests, taskIds: ids } = await installPasTooltip(page, "dark");
  const tooltip = page.locator(".v3-persistent-task-tooltip .v3-surface");

  const multiRow = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[3]}']`);
  await multiRow.hover();
  await expect(tooltip.locator('[data-tooltip-field="ask"]')).toHaveText("가장 늦게 열린 질문");
  await tooltip.getByRole("button", { name: "함께 갱신", exact: true }).click();
  await expect.poll(() => answerRequests.length).toBe(1);
  expect(answerRequests[0]).toMatchObject({ cardId: ids[3], questionId: `question-${ids[3]}-latest`, body: { answer: "함께 갱신" } });
  await expect(tooltip).not.toBeVisible();
  await expect(page.locator(`[data-task-status-group='blocked'] [data-card-id='${ids[3]}']`)).toBeVisible();

  const longRow = page.locator(`[data-testid='persistent-session-task-list'] [data-card-id='${ids[4]}']`);
  await longRow.hover();
  await expect(tooltip.locator('[data-tooltip-field="ask"]')).toHaveText(LONG_QUESTION);
  const questionLayout = await tooltip.locator('[data-tooltip-field="ask"]').evaluate(element => {
    const style = getComputedStyle(element);
    return { lineCount: Math.round(element.clientHeight / parseFloat(style.lineHeight)),
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflow: style.overflow,
      webkitLineClamp: style.webkitLineClamp };
  });
  expect(LONG_QUESTION.length).toBeGreaterThanOrEqual(125);
  expect(questionLayout.lineCount).toBeGreaterThan(5);
  expect(questionLayout.scrollHeight).toBeLessThanOrEqual(questionLayout.clientHeight + 1);

  const actionGaps = await page.evaluate(() => {
    const gaps = (element: Element) => {
      const style = getComputedStyle(element);
      return { row: style.rowGap, column: style.columnGap };
    };
    return { tooltip: gaps(document.querySelector(".v3-persistent-task-tooltip .pas-report-actions")!),
      report: gaps(document.querySelector(".pas-report .pas-report-actions")!) };
  });
  expect(actionGaps.tooltip).toEqual(actionGaps.report);
  expect(actionGaps.tooltip).toEqual({ row: "4px", column: "8px" });
});

test("component-review tooltip samples use the operating 1440 row width", async ({ page }) => {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installChatUiRoutes(page, { example: "pas", ui: false, count: 3 });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: "검수" });
  await page.route("**/api/cards?**", route => route.fulfill({ json: { cards: [] } }));
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.goto("/components");
  const samples = page.getByTestId("persistent-task-tooltip-review-samples");
  await samples.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  const widths = await samples.locator("[data-tooltip-review-state]").evaluateAll(elements => elements.map(element =>
    Math.round(element.querySelector(".v3-surface")!.getBoundingClientRect().width)));
  expect(widths).toEqual([256, 256, 256, 256]);
  await samples.screenshot({ path: path.join(output, "review-samples-operating-width.png") });
});
