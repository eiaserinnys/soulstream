import { expect, test, type Page } from "./test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { openV3Home, openV3Folder } from "./v3-qa-entry";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_POLISH_OUTPUT ?? path.join("e2e", "screenshots", "v3-polish-round2"),
);

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  test(`v3 polish round 2 · ${theme} · desktop`, async ({ page }) => {
    // 공유 호스트 부하에서 캡처·표면 측정이 180초를 넘겨 이 테스트만 실패했다
    // (2026-11-18 실측: 같은 테스트가 156초 통과, 부하 시 180초 초과). 단언은
    // 그대로 두고 테스트 상한만 늘린다.
    test.setTimeout(300_000);
    await preparePage(page, theme, false);
    await openV3Home(page, BASE_URL);

    await setWebgl(page, true);
    await expectGlobalToolbarChrome(page);
    await capture(page, theme, "00-v3-dashboard-toolbar");

    await setWebgl(page, false);

    await openV3Folder(page, BASE_URL);
    await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("v3-task-task-alpha").click();
    await expect(page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask })).toBeVisible({ timeout: 30_000 });

    // 지침 블록도 같은 공유 표면 클래스를 쓴다. 폴더 설명은 첫 번째다.
    const description = page.locator(".v3-description-preview").first();
    await expect(description).toHaveCSS("text-align", "left");
    await expect(description).toHaveCSS("align-items", /^(flex-)?start$/);
    await expect(description).toHaveCSS("justify-content", /^(normal|(flex-)?start)$/);
    await expect(page.getByRole("button", { name: "재개" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /요약$/ })).toHaveCount(0);
    // 인라인 폴더 패널은 유리 표면이 아니다. 유리는 채팅 작업 공간에서 검사한다.
    await capture(page, theme, "02-task-detail");

    // 폴더는 이제 오버레이가 아니라 가운데 인라인 패널로 열린다. 뒤로 가기는
    // 상위 폴더 버튼이 맡는다.
    await page.getByRole("button", { name: "상위 폴더로 이동" }).click();
    await expect(page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.project })).toBeVisible();
    await page.getByTestId("v3-task-task-alpha").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-home")).toBeVisible();
    await openV3Folder(page, BASE_URL);
    await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("v3-task-task-alpha").click();
    await page.locator(".v3-detail-pane .v3-run-open").filter({ hasText: "시각 QA 순회" }).click();
    await expect(page.locator(".v3-chat-pane")).toBeVisible();
    await setWebgl(page, true);
    const scrim = page.locator(".v3-workspace-scrim");
    await expect(scrim).toHaveCSS("backdrop-filter", /blur\(/);
    const scrimBackground = await scrim.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(scrimBackground).not.toBe("rgba(0, 0, 0, 0)");
    const chatSurface = await page.locator(".v3-chat-pane").evaluate((element) => ({
      actual: getComputedStyle(element).getPropertyValue("--glass-chrome-surface-strong").trim(),
      expected: getComputedStyle(document.documentElement).getPropertyValue("--lg-chat-panel").trim(),
    }));
    expect(chatSurface.actual).toBe(chatSurface.expected);
    await capture(page, theme, "03-chat-expanded");
  });
}

async function setWebgl(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((nextEnabled) => {
    localStorage.setItem("ls.webglGlass", nextEnabled ? "1" : "0");
    window.dispatchEvent(new Event("ls.webglGlass:change"));
  }, enabled);
}

test("v3 global toolbar reuses live search, config, and theme controls", async ({ page }) => {
  test.setTimeout(90_000);
  await preparePage(page, "dark", false);
  await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("card-home")).toBeVisible();
  await expectGlobalToolbarInteractions(page);
});

async function preparePage(page: Page, theme: Theme, webgl = true): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(({ appearance, webglEnabled }: { appearance: Theme; webglEnabled: boolean }) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("ls.webglGlass", webglEnabled ? "1" : "0");
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
  }, { appearance: theme, webglEnabled: webgl });
  await installV3VisualQaRoutes(page);
}

async function expectGlobalToolbarChrome(page: Page): Promise<void> {
  const toolbar = page.getByTestId("v3-global-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByText("Soulstream", { exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "세션 검색 열기" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "설정", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: /^(라이트|다크) 모드로 전환$/ })).toBeVisible();
}

async function expectGlobalToolbarInteractions(page: Page): Promise<void> {
  const toolbar = page.getByTestId("v3-global-toolbar");
  const searchButton = toolbar.getByRole("button", { name: "세션 검색 열기" });
  await searchButton.click();
  await expect(page.getByRole("heading", { name: "세션 기록 검색" })).toBeVisible();
  // 단추로 열면 검색 입력에 초점이 있고, Esc로 닫으면 연 단추로 초점이 돌아온다.
  await expect(page.locator('[data-slot="dialog-popup"] input[placeholder="검색어를 입력하세요..."]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(searchButton).toBeFocused();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("heading", { name: "세션 기록 검색" })).toBeVisible();
  await page.keyboard.press("Escape");

  await toolbar.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeVisible();

  const html = page.locator("html");
  const wasDark = await html.evaluate((element) => element.classList.contains("dark"));
  const themeToggle = toolbar.getByRole("button", { name: /^(라이트|다크) 모드로 전환$/ });
  await themeToggle.dispatchEvent("click");
  await expect.poll(() => html.evaluate((element) => element.classList.contains("dark"))).toBe(!wasDark);
  await toolbar.getByRole("button", { name: /^(라이트|다크) 모드로 전환$/ }).dispatchEvent("click");
  await expect.poll(() => html.evaluate((element) => element.classList.contains("dark"))).toBe(wasDark);
}

async function capture(page: Page, theme: Theme, state: string): Promise<void> {
  const outputDir = path.join(OUTPUT_ROOT, theme);
  mkdirSync(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, `${state}.png`),
    fullPage: false,
    animations: "disabled",
  });
}
