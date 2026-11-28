// 카드 #1735 후속: 좁은 폭(390) 채팅에서 전역 도구 막대가 투명한 유리 팬 뒤로 비치지 않는지 판정한다.
// - 390, WebGL 켬/끔: 프로젝트 화면에서 막대가 보이고(a), 채팅을 열면 막대가 숨으며 제목 상자 가운데가
//   채팅 머리 안 요소이고(b), 프로젝트 탭으로 돌아가면 막대가 다시 보인다(c).
// - 1440 켬: 데스크톱은 고치지 않으므로 막대가 그대로 보이는지와 누출 여부를 캡처로 남긴다.
// - 390 켬/끔 카드 작업 공간: 픽스처 카드로 열어 막대와 .v3-main이 숨고, 모바일 탭과 카드 작업 공간이
//   보이는지 확인한다. 카드를 닫으면 .v3-main과 막대가 다시 보인다. 카드 상세는 시험 안에서 채운다.
// 실행: corepack pnpm --dir unified-dashboard exec playwright test --config e2e/radius-glass.config.ts mobile-chat-glass-toolbar
import { expect, test, type Locator, type Page } from "./test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { prepare } from "./glass-review-helpers";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.CHAT390_FIX_OUT ?? path.resolve(REPO_ROOT, ".local/card1735/chat390-fix");
mkdirSync(OUT, { recursive: true });

const TOOLBAR = "[data-testid=v3-global-toolbar]";
const LIVE_TEXT = "채팅의 기존 본문과 입력창입니다.";
// 픽스처(/api/cards 목록)가 싣는 카드와 같은 값. 상세 경로(/api/cards/:id)가 없어 생기던
// 「reading 'version'」 오류를 이 시험 안에서 채운 상세 응답으로 없앤다.
const CARD_ID = "p1-card-folder-display";
const CARD_DETAIL = {
  card: {
    id: CARD_ID,
    folderId: "folder-amber",
    title: "P1 카드 표시",
    request: "",
    brief: "",
    status: "running",
    blockedKind: null,
    blockedDetail: null,
    positionKey: "a",
    queuePositionKey: null,
    assigneeKind: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    assigneeSessionId: null,
    nodeId: null,
    modelPreset: null,
    version: 1,
    archived: false,
    createdAt: "2026-07-14T01:30:00.000Z",
    updatedAt: "2026-07-14T01:30:00.000Z",
  },
  reports: [],
  questions: [],
  sessions: [],
  comments: [],
  notes: [],
  nowHistory: [],
};
// 픽스처에 스토리 경로가 없어 시험 안에서 채운다. 패널이 잘리지 않는지 경계와 함께 글이 보이는지 본다.
const STORY = {
  highlight: "스토리 하이라이트: 390 채팅 머리에서 패널이 화면 안에 들어옵니다.",
  narrative: Array.from(
    { length: 8 },
    (_, index) => `스토리 구간 ${index + 1}: 패널 본문이 화면 안에서 잘리지 않고 읽힙니다.`,
  ).join("\n\n"),
  unfolded_turn_summaries: [],
  narrative_through_event_id: 80,
  fold_count: 1,
  updated_at: "2026-11-20T00:00:00.000Z",
};

async function openRoot(page: Page, width: number) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".v3-planner-column, [data-testid=card-home]").first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  if (width < 760) {
    await page.getByTestId("v3-mobile-tab-projects").click();
  }
}

async function openSoulstreamProject(page: Page, width: number) {
  if (width < 760) {
    await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click();
  } else {
    await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
  }
  await expect(page.locator("[data-task-section=sessions] .v3-run-row").first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1200);
}

async function openChat(page: Page) {
  await page.locator("[data-task-section=sessions] .v3-run-open").first().click();
  await expect(page.locator(".v3-chat-pane [data-slot=chat-input-body]")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2500);
}

