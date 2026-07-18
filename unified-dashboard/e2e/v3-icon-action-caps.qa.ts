import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BJ_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-icon-action-caps"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bj-v3-icon-action-caps",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-alpha").waitFor({ state: "visible", timeout: 20_000 });

    const todayCaps = await auditVisibleCaps(page);
    assert(todayCaps.length >= 8, `오늘 화면 아이콘 캡이 ${todayCaps.length}개뿐입니다.`);
    await assertPressedToggle(page.getByTestId("v3-task-alpha").locator('[data-slot="dashboard-icon-cap"]'));
    await capture(page, theme, "01-today-actions");

    await page.getByRole("button", { name: fixtureTitles.project, exact: true }).click();
    await page.getByRole("button", { name: "새 문서" }).waitFor({ state: "visible" });
    const projectCaps = await auditVisibleCaps(page);
    for (const label of ["오늘로 돌아가기", "새 문서"]) {
      assert(projectCaps.some((cap) => cap.label === label), `${label} 아이콘 캡이 없습니다.`);
    }
    await capture(page, theme, "02-project-actions");

    await page.getByRole("button", { name: "오늘로 돌아가기" }).click();
    await page.getByTestId("v3-task-alpha").click();
    const detail = page.locator(".v3-detail-pane").first();
    await detail.getByTestId("v3-task-checklist").waitFor({ state: "visible" });
    await detail.getByTestId("v3-inline-board").waitFor({ state: "visible" });

    const detailCaps = await auditVisibleCaps(detail);
    for (const label of [
      "오늘 플래너로 돌아가기",
      "업무 보드 열기",
      "업무 설명 편집",
      "컨텍스트 추가",
      "마크다운 추가",
      "새 세션",
    ]) {
      assert(detailCaps.some((cap) => cap.label === label), `${label} 아이콘 캡이 없습니다.`);
    }
    assert(detailCaps.some((cap) => cap.label.startsWith("별표 ")), "별표 아이콘 캡이 없습니다.");
    assert(detailCaps.some((cap) => cap.label.startsWith("오늘 플래너")), "오늘 토글 아이콘 캡이 없습니다.");
    await assertPressedToggle(detail.locator('button[aria-label^="별표 "]'));
    await assertPressedToggle(detail.locator('button[aria-label^="오늘 플래너"][aria-pressed]'));

    const detailText = await detail.innerText();
    for (const removed of ["☆ 별표하기", "★ 별표됨", "＋ 마크다운", "＋ 새 세션", "이름 수정"]) {
      assert(!detailText.includes(removed), `텍스트 액션이 남았습니다: ${removed}`);
    }
    await capture(page, theme, "03-task-detail-actions");

    assert(errors.length === 0, `브라우저 오류가 발생했습니다: ${errors.join(" | ")}`);
    return {
      todayCaps: todayCaps.length,
      projectCaps: projectCaps.length,
      detailCaps: detailCaps.length,
      allCapsHaveLabelsAndTooltips: true,
      allCapsMatch44pxReference: true,
      pressedStatesPreserved: true,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function auditVisibleCaps(root: Page | ReturnType<Page["locator"]>) {
  const caps = root.locator('[data-slot="dashboard-icon-cap"]:visible');
  const count = await caps.count();
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const cap = caps.nth(index);
    const data = await cap.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        label: element.getAttribute("aria-label") ?? "",
        tooltip: element.getAttribute("title") ?? "",
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        radius: style.borderRadius,
      };
    });
    assert(data.label.length > 0, `aria-label 없는 아이콘 캡 #${index}`);
    assert(data.tooltip.length > 0, `툴팁 없는 아이콘 캡: ${data.label}`);
    assert(Math.abs(data.width - 44) < 0.2, `${data.label} 너비가 ${data.width}px입니다.`);
    assert(Math.abs(data.height - 44) < 0.2, `${data.label} 높이가 ${data.height}px입니다.`);
    assert(data.radius === "22px", `${data.label} 라운딩이 ${data.radius}입니다.`);
    return data;
  }));
}

async function assertPressedToggle(locator: ReturnType<Page["locator"]>) {
  assert(await locator.count() === 1, "토글 액션을 하나로 특정하지 못했습니다.");
  const pressed = await locator.getAttribute("aria-pressed");
  assert(pressed === "true" || pressed === "false", "토글 액션의 aria-pressed가 없습니다.");
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
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
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
