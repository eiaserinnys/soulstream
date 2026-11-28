import { expect, test, type Locator, type Page } from "./test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { DEFAULT_USER_PREFERENCES } from "../../packages/soul-ui/src/lib/user-preferences";

// 카드 #1735 항목 6: 앱(react-native-web 검수 번들)이 애플식 곡률 하나를 따르는지 계산 스타일로 확인한다.
// 검수 창 호스트(/components/ios, /dialogues/ios)가 iframe으로 띄우는 것과 같은 산출물을 쓴다.
const bundlePrefix = "/assets/ios-components/";
const bundleIndex = `${bundlePrefix}index.html`;
const here = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.resolve(here, "../dist/assets/ios-components");
// 격리 세션에서는 워크스페이스 .local/card1735가 읽기 전용이라 쓰기 가능한 .local/tmp에 찍고,
// 검수 뒤 카드 산출물 경로(.local/card1735/apple-radius-app)로 옮긴다.
const output = path.resolve(here, "../../../../.local/tmp/card1735/apple-radius-app");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

type Corners = { tl: number; tr: number; bl: number; br: number; width: number; height: number };

async function cornersOf(locator: Locator): Promise<Corners> {
  return locator.first().evaluate((element) => {
    const style = getComputedStyle(element);
    const box = (element as HTMLElement).getBoundingClientRect();
    return {
      tl: parseFloat(style.borderTopLeftRadius),
      tr: parseFloat(style.borderTopRightRadius),
      bl: parseFloat(style.borderBottomLeftRadius),
      br: parseFloat(style.borderBottomRightRadius),
      width: box.width,
      height: box.height,
    };
  });
}

function expectEqualCorners(corners: Corners, radius: number): void {
  for (const value of [corners.tl, corners.tr, corners.bl, corners.br]) {
    expect(Math.abs(value - radius)).toBeLessThanOrEqual(0.5);
  }
}

function softEqualCorners(corners: Corners, radius: number, label: string): void {
  for (const value of [corners.tl, corners.tr, corners.bl, corners.br]) {
    expect.soft(Math.abs(value - radius), `${label}: 모서리 ${value} != ${radius}`).toBeLessThanOrEqual(0.5);
  }
}

function softPill(corners: Corners, label: string): void {
  expect.soft(corners.tl, `${label}: 곡률 ${corners.tl} < 높이/2 ${corners.height / 2}`)
    .toBeGreaterThanOrEqual(corners.height / 2 - 0.5);
}

