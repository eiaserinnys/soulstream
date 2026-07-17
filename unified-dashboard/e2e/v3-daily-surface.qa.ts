import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BZ_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-daily-surface"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bz-daily-surface",
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push(await verifyTheme(browser, theme));
  }
  return { themes };
});

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  try {
    await preparePage(page, theme);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      throw new Error(`${theme}: 플래너 첫 화면 로드 실패 (${page.url()}): ${pageErrors.join(" | ")}`, { cause: error });
    }

    const memo = page.locator(".v3-daily-memo");
    const renderedMarkdown = memo.locator("strong").filter({ hasText: "아침 배포 전" });
    await renderedMarkdown.waitFor({ state: "visible" });
    if (await memo.locator("textarea").count()) throw new Error(`${theme}: 표시 모드에 textarea가 남았습니다.`);

    const headings = await readHeadingMetrics(page);
    if (headings.date.justifyContent !== "flex-start" || headings.date.textAlign !== "left") {
      throw new Error(`${theme}: 날짜 헤더가 좌측 정렬되지 않았습니다: ${JSON.stringify(headings.date)}`);
    }
    if (headings.tasks.justifyContent !== "flex-start" || headings.tasks.textAlign !== "left") {
      throw new Error(`${theme}: 오늘의 업무 헤더가 좌측 정렬되지 않았습니다: ${JSON.stringify(headings.tasks)}`);
    }
    if (Math.abs(headings.date.x - headings.tasks.x) > 1) {
      throw new Error(`${theme}: 두 헤더의 좌측 기준선이 다릅니다: ${headings.date.x} / ${headings.tasks.x}`);
    }
    await capture(page, theme, "01-markdown-headings");

    await memo.getByRole("button", { name: "오늘 메모 편집" }).first().click();
    const editor = memo.getByRole("textbox", { name: "오늘 메모 마크다운" });
    await editor.waitFor({ state: "visible" });
    const initialHeight = (await editor.boundingBox())?.height ?? 0;
    await editor.fill([
      "**자동 확장 검증**",
      "",
      "- 첫 번째 확인 항목",
      "- 두 번째 확인 항목",
      "- 세 번째 확인 항목",
      "- 네 번째 확인 항목",
      "- 다섯 번째 확인 항목",
      "- 여섯 번째 확인 항목",
    ].join("\n"));
    await page.waitForFunction(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="오늘 메모 마크다운"]');
      return Boolean(textarea && textarea.clientHeight >= textarea.scrollHeight - 1);
    });
    const editorMetrics = await editor.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const style = getComputedStyle(textarea);
      return {
        height: textarea.getBoundingClientRect().height,
        scrollHeight: textarea.scrollHeight,
        resize: style.resize,
        overflowY: style.overflowY,
      };
    });
    if (editorMetrics.height <= initialHeight) {
      throw new Error(`${theme}: textarea가 내용 증가 뒤 확장되지 않았습니다: ${initialHeight} → ${editorMetrics.height}`);
    }
    if (editorMetrics.resize !== "none" || editorMetrics.overflowY !== "hidden") {
      throw new Error(`${theme}: textarea resize/overflow 계약이 다릅니다: ${JSON.stringify(editorMetrics)}`);
    }

    const save = memo.getByRole("button", { name: "오늘 메모 저장" });
    const saveMetrics = await save.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { width: box.width, height: box.height, borderRadius: style.borderRadius };
    });
    if (saveMetrics.width !== 44 || saveMetrics.height !== 44 || saveMetrics.borderRadius !== "22px") {
      throw new Error(`${theme}: 저장 아이콘 캡이 44×44 정본과 다릅니다: ${JSON.stringify(saveMetrics)}`);
    }
    if (await save.locator("svg.lucide-check").count() !== 1) {
      throw new Error(`${theme}: 저장 버튼에 Check 아이콘이 없습니다.`);
    }
    await capture(page, theme, "02-editor-autogrow");

    const response = page.waitForResponse((candidate) => (
      new URL(candidate.url()).pathname.endsWith("/operations")
      && candidate.request().method() === "POST"
    ));
    await save.click();
    await response;
    await editor.waitFor({ state: "hidden" });
    await renderedMarkdown.waitFor({ state: "visible" });
    await capture(page, theme, "03-saved-render");

    if (pageErrors.length > 0) throw new Error(`${theme}: 브라우저 오류: ${pageErrors.join(" | ")}`);
    return { theme, headings, initialHeight, editorMetrics, saveMetrics };
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

async function readHeadingMetrics(page: Page) {
  const read = (selector: string) => page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      x: element.getBoundingClientRect().x,
      justifyContent: style.justifyContent,
      textAlign: style.textAlign,
    };
  });
  return {
    date: await read(".v3-date-head"),
    tasks: await read(".v3-section-head"),
  };
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
