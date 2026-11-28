import { koreanLocale } from "./korean-locale.mjs";
import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { openV3Folder } from "./v3-qa-entry";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CB_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-pr-cb-visual"),
);
const strict = process.env.PR_CB_QA_STRICT === "1";

const result = await runPlaywrightLifecycle({
  lockName: `pr-cb-visual-${strict ? "after" : "before"}`,
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) themes.push(await verifyTheme(browser, theme));
  return { themes };
});

console.log(JSON.stringify({ ok: true, strict, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1600, height: 1000 },
    locale: koreanLocale,
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page, theme);
    await openV3Folder(page, baseUrl);
    const taskCard = page.getByTestId("v3-task-task-alpha");
    const sessionRow = page.getByTestId("v3-session-row-run-alpha-2");
    await taskCard.waitFor({ state: "visible", timeout: 30_000 });
    await sessionRow.waitFor({ state: "visible" });

    const firstScreen = await page.evaluate(() => {
      const headerElement = document.querySelector<HTMLElement>(".v3-inline-folder-header");
      const cardElement = document.querySelector<HTMLElement>(".v3-task-card");
      const sessionCardElement = document.querySelector<HTMLElement>(".v3-session-panel .v3-run-row");
      const trailingElement = document.querySelector<HTMLElement>(".v3-session-panel .v3-run-trailing");
      if (!headerElement || !cardElement || !sessionCardElement || !trailingElement) {
        throw new Error("PR-CB 기준 화면 요소를 찾을 수 없습니다.");
      }
      const header = headerElement.getBoundingClientRect();
      const card = cardElement.getBoundingClientRect();
      const sessionCard = sessionCardElement.getBoundingClientRect();
      const trailing = trailingElement.getBoundingClientRect();
      return {
        hasFolderHeader: header.width > 0,
        x: { header: header.x, card: card.x },
        trailingRightGap: sessionCard.right - trailing.right,
      };
    });
    await capture(page, theme, "01-folder-session-panel");

    await sessionRow.locator(".v3-run-open").click();
    await page.locator(".v3-chat-header").waitFor({ state: "visible" });
    const chatHeader = await page.locator(".v3-chat-header").evaluate((header) => {
      const title = header.querySelector<HTMLElement>("strong");
      if (!title) throw new Error("채팅 제목을 찾지 못했습니다.");
      const headerRect = header.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      return {
        breadcrumbCount: header.querySelectorAll("small").length,
        title: title.textContent?.trim() ?? "",
        fontSize: getComputedStyle(title).fontSize,
        verticalCenterDelta: Math.abs(
          (headerRect.top + headerRect.height / 2) - (titleRect.top + titleRect.height / 2),
        ),
      };
    });
    await capture(page, theme, "02-chat-header");

    if (strict) {
      assert(firstScreen.hasFolderHeader, `${theme}: 폴더 화면 헤더가 없습니다.`);
      assert(firstScreen.trailingRightGap >= 9, `${theme}: trailing 우측 여백이 부족합니다: ${firstScreen.trailingRightGap}`);
      assert(chatHeader.breadcrumbCount === 0, `${theme}: 세션 채팅 breadcrumb가 남았습니다.`);
      assert(chatHeader.title === "시각 QA 순회", `${theme}: 실제 세션 제목이 아닙니다: ${chatHeader.title}`);
      assert(chatHeader.fontSize === "16px", `${theme}: 채팅 제목 크기가 16px가 아닙니다: ${chatHeader.fontSize}`);
      assert(chatHeader.verticalCenterDelta <= 1, `${theme}: 채팅 제목이 세로 중앙이 아닙니다: ${chatHeader.verticalCenterDelta}`);
    }
    assert(browserErrors.length === 0, `${theme}: 브라우저 오류: ${browserErrors.join(" | ")}`);

    const metrics = { theme, firstScreen, chatHeader };
    writeMetrics(theme, metrics);
    return metrics;
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme) {
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

function writeMetrics(theme: Theme, metrics: unknown) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

async function capture(page: Page, theme: Theme, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: false,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
