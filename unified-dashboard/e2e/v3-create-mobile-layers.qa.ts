import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BS_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-create-mobile-layers"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bs-v3-create-mobile-layers",
  timeoutMs: 240_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  return {
    desktop: await verifyViewport(browser, theme, { width: 1440, height: 1000 }, false),
    mobile: await verifyViewport(browser, theme, { width: 390, height: 844 }, true),
  };
}

async function verifyViewport(
  browser: Browser,
  theme: "dark" | "light",
  viewport: { width: number; height: number },
  mobile: boolean,
) {
  const context = await browser.newContext({ colorScheme: theme, reducedMotion: "reduce", viewport });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  let taskCreationRequests = 0;
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!text.includes("Failed to load resource: the server responded with a status of 401")) browserErrors.push(text);
  });
  await preparePage(page, theme, () => { taskCreationRequests += 1; });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    if (mobile) await verifyMobileProjects(page, theme);

    if (mobile) {
      await page.getByRole("tab", { name: "업무", exact: true }).click();
    } else {
      await page.getByTestId("v3-task-task-alpha").click();
    }
    await page.locator(".v3-workspace-scrim").waitFor({ state: "visible" });
    await page.keyboard.press("c");
    const createDialog = page.getByRole("dialog", { name: "새 업무" });
    await createDialog.waitFor({ state: "visible" });
    await createDialog.getByLabel("새 업무 제목").fill("401 피드백 회귀");
    const submit = createDialog.getByRole("button", { name: "업무 만들기" });
    await submit.evaluate((element) => { element.click(); element.click(); });
    await createDialog.getByRole("button", { name: "만드는 중…" }).waitFor({ state: "visible" });
    const failureAlert = createDialog.locator('[role="alert"]').filter({ hasText: "로그인이 만료되었습니다. 다시 로그인해 주세요" });
    try {
      await failureAlert.waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      const dialogText = await createDialog.isVisible() ? await createDialog.innerText() : "<detached>";
      throw new Error(`401 인라인 안내 대기 실패 · requests=${taskCreationRequests} · dialog=${dialogText}`);
    }
    assert(await failureAlert.count() === 1, "401 안내가 다이얼로그 안에 정확히 한 번 표시되지 않았습니다.");
    assert(taskCreationRequests === 1, `pending 중 생성 요청이 ${taskCreationRequests}건 발생했습니다.`);
    await assertLayer(page, "create-modal", "[data-slot=dialog-viewport]");

    await page.keyboard.press("Escape");
    await createDialog.waitFor({ state: "detached" });
    await assertLayer(page, "task-workspace", ".v3-workspace-scrim");
    await capture(page, theme, mobile, "01-task-workspace-toast");
    await page.getByRole("button", { name: "업무 상세 닫기" }).click();

    await page.getByRole("button", { name: "아침 정리", exact: true }).click();
    const ritual = page.getByRole("dialog", { name: "어제에서 넘어온 것" });
    await ritual.waitFor({ state: "visible" });
    for (let index = 0; index < 10; index += 1) {
      if (await ritual.locator(".v3-ritual-done").isVisible().catch(() => false)) break;
      await ritual.getByRole("button", { name: "미루기", exact: true }).click();
    }
    await ritual.getByRole("button", { name: /검수 대기/ }).waitFor({ state: "visible" });
    await assertLayer(page, "review-modal", "[data-slot=dialog-viewport]");
    await capture(page, theme, mobile, "02-review-toast");
    await page.getByRole("button", { name: "아침 정리 닫기" }).click();

    await page.getByRole("button", { name: "서버 설정" }).click();
    await page.getByRole("dialog", { name: /서버 설정/ }).waitFor({ state: "visible" });
    await assertLayer(page, "settings-modal", "[data-slot=dialog-viewport]");
    await capture(page, theme, mobile, "03-settings-toast");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "세션 기록 검색" }).waitFor({ state: "visible" });
    await assertLayer(page, "search-modal", "[data-slot=dialog-viewport]");
    await capture(page, theme, mobile, "04-search-toast");
    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);

    return {
      taskCreationRequests,
      inline401Visible: true,
      toastBodyPortal: true,
      layerOrder: ["panel", "overlay", "modal", "toast"],
      projectRoundtrip: mobile,
      browserErrors: browserErrors.length,
    };
  } finally {
    await context.close();
  }
}

async function verifyMobileProjects(page: Page, theme: string) {
  await page.getByRole("tab", { name: "프로젝트", exact: true }).click();
  const list = page.getByTestId("v3-mobile-project-list");
  await list.waitFor({ state: "visible" });
  await list.getByRole("button", { name: fixtureTitles.project, exact: true }).click();
  await page.locator(".v3-project-title h1").filter({ hasText: fixtureTitles.project }).waitFor({ state: "visible" });
  await capture(page, theme, true, "00-project-view");
  await page.getByRole("button", { name: "오늘로 돌아가기" }).click();
  await list.waitFor({ state: "visible" });
}

async function assertLayer(page: Page, label: string, targetSelector: string) {
  await page.waitForFunction(() => {
    const toast = document.querySelector<HTMLElement>(".v3-toast.is-visible");
    return toast !== null && getComputedStyle(toast).opacity === "1";
  });
  const metric = await page.evaluate(({ targetSelector }) => {
    const toast = document.querySelector<HTMLElement>(".v3-toast.is-visible");
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!toast || !target) return null;
    const toastRect = toast.getBoundingClientRect();
    return {
      toastZ: Number.parseInt(getComputedStyle(toast).zIndex, 10),
      targetZ: Number.parseInt(getComputedStyle(target).zIndex, 10),
      opacity: getComputedStyle(toast).opacity,
      parentIsBody: toast.parentElement === document.body,
      rect: toastRect.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, { targetSelector });
  assert(metric, `${label}: 레이어 측정 대상을 찾지 못했습니다.`);
  assert(metric.parentIsBody, `${label}: 토스트가 body 포털 밖에 있습니다.`);
  assert(metric.toastZ > metric.targetZ, `${label}: toast ${metric.toastZ} <= target ${metric.targetZ}`);
  assert(metric.opacity === "1", `${label}: 토스트 opacity가 ${metric.opacity}입니다.`);
  assert(metric.rect.left >= 0 && metric.rect.right <= metric.viewport.width, `${label}: 토스트가 가로 viewport를 벗어났습니다.`);
  assert(metric.rect.top >= 0 && metric.rect.bottom <= metric.viewport.height, `${label}: 토스트가 세로 viewport를 벗어났습니다.`);
}

async function preparePage(page: Page, theme: "dark" | "light", onCreate: () => void) {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (handler, timeout, ...args) => nativeSetTimeout(handler, timeout === 3200 ? 120000 : timeout, ...args);
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/auth/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { email: "qa@example.com", name: "QA" },
      }),
    });
  });
  await page.route("**/api/runbooks", async (route) => {
    onCreate();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Dashboard user is required" }),
    });
  });
}

async function capture(page: Page, theme: string, mobile: boolean, name: string) {
  const directory = path.join(outputRoot, theme, mobile ? "mobile" : "desktop");
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled" });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
