import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { DEFAULT_USER_PREFERENCES } from "../../packages/soul-ui/src/lib/user-preferences";

// 카드 #1735 항목 6: 앱(react-native-web 검수 번들)이 애플식 곡률 하나를 따르는지 계산 스타일로 확인한다.
// 검수 창 호스트(/components/ios, /dialogues/ios)가 iframe으로 띄우는 것과 같은 산출물을 쓴다.
const origin = "http://127.0.0.1:4318";
const bundlePrefix = "/assets/ios-components/";
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

type Corners = { tl: number; tr: number; bl: number; br: number; height: number };

async function cornersOf(locator: Locator): Promise<Corners> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = (element as HTMLElement).getBoundingClientRect();
    return {
      tl: parseFloat(style.borderTopLeftRadius),
      tr: parseFloat(style.borderTopRightRadius),
      bl: parseFloat(style.borderBottomLeftRadius),
      br: parseFloat(style.borderBottomRightRadius),
      height: box.height,
    };
  });
}

function expectEqualCorners(corners: Corners, radius: number): void {
  for (const value of [corners.tl, corners.tr, corners.bl, corners.br]) {
    expect(Math.abs(value - radius)).toBeLessThanOrEqual(0.5);
  }
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
  await page.goto(`${origin}${route}`);
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
  await page.goto(`${origin}/dialogues/ios`);
  await expect(page.getByRole("heading", { name: "폴더 제목 편집" })).toBeVisible();
  const frameElement = page.locator("iframe").first();
  await expect(frameElement).toBeVisible({ timeout: 30_000 });
  await expect(frameElement).toHaveAttribute("src", /\/assets\/ios-components\/index\.html\?.*section=dialogues/);
  const frame = page.frameLocator("iframe").first();
  await expect(frame.locator("body")).not.toBeEmpty({ timeout: 60_000 });
  await page.screenshot({ path: path.join(output, "dialogues-ios.png") });
});
