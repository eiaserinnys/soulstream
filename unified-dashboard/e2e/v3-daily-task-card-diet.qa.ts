import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BH_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-daily-task-card-diet"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bh-v3-daily-task-card-diet",
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
    const running = page.getByTestId("v3-task-task-alpha");
    const completed = page.getByTestId("v3-task-task-beta");
    await running.waitFor({ state: "visible", timeout: 20_000 });
    await completed.waitFor({ state: "visible" });

    const runningText = (await running.innerText()).trim();
    const completedText = (await completed.innerText()).trim();
    const runningBox = await running.boundingBox();
    const completedBox = await completed.boundingBox();

    assert(!runningText.includes("rb-alpha"), "진행 카드에 런북 식별자가 노출되었습니다.");
    assert(!completedText.includes("rb-beta"), "완료 카드에 런북 식별자가 노출되었습니다.");
    assert(!runningText.includes("컨텍스트"), "진행 카드에 컨텍스트 개수가 남았습니다.");
    assert(!completedText.includes("컨텍스트"), "완료 카드에 컨텍스트 개수가 남았습니다.");
    assert(
      /세션 #\d+ (실행 중|노드 오프라인)/.test(runningText),
      `진행 중인 세션 표시가 사라졌습니다: ${runningText}`,
    );
    assert(!completedText.includes("세션 #1 완료"), "완료 세션 문구가 남았습니다.");
    assert(!runningText.includes("담당 미지정") && !completedText.includes("담당 미지정"), "빈 담당자 문구가 남았습니다.");
    assert(await running.locator(".v3-task-meta").count() === 1, "진행 카드의 의미 있는 담당자가 사라졌습니다.");
    assert(await completed.locator(".v3-task-meta").count() === 1, "완료 카드의 의미 있는 담당자가 사라졌습니다.");
    assert(runningBox !== null && runningBox.height < 118, `진행 카드 높이가 ${runningBox?.height ?? "없음"}px입니다.`);
    assert(completedBox !== null && completedBox.height < 118, `완료 카드 높이가 ${completedBox?.height ?? "없음"}px입니다.`);
    assert(errors.length === 0, `브라우저 오류가 발생했습니다: ${errors.join(" | ")}`);

    await capture(page, theme, "01-compact-task-cards");
    return {
      runningHeight: runningBox.height,
      completedHeight: completedBox.height,
      internalMetadataHidden: true,
      activeSessionVisible: true,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
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
