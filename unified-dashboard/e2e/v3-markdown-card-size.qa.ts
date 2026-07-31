import type { Browser, Locator, Page, Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.MARKDOWN_CARD_QA_OUTPUT
    ?? path.join("e2e", "screenshots", "v3-markdown-card-size"),
);
const longMarkdown = [
  "# 긴 문서 위치 검증",
  "",
  "> ```text",
  ...Array.from({ length: 80 }, (_, index) => (
    `> 인용문 코드 행 ${index + 1} — 코드 블록도 인용문 높이에 포함되어야 합니다.`
  )),
  "> ```",
  "",
  ...Array.from({ length: 80 }, (_, index) => (
    `> 긴 인용문 ${index + 1} — 내부 스크롤 없이 문서 흐름 안에서 펼쳐져야 합니다.`
  )),
  "",
  "```text",
  ...Array.from({ length: 80 }, (_, index) => (
    `일반 코드 행 ${index + 1} — 인용문 밖 코드 블록의 기존 스크롤은 유지되어야 합니다.`
  )),
  "```",
  "",
  ...Array.from({ length: 80 }, (_, index) => `본문 문단 ${index + 1} — 편집 왕복 위치 기준점입니다.`),
].join("\n");

const result = await runPlaywrightLifecycle({
  lockName: "v3-markdown-card-size",
  timeoutMs: 180_000,
  closeTimeoutMs: 15_000,
}, async ({ browser }) => verifyMarkdownSurfaces(browser));

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyMarkdownSurfaces(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (!error.message.includes("document is sandboxed and lacks the 'allow-same-origin' flag")) {
      browserErrors.push(error.message);
    }
  });
  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !message.text().includes("document is sandboxed and lacks the 'allow-same-origin' flag")
    ) {
      browserErrors.push(message.text());
    }
  });

  try {
    await preparePage(page);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.getByRole("button", { name: "PR-O 결정 로그 펼치기" }).click();

    const inlineMarkdown = page.getByTestId("v3-inline-markdown");
    await inlineMarkdown.getByText("긴 인용문 80", { exact: false }).waitFor({ state: "visible" });
    const inline = await measureInlineMarkdown(inlineMarkdown);
    assert(inline.maxHeight === "none", `인라인 문서 높이 상한이 남았습니다: ${inline.maxHeight}`);
    assert(!["auto", "scroll"].includes(inline.overflowY), `인라인 문서가 내부 스크롤을 소유합니다: ${inline.overflowY}`);
    assert(inline.scrollHeight <= inline.clientHeight + 1, "인라인 문서 안에 별도 세로 스크롤 영역이 남았습니다.");
    assert(inline.quoteScrollHeight <= inline.quoteClientHeight + 1, "긴 blockquote 안에 별도 세로 스크롤 영역이 남았습니다.");
    await capture(page, "01-inline-long-blockquote");

    await page.getByRole("button", { name: "업무 보드 열기" }).click();
    const board = page.getByTestId("v3-task-board-pane");
    const resources = page.getByTestId("v3-task-board-resources");
    const canvas = page.getByTestId("v3-task-board-canvas");
    await board.waitFor({ state: "visible" });
    await page.getByTestId("v3-task-board-loading").waitFor({ state: "hidden" });
    await canvas.getByTestId("board-declutter-button").click();
    await canvas.getByTestId("board-markdown-tile").click();
    await resources.getByRole("button", { name: "PR-O 결정 로그 편집기 열기" }).click();

    const overlay = page.getByTestId("v3-task-board-document-overlay");
    await overlay.waitFor({ state: "visible" });
    await overlay.getByTestId("v3-task-board-document-overlay-expand").click();
    const readBody = overlay.getByTestId("markdown-read-body");
    await readBody.getByText("본문 문단 80", { exact: false }).waitFor({ state: "visible" });
    const nestedCodeQuote = readBody.locator("blockquote").filter({ hasText: "인용문 코드 행 80" }).first();
    const nestedCodeBlock = nestedCodeQuote.locator("pre");
    const nestedCodeMetrics = await measureElement(nestedCodeBlock);
    const ordinaryCodeBlock = readBody.locator("pre").filter({ hasText: "일반 코드 행 80" });
    const ordinaryCodeMetrics = await measureElement(ordinaryCodeBlock);
    const centralQuote = readBody.locator("blockquote").first();
    const centralReadSurface = await measureScrollAncestry(centralQuote, overlay);
    console.log(JSON.stringify({ nestedCodeMetrics, ordinaryCodeMetrics, centralReadSurface }, null, 2));
    await capture(page, "02-board-central-blockquote");
    assert(nestedCodeMetrics.maxHeight === "none", `중앙 인용문 코드 높이 상한이 남았습니다: ${nestedCodeMetrics.maxHeight}`);
    assert(
      !["auto", "scroll"].includes(nestedCodeMetrics.overflowY),
      `중앙 인용문 코드가 별도 세로 스크롤을 소유합니다: ${nestedCodeMetrics.overflowY}`,
    );
    assert(
      nestedCodeMetrics.scrollHeight <= nestedCodeMetrics.clientHeight + 1,
      "중앙 인용문 코드가 내용 높이만큼 펼쳐지지 않았습니다.",
    );
    assert(
      ordinaryCodeMetrics.maxHeight === "240px"
        && ordinaryCodeMetrics.overflowY === "auto"
        && ordinaryCodeMetrics.scrollHeight > ordinaryCodeMetrics.clientHeight + 1,
      `인용문 밖 코드 블록의 기존 스크롤 계약이 달라졌습니다: ${JSON.stringify(ordinaryCodeMetrics)}`,
    );
    assert(
      centralReadSurface.nodes[0]?.scrollHeight <= (centralReadSurface.nodes[0]?.clientHeight ?? 0) + 1,
      "중앙 문서의 긴 blockquote 자체에 별도 세로 스크롤 영역이 남았습니다.",
    );
    const readMiddle = await setScrollFraction(readBody, 0.5);
    await capture(page, "03-board-read-middle");

    await overlay.getByTestId("markdown-edit-start").click();
    const editorScroller = overlay.locator(".cm-scroller");
    await editorScroller.waitFor({ state: "visible" });
    const editMiddle = await readSettledMetrics(editorScroller);
    assertAnchorClose(readMiddle.anchor, editMiddle.anchor, "읽기 → 편집 중간 위치");
    await capture(page, "04-board-edit-middle");

    const editBottom = await setScrollFraction(editorScroller, 0.86);
    await overlay.getByTestId("markdown-edit-done").click();
    await readBody.waitFor({ state: "visible" });
    const savedBottom = await readSettledMetrics(readBody);
    assertAnchorClose(editBottom.anchor, savedBottom.anchor, "편집 완료 → 읽기 하단 위치");
    await capture(page, "05-board-saved-bottom");

    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);
    const metrics = {
      inline,
      nestedCodeMetrics,
      ordinaryCodeMetrics,
      centralReadSurface,
      readMiddle,
      editMiddle,
      editBottom,
      savedBottom,
      browserErrors: browserErrors.length,
    };
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
    return metrics;
  } finally {
    await context.close();
  }
}

