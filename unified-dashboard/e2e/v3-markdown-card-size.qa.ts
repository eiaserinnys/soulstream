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

const result = await runPlaywrightLifecycle({
  lockName: "v3-markdown-card-size",
  timeoutMs: 120_000,
}, async ({ browser }) => verifyMarkdownCard(browser));

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyMarkdownCard(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.getByRole("button", { name: "PR-O 결정 로그 펼치기" }).click();

    const card = page.locator('[data-board-kind="markdown"]').first();
    const inlineMarkdown = card.getByTestId("v3-inline-markdown");
    const editButton = inlineMarkdown.locator(".v3-description-content");
    await editButton.waitFor({
      state: "visible",
      timeout: 20_000,
    });

    const emptyView = await measure(card, inlineMarkdown);
    assert(emptyView.wrapperHeight < emptyView.maxHeight, "빈 보기 카드가 높이 상한까지 늘어났습니다.");
    await capture(card, "01-empty-view");

    await editButton.click();
    const editor = inlineMarkdown.getByRole("textbox", { name: "PR-O 결정 로그 문서 마크다운" });
    await editor.waitFor({ state: "visible" });
    const emptyEdit = await measure(card, inlineMarkdown);
    await capture(card, "02-empty-edit");
    assert(
      Math.abs(emptyEdit.wrapperHeight - emptyView.wrapperHeight) <= 1,
      `빈 문서 보기↔편집 높이가 달라졌습니다: ${emptyView.wrapperHeight} → ${emptyEdit.wrapperHeight}`,
    );

    await inlineMarkdown.getByRole("button", { name: "완료" }).click();
    await editButton.waitFor({ state: "visible" });
    const emptyViewAfterEdit = await measure(card, inlineMarkdown);
    assert(
      Math.abs(emptyViewAfterEdit.wrapperHeight - emptyView.wrapperHeight) <= 1,
      `빈 문서 편집 이탈 뒤 높이가 달라졌습니다: ${emptyView.wrapperHeight} → ${emptyViewAfterEdit.wrapperHeight}`,
    );

    await editButton.click();
    await editor.waitFor({ state: "visible" });
    await editor.fill([
      "## 내용이 생긴 문서",
      "",
      "첫 번째 확인 항목입니다.",
      "",
      "두 번째 줄이 추가되면 편집 영역도 자연스럽게 커집니다.",
      "",
      "- 보기와 편집의 최소 높이는 같다.",
      "- 내용은 잘리지 않는다.",
    ].join("\n"));
    await waitForWrapperGrowth(page, emptyEdit.wrapperHeight);
    const contentEdit = await measure(card, inlineMarkdown);
    assert(
      contentEdit.wrapperHeight > emptyEdit.wrapperHeight,
      `내용 입력 뒤 카드 높이가 늘지 않았습니다: ${emptyEdit.wrapperHeight} → ${contentEdit.wrapperHeight}`,
    );
    assert(contentEdit.wrapperHeight < contentEdit.maxHeight, "보통 길이 문서가 높이 상한까지 늘어났습니다.");
    await capture(card, "03-content-edit");

    await editor.fill(Array.from({ length: 80 }, (_, index) => `긴 문서 ${index + 1}번째 줄`).join("\n"));
    await waitForWrapperGrowth(page, contentEdit.wrapperHeight);
    const longEdit = await measure(card, inlineMarkdown);
    assert(longEdit.wrapperHeight <= longEdit.maxHeight + 1, "긴 문서가 기존 높이 상한을 넘었습니다.");
    assert(longEdit.scrollHeight > longEdit.clientHeight, "긴 문서의 기존 내부 스크롤이 사라졌습니다.");
    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);

    const metrics = {
      emptyView,
      emptyEdit,
      emptyViewAfterEdit,
      contentEdit,
      longEdit,
      browserErrors: browserErrors.length,
    };
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
    return metrics;
  } finally {
    await context.close();
  }
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
        body: "",
        version: 2,
      });
    }
    return route.fallback();
  });
}

async function measure(
  card: ReturnType<Page["locator"]>,
  inlineMarkdown: ReturnType<Page["getByTestId"]>,
) {
  const metrics = await inlineMarkdown.evaluate((element) => {
    const wrapper = element as HTMLElement;
    const cardNode = wrapper.closest<HTMLElement>('[data-board-kind="markdown"]');
    if (!cardNode) return null;
    const style = getComputedStyle(wrapper);
    const shell = wrapper.querySelector<HTMLElement>(".v3-description-shell");
    const editor = wrapper.querySelector<HTMLElement>(".v3-description-editor");
    const textarea = wrapper.querySelector<HTMLTextAreaElement>("textarea");
    return {
      cardHeight: cardNode.getBoundingClientRect().height,
      wrapperHeight: wrapper.getBoundingClientRect().height,
      maxHeight: Number.parseFloat(style.maxHeight),
      clientHeight: wrapper.clientHeight,
      scrollHeight: wrapper.scrollHeight,
      shellHeight: shell?.getBoundingClientRect().height ?? null,
      editorHeight: editor?.getBoundingClientRect().height ?? null,
      textarea: textarea ? {
        height: textarea.getBoundingClientRect().height,
        clientHeight: textarea.clientHeight,
        scrollHeight: textarea.scrollHeight,
      } : null,
    };
  });
  assert(metrics !== null, "마크다운 카드 높이 측정 대상을 찾지 못했습니다.");
  assert(await card.count() === 1, "마크다운 카드가 하나가 아닙니다.");
  return metrics;
}

async function capture(card: Locator, name: string) {
  mkdirSync(outputRoot, { recursive: true });
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({
    path: path.join(outputRoot, `${name}.png`),
    animations: "disabled",
  });
}

async function waitForWrapperGrowth(page: Page, previousHeight: number) {
  await page.waitForFunction((height) => {
    const wrapper = document.querySelector<HTMLElement>(".v3-inline-markdown");
    return wrapper !== null && wrapper.getBoundingClientRect().height > height;
  }, previousHeight, { timeout: 5_000 });
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