async function serveBundle(page: Page): Promise<void> {
  await page.route(`**${bundlePrefix}**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = decodeURIComponent(pathname.slice(bundlePrefix.length)) || "index.html";
    const file = path.join(bundleDir, relative);
    if (!existsSync(file)) return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    return route.fulfill({
      status: 200,
      contentType: MIME[path.extname(file)] ?? "application/octet-stream",
      body: readFileSync(file),
    });
  });
}

async function prepare(page: Page, viewport: { width: number; height: number }): Promise<void> {
  expect(
    existsSync(path.join(bundleDir, "index.html")),
    "검수 번들이 없습니다. soul-app에서 npm run export:components를 먼저 실행합니다.",
  ).toBe(true);
  mkdirSync(output, { recursive: true });
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  // ios-components-host.e2e.ts와 같은 셸 준비. 오케스트레이터 연결 안내창이 화면을 덮지 않게 한다.
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/health", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ healthy: true, ready: true, draining: false, build_id: "dev" }) }));
  await page.route("**/api/cards?**", (route) => route.fulfill({ contentType: "application/json", body: '{"cards":[]}' }));
  await page.route("**/api/user/preferences", (route) => {
    const preferences = { ...DEFAULT_USER_PREFERENCES, appearance: "dark",
      glass: { ...DEFAULT_USER_PREFERENCES.glass, enabled: false } };
    return route.fulfill({
      status: route.request().method() === "GET" ? 200 : 405,
      contentType: "application/json",
      body: JSON.stringify({ email: "qa@example.test", preferences,
        hasBackground: false, backgroundUrl: null, updatedAt: null }),
    });
  });
  await page.route("**/api/auth/config", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
  await serveBundle(page);
}

async function openReview(page: Page, route: string): Promise<{ review: Locator; bundle: ReturnType<Page["frameLocator"]> }> {
  await page.goto(route);
  const review = page.getByTestId("ios-components-review");
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review.locator("iframe")).toBeVisible({ timeout: 30_000 });
  const bundle = page.frameLocator("iframe");
  await expect(bundle.getByTestId("component-review")).toBeVisible({ timeout: 60_000 });
  await bundle.locator("body").evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  return { review, bundle };
}

async function openSection(page: Page, bundle: ReturnType<Page["frameLocator"]>, section: string): Promise<void> {
  await bundle.getByTestId(`settings-segment-review-section-${section}`).click();
  await page.waitForTimeout(300);
}

async function settleBundle(page: Page): Promise<void> {
  await page.locator("body").evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

test("행·입력 칸·세그먼트·말풍선·채팅 입력 상자가 애플식 곡률 하나를 따른다", async ({ page }) => {
  await prepare(page, { width: 430, height: 1600 });
  const { bundle } = await openReview(page, "/components/ios");
  const review = page.getByTestId("ios-components-review");

  // 바탕 위 카드와 행은 틀 곡률 24.
  expectEqualCorners(await cornersOf(bundle.getByTestId("card-row-public-todo")), 24);
  await bundle.getByTestId("review-card-rows").screenshot({ path: path.join(output, "components-ios-rows.png") });

  // 입력 칸은 동심 12, 세그먼트 트랙과 단추는 알약.
  await openSection(page, bundle, "settings");
  await expect(bundle.getByTestId("settings-server-input")).toBeVisible();
  expectEqualCorners(await cornersOf(bundle.getByTestId("settings-server-input")), 12);
  const track = await cornersOf(bundle.getByTestId("settings-segment-server-track"));
  expect(track.tl).toBeGreaterThanOrEqual(track.height / 2 - 0.5);
  const secondary = await cornersOf(bundle.getByTestId("settings-test-connection-surface"));
  expect(secondary.tl).toBeGreaterThanOrEqual(secondary.height / 2 - 0.5);
  await bundle.getByTestId("settings-section-connection").screenshot({ path: path.join(output, "components-ios-settings.png") });

  // 표면 섹션: 유리 패널 틀은 24, 안쪽 조밀 표면은 동심 12.
  await openSection(page, bundle, "surfaces");
  expectEqualCorners(await cornersOf(bundle.getByTestId("review-surface-glassSoft")), 24);
  expectEqualCorners(await cornersOf(bundle.getByTestId("review-surface-glassDense")), 12);
  await bundle.getByTestId("review-surfaces-glass").screenshot({ path: path.join(output, "components-ios-surfaces.png") });

  // 대화: 말풍선 네 모서리 12, 채팅 입력 상자는 한 줄 높이의 절반.
  await openSection(page, bundle, "chat");
  const userBubble = bundle.getByTestId("user-message-bubble").first();
  await expect(userBubble).toBeVisible();
  expectEqualCorners(await cornersOf(userBubble), 12);
  const assistantBubble = bundle.getByTestId("assistant-message-bubble").first();
  await expect(assistantBubble).toBeVisible();
  expectEqualCorners(await cornersOf(assistantBubble), 12);

  const composerGroup = bundle.getByTestId("review-chat-composer-input-group");
  const composer = composerGroup.getByTestId("chat-composer-box").first();
  const singleLine = await cornersOf(composer);
  // 한 줄 높이는 composer.minHeight 56이고 곡률은 그 절반 28이다.
  expect(Math.abs(singleLine.height / 2 - 28)).toBeLessThanOrEqual(0.5);
  expectEqualCorners(singleLine, 28);
  await composerGroup.screenshot({ path: path.join(output, "review-chat-composer-empty.png") });

  await composerGroup.getByTestId("chat-composer-text-input").fill("첫 줄\n둘째 줄");
  await page.waitForTimeout(200);
  const multiline = await cornersOf(composer);
  expect(multiline.height).toBeGreaterThan(singleLine.height);
  expect(Math.abs(multiline.tl - singleLine.tl)).toBeLessThanOrEqual(0.5);
  expectEqualCorners(multiline, 28);
  await composerGroup.screenshot({ path: path.join(output, "review-chat-composer-multiline.png") });

  const embedded = bundle.getByTestId("review-chat-composer-embedded");
  await expect(embedded).toBeVisible();
  const embeddedCorners = await cornersOf(embedded.getByTestId("chat-composer-box"));
  expectEqualCorners(embeddedCorners, 28);
  await embedded.screenshot({ path: path.join(output, "review-chat-composer-embedded.png") });

  await userBubble.screenshot({ path: path.join(output, "user-bubble.png") });
  await assistantBubble.screenshot({ path: path.join(output, "assistant-bubble.png") });
  await bundle.getByTestId("review-chat-bubbles").screenshot({ path: path.join(output, "components-ios-chat.png") });
  await expect(review).toBeVisible();
});

test("다이얼로그 검수 창도 같은 검수 번들을 같은 곡률로 띄운다", async ({ page }) => {
  await prepare(page, { width: 430, height: 1200 });
  await page.goto("/dialogues/ios");
  await expect(page.getByRole("heading", { name: "폴더 제목 편집" })).toBeVisible();
  const cell = page.locator(".v3-dialogue-cell").first();
  await expect(cell).toBeVisible({ timeout: 30_000 });
  const frameElement = cell.locator("iframe");
  await expect(frameElement).toBeVisible({ timeout: 30_000 });
  await expect(frameElement).toHaveAttribute("src", /\/assets\/ios-components\/index\.html\?.*section=dialogues/);
  // body not empty는 늘 통과한다. iframe 안 첫 [data-testid]가 뜬 뒤에 찍는다.
  const frame = cell.frameLocator("iframe");
  await expect(frame.locator("[data-testid]").first()).toBeVisible({ timeout: 60_000 });
  await frame.locator("body").evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await cell.screenshot({ path: path.join(output, "dialogues-ios.png") });
  await page.screenshot({ path: path.join(output, "dialogues-ios-page.png") });
});

// 세라피엘 화면 검수 반려(8167a407)가 지목한 여섯 자리. 고치기 전 머리 29553be7에서 실패하는 것을 남기고 고친다.
test("반려된 여섯 자리가 요소 역할대로 알약·틀·동심을 따른다", async ({ page }) => {
  await prepare(page, { width: 430, height: 1400 });

  // 1. 반복 작업 편집: 반복 방식 칩과 「시각 추가」·「삭제」는 알약, 달력 칸과 시각 입력은 그대로.
  await page.goto(`${bundleIndex}?section=nativeSettings&safeArea=fixture&theme=light`);
  await expect(page.getByTestId("native-settings-review")).toBeVisible({ timeout: 60_000 });
  await settleBundle(page);
  const sidebarGroup = page.locator('[data-testid="settings-category-sidebar"] [data-testid="settings-category-recurring-jobs"]').first().locator("..");
  const sidebarCorners = await cornersOf(sidebarGroup);
  softEqualCorners(sidebarCorners, 24, "3. 설정 첫 화면 분류 묶음");
  await page.getByTestId("settings-category-sidebar").screenshot({ path: path.join(output, "settings-first-screen.png") });

  await page.getByTestId("settings-category-recurring-jobs").first().click();
  await page.getByText("새 작업", { exact: true }).first().click();
  const picker = page.getByTestId("recurring-schedule-picker");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  const modeDaily = await cornersOf(picker.getByTestId("recurring-schedule-mode-daily"));
  softPill(modeDaily, "1. 반복 방식 칩 「매일」");
  softPill(await cornersOf(picker.getByTestId("recurring-schedule-add-time")), "1. 「시각 추가」");
  await picker.getByTestId("recurring-schedule-add-time").click();
  await page.waitForTimeout(150);
  softPill(await cornersOf(picker.getByRole("button", { name: "삭제", exact: true })), "1. 「삭제」");
  await page.getByTestId("recurring-schedule-mode-monthly").click();
  await page.waitForTimeout(150);
  softEqualCorners(await cornersOf(page.getByTestId("recurring-schedule-month-day-1")), 12, "달력 칸");
  softEqualCorners(await cornersOf(page.getByTestId("recurring-schedule-time-0")), 12, "실행 시각 입력");
  await page.getByTestId("recurring-schedule-picker").screenshot({ path: path.join(output, "recurring-editor-light.png") });

  // 2. 진단 세션 만들기 단추는 알약.
  await page.goto(`${bundleIndex}?section=dialogues&sample=session-diagnostic&theme=dark`);
  const diagnostic = page.getByRole("button", { name: "진단 세션 만들기" });
  await expect(diagnostic).toBeVisible({ timeout: 60_000 });
  await settleBundle(page);
  softPill(await cornersOf(diagnostic), "2. 「진단 세션 만들기」");

  // 3. PAS 판은 바탕 위 틀 24, 안의 단추는 알약 그대로.
  await page.goto(`${bundleIndex}?section=pasCardExpand&theme=dark`);
  const decks = page.getByTestId("report-deck");
  await expect(decks.first()).toBeVisible({ timeout: 60_000 });
  await settleBundle(page);
  const deckCount = await decks.count();
  for (let index = 0; index < deckCount; index += 1) {
    softEqualCorners(await cornersOf(decks.nth(index)), 24, `4. PAS 판 ${index + 1}`);
  }
  await decks.first().screenshot({ path: path.join(output, "pas-deck.png") });

  // 5. 포스트잇 질문 미리보기는 동심 12, 포스트잇 12는 그대로.
  await page.goto(`${bundleIndex}?section=postit&theme=dark`);
  const askFull = page.getByTestId("postit-review-checks-full-ask-preview");
  await expect(askFull).toBeVisible({ timeout: 60_000 });
  await settleBundle(page);
  softEqualCorners(await cornersOf(askFull), 12, "5. 포스트잇 질문 미리보기 full");
  softEqualCorners(await cornersOf(page.getByTestId("postit-review-checks-compact-ask-preview")), 12, "5. 포스트잇 질문 미리보기 compact");
  await page.getByTestId("postit-checks-comparison").screenshot({ path: path.join(output, "postit-ask-preview.png") });

  // 6. 큰 폼 선택 트리거는 동심 12, 기본 변형의 작은 칩은 알약. chat 변형 칩은 그대로 알약.
  await page.goto(`${bundleIndex}?section=dialogues&sample=settings-target&theme=dark`);
  const trigger = page.getByRole("button", { name: /실행 노드/ });
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await settleBundle(page);
  softEqualCorners(await cornersOf(trigger), 12, "6. 폼 선택 트리거");
  await trigger.screenshot({ path: path.join(output, "settings-option-trigger.png") });

  await page.goto(`${bundleIndex}?section=chatUi&theme=dark`);
  await expect(page.getByTestId("settings-default-primitives")).toBeVisible({ timeout: 60_000 });
  await settleBundle(page);
  softPill(await cornersOf(page.getByRole("button", { name: "첫 번째", exact: true })), "6. 기본 변형 작은 칩");
  softPill(await cornersOf(page.getByRole("button", { name: "결제 주기: 월간" })), "6. chat 변형 칩(그대로)");
  await page.getByTestId("settings-default-primitives").screenshot({ path: path.join(output, "settings-option-chip.png") });
});