async function measureElement(target: Locator) {
  return target.evaluate((element) => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    return {
      maxHeight: style.maxHeight,
      height: style.height,
      overflow: style.overflow,
      overflowY: style.overflowY,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    };
  });
}

async function measureScrollAncestry(target: Locator, boundary: Locator) {
  const boundaryHandle = await boundary.elementHandle();
  if (!boundaryHandle) throw new Error("중앙 문서 오버레이를 찾지 못했습니다.");
  return target.evaluate((element, overlay) => {
    const nodes: Array<{
      tag: string;
      testId: string | null;
      classes: string;
      maxHeight: string;
      height: string;
      overflow: string;
      overflowY: string;
      clientHeight: number;
      scrollHeight: number;
      ownsVerticalScroll: boolean;
    }> = [];
    let current: HTMLElement | null = element as HTMLElement;
    while (current) {
      const style = getComputedStyle(current);
      const overflowY = style.overflowY;
      nodes.push({
        tag: current.tagName.toLowerCase(),
        testId: current.dataset.testid ?? null,
        classes: current.className,
        maxHeight: style.maxHeight,
        height: style.height,
        overflow: style.overflow,
        overflowY,
        clientHeight: current.clientHeight,
        scrollHeight: current.scrollHeight,
        ownsVerticalScroll: ["auto", "scroll"].includes(overflowY)
          && current.scrollHeight > current.clientHeight + 1,
      });
      if (current === overlay) break;
      current = current.parentElement;
    }
    return { nodes };
  }, boundaryHandle);
}

async function preparePage(page: Page) {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Playwright jsdom local-board-yjs",
    });
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
  await page.route("**/api/markdown-documents/doc-inline", async (route) => {
    if (route.request().method() === "GET") {
      return fulfillJson(route, {
        id: "doc-inline",
        title: "PR-O 결정 로그",
        body: longMarkdown,
        version: 2,
      });
    }
    return route.fallback();
  });
}

async function measureInlineMarkdown(inlineMarkdown: Locator) {
  return inlineMarkdown.evaluate((element) => {
    const wrapper = element as HTMLElement;
    const style = getComputedStyle(wrapper);
    const quote = wrapper.querySelector<HTMLElement>("blockquote");
    if (!quote) throw new Error("긴 blockquote를 찾지 못했습니다.");
    return {
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      clientHeight: wrapper.clientHeight,
      scrollHeight: wrapper.scrollHeight,
      quoteClientHeight: quote.clientHeight,
      quoteScrollHeight: quote.scrollHeight,
      quoteOverflowY: getComputedStyle(quote).overflowY,
    };
  });
}

async function setScrollFraction(locator: Locator, fraction: number) {
  return locator.evaluate((element, targetFraction) => {
    const scroller = element.matches('[data-testid="markdown-read-body"]')
      ? element.parentElement as HTMLElement
      : element as HTMLElement;
    scroller.scrollTop = Math.max(scroller.scrollHeight - scroller.clientHeight, 0) * targetFraction;
    return {
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      anchor: (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(scroller.scrollHeight, 1),
    };
  }, fraction);
}

async function readSettledMetrics(locator: Locator) {
  await locator.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return locator.evaluate((element) => {
    const scroller = element.matches('[data-testid="markdown-read-body"]')
      ? element.parentElement as HTMLElement
      : element as HTMLElement;
    return {
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      anchor: (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(scroller.scrollHeight, 1),
    };
  });
}

function assertAnchorClose(expected: number, actual: number, label: string) {
  assert(Math.abs(expected - actual) <= 0.08, `${label}가 어긋났습니다: ${expected} → ${actual}`);
}

async function capture(page: Page, name: string) {
  mkdirSync(outputRoot, { recursive: true });
  await page.screenshot({
    path: path.join(outputRoot, `${name}.png`),
    animations: "disabled",
  });
}

async function fulfillJson(route: Route, payload: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