async function openStory(page: Page) {
  await page.route(/\/api\/sessions\/[^/]+\/story(?:\?|$)/, (route) => route.fulfill({ json: STORY }));
  const trigger = page.getByTestId("session-story-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const panel = page.getByTestId("session-story-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("스토리 구간 1");
  // SwiftShader에서는 rAF가 초당 1번 남짓이라 시작 전환의 opacity 0에서 찍히면 패널이 빈다.
  // 캡처와 상자·바탕 단언 전에 시작 전환이 끝나고 opacity가 1이 될 때까지 기다린다.
  await expect(panel).not.toHaveAttribute("data-starting-style", undefined, { timeout: 30_000 });
  await expect(panel).toHaveCSS("opacity", "1", { timeout: 30_000 });
  // 위치 계산이 끝난 뒤의 상자를 재도록 잠깐 둔다.
  await page.waitForTimeout(500);
  return panel;
}

// 포털로 body에 붙은 패널의 계산 바탕색 알파. color-mix 결과가 rgba()나 color(srgb ...)로 온다.
async function panelBackgroundAlpha(panel: Locator): Promise<number> {
  const color = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
  const rgba = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(/[,\s/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }
  const srgb = color.match(/^color\(srgb ([^)]+)\)$/);
  if (srgb) {
    const parts = srgb[1].split(/[\s/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }
  throw new Error(`패널 바탕색을 해석하지 못했습니다: ${color}`);
}

async function titleCenterHit(page: Page) {
  return page.locator(".v3-chat-pane .v3-chat-header .v3-chat-session-title strong").first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      insideChatHeader: Boolean(hit?.closest(".v3-chat-header")),
      hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 80)}` : null,
    };
  });
}

for (const webgl of [true, false]) {
  test(`390 채팅 머리와 전역 도구 막대 (WebGL ${webgl ? "켬" : "끔"})`, async ({ page }) => {
    test.setTimeout(300_000);
    await prepare(page, 390, webgl, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: LIVE_TEXT });
    await page.route("**/api/cards?**", (r) => r.fulfill({ json: { cards: [] } }));
    await openRoot(page, 390);
    // a. 채팅을 열기 전 프로젝트 화면에서는 막대가 보인다.
    await expect(page.locator(TOOLBAR)).toBeVisible();
    await openSoulstreamProject(page, 390);
    await page.screenshot({ path: path.join(OUT, `projects-390-webgl${webgl ? 1 : 0}.png`), animations: "disabled" });
    await openChat(page);

    // b. 채팅을 연 뒤: 막대는 숨고, 제목은 보이며, 제목 상자 가운데는 채팅 머리 안 요소다.
    await expect(page.locator(TOOLBAR)).toBeHidden();
    const title = page.locator(".v3-chat-pane .v3-chat-header .v3-chat-session-title strong").first();
    await expect(title).toBeVisible();
    const hit = await titleCenterHit(page);
    expect(hit.insideChatHeader, `제목 상자 가운데에서 만난 요소가 채팅 머리 밖입니다: ${hit.hit}`).toBe(true);
    await page.screenshot({
      path: path.join(OUT, `chat-390-webgl${webgl ? 1 : 0}-header.png`),
      clip: { x: 0, y: 0, width: 390, height: 180 },
      animations: "disabled",
    });

    // c. 모바일 탭 프로젝트로 돌아가면 막대가 다시 보인다.
    await page.getByTestId("v3-mobile-tab-projects").click();
    await expect(page.locator(TOOLBAR)).toBeVisible();
    await expect(page.getByTestId("v3-mobile-project-list")).toBeVisible();
  });
}

for (const webgl of [true, false]) {
  test(`390 스토리 패널 (WebGL ${webgl ? "켬" : "끔"})`, async ({ page }) => {
    test.setTimeout(300_000);
    await prepare(page, 390, webgl, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: LIVE_TEXT });
    await openRoot(page, 390);
    await openSoulstreamProject(page, 390);
    await openChat(page);
    const panel = await openStory(page);
    const box = await panel.boundingBox();
    expect(box, "스토리 패널 상자를 읽지 못했습니다").not.toBeNull();
    // 모바일 채팅 머리 좌우 여백과 같은 14px에 맞춘다(폭 calc(100vw-1.75rem)).
    // 고치기 전(afc3d0eb)에는 폭이 calc(100vw-2rem)이라 오른쪽 여백이 18이었다(오른쪽 372).
    expect.soft(Math.abs(box!.x - 14), `패널 왼쪽이 14가 아닙니다: ${box!.x}`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(box!.x + box!.width - 376), `패널 오른쪽이 376이 아닙니다: ${box!.x + box!.width}`).toBeLessThanOrEqual(1);
    // 켬에서는 포털이 .v3-chat-pane의 glass-chrome 범위를 벗어나므로 팝오버 기본 바탕을 받아야 한다.
    if (webgl) {
      const alpha = await panelBackgroundAlpha(panel);
      expect.soft(alpha, `패널 바탕 알파가 0.85보다 묽습니다: ${alpha}`).toBeGreaterThanOrEqual(0.85);
    }
    await page.screenshot({ path: path.join(OUT, `chat-390-webgl${webgl ? 1 : 0}-story.png`), animations: "disabled" });
  });
}

test("1440 스토리 패널 (WebGL 켬)", async ({ page }) => {
  test.setTimeout(300_000);
  await prepare(page, 1440, true, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: LIVE_TEXT });
  await openRoot(page, 1440);
  await openSoulstreamProject(page, 1440);
  await openChat(page);
  const panel = await openStory(page);
  const box = await panel.boundingBox();
  expect(box, "스토리 패널 상자를 읽지 못했습니다").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  // 패널 안쪽 왼쪽 위가 패널 안 요소에 닿아야 한다(채팅 팬에 잘리지 않음).
  const hit = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + 16, rect.top + 16);
    return Boolean(target && element.contains(target));
  });
  expect(hit, "패널 안쪽 왼쪽 위가 패널 밖 요소에 닿았습니다(팬에 잘림)").toBe(true);
  const alpha = await panelBackgroundAlpha(panel);
  expect.soft(alpha, `패널 바탕 알파가 0.85보다 묽습니다: ${alpha}`).toBeGreaterThanOrEqual(0.85);
  await page.screenshot({ path: path.join(OUT, "chat-1440-webgl1-story.png"), animations: "disabled" });
});

test("1440 채팅 머리와 전역 도구 막대 (WebGL 켬)", async ({ page }) => {
  test.setTimeout(300_000);
  await prepare(page, 1440, true, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: LIVE_TEXT });
  await page.route("**/api/cards?**", (r) => r.fulfill({ json: { cards: [] } }));
  await openRoot(page, 1440);
  await openSoulstreamProject(page, 1440);
  await openChat(page);
  // 데스크톱은 고치지 않는다. 막대는 계속 보이고, 누출 여부는 캡처로 판정한다.
  await expect(page.locator(TOOLBAR)).toBeVisible();
  // 이 전체 캡처를 잘라 chat-1440-webgl1-header.png(머리 확대)를 만든다. 요소·클립 캡처는
  // 스트림 표시로 머리 상자가 흔들리거나 헤드리스 합성 지연으로 멈추는 경우가 있어 쓰지 않는다.
  await page.screenshot({ path: path.join(OUT, "chat-1440-webgl1.png"), animations: "disabled" });
});

for (const webgl of [true, false]) {
  test(`390 카드 작업 공간 (WebGL ${webgl ? "켬" : "끔"})`, async ({ page }) => {
    test.setTimeout(300_000);
    await prepare(page, 390, webgl, { unifiedFolderView: true, timelineEventCount: 1 });
    // 목록 픽스처에 없는 카드 상세를 채워 카드 팬을 오류 없이 연다(v3-visual-fixtures.ts의 목록 응답 모양을 따른다).
    await page.route(/\/api\/cards\/p1-card-folder-display(?:\?|$)/, (route) => route.fulfill({ json: CARD_DETAIL }));
    await openRoot(page, 390);
    await openSoulstreamProject(page, 390);
    const cardButton = page.getByRole("button", { name: "카드 P1 카드 표시 열기" });
    await expect(cardButton).toBeVisible({ timeout: 120_000 });
    const detailResponse = page.waitForResponse((response) => (
      /\/api\/cards\/p1-card-folder-display(?:\?|$)/.test(response.url()) && response.request().method() === "GET"
    ));
    await cardButton.click();
    await detailResponse;
    await expect(page.getByTestId("v3-card-workspace")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    // 카드 작업 공간이 열린 뒤: 스크림 아래 화면(.v3-main)과 막대는 숨고, 탭과 작업 공간은 보인다.
    await expect(page.locator(TOOLBAR)).toBeHidden();
    await expect(page.locator(".v3-main")).toBeHidden();
    await expect(page.locator(".v3-mobile-tabs")).toBeVisible();
    await expect(page.getByTestId("v3-card-workspace")).toBeVisible();
    await expect(page.locator("[data-testid=card-detail] .v3-card-error")).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, `card-workspace-390-webgl${webgl ? 1 : 0}.png`), animations: "disabled" });
    await page.screenshot({
      path: path.join(OUT, `card-workspace-390-webgl${webgl ? 1 : 0}-head.png`),
      clip: { x: 0, y: 0, width: 390, height: 180 },
      animations: "disabled",
    });

    // 뒤로 단추로 닫으면 아래 화면과 막대가 다시 보인다.
    await page.getByRole("button", { name: "카드 닫기" }).click();
    await expect(page.getByTestId("v3-card-workspace")).toHaveCount(0);
    await expect(page.locator(".v3-main")).toBeVisible();
    await expect(page.locator(TOOLBAR)).toBeVisible();
  });
}
