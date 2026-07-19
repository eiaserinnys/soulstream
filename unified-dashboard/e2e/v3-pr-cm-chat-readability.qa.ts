import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";
type AccountPreferences = {
  appearance: Theme;
  chatFontSize: number;
  wallpaper: { mode: string };
  glass: Record<string, number | boolean>;
};

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CM_QA_OUTPUT ?? path.join(".local", "artifacts", "screenshots", "pr-cm"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-cm-chat-readability",
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  const themeFilter = process.env.PR_CM_QA_THEME;
  const themesToVerify: Theme[] = themeFilter === "dark" || themeFilter === "light"
    ? [themeFilter]
    : ["dark", "light"];
  for (const theme of themesToVerify) themes.push(await verifyTheme(browser, theme));
  return { themes };
});

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const account = createAccountPreferences(theme);
  const writes: AccountPreferences[] = [];
  const context = await createContext(browser, theme);
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page, theme, account, writes);
    await openMain(page);
    const gaps = await measureCardGaps(page);

    await page.getByTestId("config-button").click();
    await page.getByRole("tab", { name: "채팅", exact: true }).click();
    const slider = page.locator('[data-testid="chat-font-size-slider"] input[type="range"]');
    await slider.press("End");
    await page.getByText("18px", { exact: true }).waitFor();
    await waitForPreference(page, 18, writes);
    await capture(page, theme, "01-settings-18");
    await slider.press("Home");
    await page.getByText("14px", { exact: true }).waitFor();
    await waitForPreference(page, 14, writes);
    await page.getByRole("button", { name: "닫기", exact: true }).click();
    await capture(page, theme, "02-main");

    await openChat(page);
    await injectChatFixtures(page);
    const collapsed = await measureChat(page);
    await capture(page, theme, "03-chat-14-collapsed");

    const toolToggle = page.locator('[data-slot="tool-call-group-toggle"]');
    await toolToggle.click();
    await page.locator('[data-slot="tool-call-group-items"]').waitFor();
    await page.locator('[data-slot="tool-call-item-toggle"]').first().click();
    await page.locator('[data-slot="chat-tool-body"]').first().waitFor();
    const expanded = await measureChat(page);
    await capture(page, theme, "04-chat-14-expanded");

    const copyButton = page.getByRole("button", { name: "인용문 복사" }).last();
    assert((await copyButton.textContent())?.trim() === "", `${theme}: 복사 버튼에 텍스트 라벨이 노출됐습니다.`);
    await copyButton.click();
    await page.locator('[data-copy-state="success"]').waitFor();
    const copiedText = await page.evaluate(() => (globalThis as unknown as { __qaCopiedText?: string }).__qaCopiedText ?? "");
    assert(copiedText.includes("첫 번째 인용 줄") && copiedText.includes("두 번째 인용 줄"), `${theme}: 인용문 순수 텍스트 복사 실패`);
    assert(!copiedText.includes("인용문 복사"), `${theme}: 복사 컨트롤 텍스트가 클립보드에 섞였습니다.`);
    await capture(page, theme, "05-chat-copy-success");

    await setChatFontSize(page, 18);
    await waitForPreference(page, 18, writes);
    const large = await measureChat(page);
    await capture(page, theme, "06-chat-18-expanded");

    const responsive = [];
    for (const viewport of [
      { width: 2048, height: 1152 },
      { width: 1440, height: 900 },
      { width: 1024, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      responsive.push({ ...viewport, overflow: await measureViewportOverflow(page) });
      if (viewport.width !== 1440) {
        await capture(page, theme, `07-chat-18-${viewport.width}`);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("v3-mobile-tab-chat").click();
    await page.locator(".v3-chat-pane").waitFor({ state: "visible" });
    const mobile = await measureChat(page);
    await capture(page, theme, "08-mobile-chat-18");

    const metrics = { theme, gaps, collapsed, expanded, large, responsive, mobile, preferenceWrites: writes.length };
    writeMetrics(theme, metrics);
    assertMetrics(metrics);
    assert(browserErrors.length === 0, `${theme}: 브라우저 오류: ${browserErrors.join(" | ")}`);
  } finally {
    await context.close();
  }

  const restored = await verifyFreshBrowserContext(browser, theme, account, writes);
  assert(restored === 18, `${theme}: 새 브라우저 컨텍스트가 계정 저장값 ${restored}px을 복원했습니다.`);
  return { theme, restored, writes: writes.length };
}

async function createContext(browser: Browser, theme: Theme): Promise<BrowserContext> {
  return browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 900 },
  });
}

async function preparePage(
  page: Page,
  theme: Theme,
  account: AccountPreferences,
  writes: AccountPreferences[],
) {
  await page.addInitScript({ content: `
    Object.defineProperty(globalThis, "__name", { configurable: true, value: (target) => target });
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { globalThis.__qaCopiedText = text; } },
    });
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page, { timelineEventCount: 2, liveEventText: "채팅 글자 크기 실제 렌더" });
  await installAccountRoutes(page, account, writes);
}

async function installAccountRoutes(page: Page, account: AccountPreferences, writes: AccountPreferences[]) {
  await page.route("**/api/auth/config", (route) => fulfillJson(route, { authEnabled: true, devModeEnabled: false }));
  await page.route("**/api/auth/status", (route) => fulfillJson(route, {
    authenticated: true,
    user: { email: "qa@example.com", name: "QA", isAdmin: false },
  }));
  await page.route("**/api/user/preferences", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as Partial<AccountPreferences>;
      Object.assign(account, input);
      writes.push(structuredClone(account));
    }
    return fulfillJson(route, {
      email: "qa@example.com",
      preferences: account,
      ...account,
      hasBackground: false,
      backgroundUrl: null,
      updatedAt: "2026-07-19T14:00:00.000Z",
    });
  });
}

async function openMain(page: Page) {
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".v3-session-panel .v3-run-row").first().waitFor({ state: "visible" });
}

async function openChat(page: Page) {
  await page.getByTestId("v3-task-task-alpha").click();
  const run = page.locator(".v3-detail-pane .v3-run-open").filter({ hasText: "시각 QA 순회" });
  await run.waitFor({ state: "visible", timeout: 20_000 });
  await run.click();
  await page.locator(".v3-chat-pane").waitFor({ state: "visible" });
  await page.locator('[data-slot="chat-root"]').waitFor({ state: "visible" });
}

async function injectChatFixtures(page: Page) {
  await page.evaluate(() => {
    const store = (globalThis as unknown as {
      __SOULSTREAM_STORE__: { getState(): { processEvent(event: Record<string, unknown>, eventId: number): unknown } };
    }).__SOULSTREAM_STORE__;
    const processEvent = store.getState().processEvent;
    processEvent({ type: "tool_start", timestamp: 1, tool_name: "Read", tool_input: { file_path: "src/chat.tsx" }, tool_use_id: "qa-tool-read" }, 9001);
    processEvent({ type: "tool_start", timestamp: 2, tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_use_id: "qa-tool-test" }, 9002);
    processEvent({ type: "tool_result", tool_name: "Read", result: "도구 결과 본문 첫 줄\n둘째 줄", is_error: false, tool_use_id: "qa-tool-read" }, 9003);
    processEvent({ type: "tool_result", tool_name: "Bash", result: "25 tests passed", is_error: false, tool_use_id: "qa-tool-test" }, 9004);
    processEvent({
      type: "assistant_message",
      timestamp: 3,
      content: "일반 본문과 `인라인 코드`입니다.\n\n> 첫 번째 인용 줄\n>\n> 두 번째 인용 줄\n\n```ts\nconst size = 14;\n```",
      tool_use_id: "qa-quote-message",
      _final_for_live_stream: true,
    }, 9005);
  });
  await page.locator('[data-slot="tool-call-group-toggle"]').waitFor();
  await page.getByRole("button", { name: "인용문 복사" }).last().waitFor();
}

async function setChatFontSize(page: Page, value: number) {
  await page.evaluate((next) => {
    const store = (globalThis as unknown as {
      __SOULSTREAM_STORE__: { getState(): { setChatFontSize(value: number): void } };
    }).__SOULSTREAM_STORE__;
    store.getState().setChatFontSize(next);
  }, value);
  await page.locator(`[data-slot="chat-root"][data-chat-font-size="${value}"]`).waitFor();
  await page.waitForFunction((expected) => {
    const chatRoot = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="chat-root"]'))
      .find((element) => element.getClientRects().length > 0);
    const body = chatRoot?.querySelector<HTMLElement>('[data-slot="chat-body"]');
    return body !== null && body !== undefined && getComputedStyle(body).fontSize === `${expected}px`;
  }, value);
}

async function measureCardGaps(page: Page) {
  return page.evaluate(() => ({
    task: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".v3-task-list")!).gap),
    session: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".v3-session-list")!).gap),
  }));
}

async function measureChat(page: Page) {
  return page.evaluate(() => {
    const chatRoot = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="chat-root"]'))
      .find((element) => element.getClientRects().length > 0);
    if (!chatRoot) throw new Error("화면에 보이는 채팅 루트를 찾지 못했습니다.");
    const required = (selector: string) => {
      const element = chatRoot.matches(selector)
        ? chatRoot
        : chatRoot.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`채팅 측정 대상을 찾지 못했습니다: ${selector}`);
      return element;
    };
    const metrics = (selector: string) => {
      const style = getComputedStyle(required(selector));
      return {
        size: style.fontSize,
        line: style.lineHeight,
        variable: style.getPropertyValue("--chat-font-size").trim(),
      };
    };
    const toolRow = required('[data-slot="chat-tool-row"]');
    const toolIcons = Array.from(required('[data-slot="tool-call-group-toggle"]').querySelectorAll<SVGElement>("svg"));
    return {
      rootSize: required('[data-slot="chat-root"]').dataset.chatFontSize,
      rootVariable: getComputedStyle(chatRoot).getPropertyValue("--chat-font-size").trim(),
      body: metrics('[data-slot="chat-body"]'),
      code: metrics('[data-slot="chat-body"] pre'),
      input: metrics('[data-slot="chat-input-body"]'),
      toolBody: chatRoot.querySelector('[data-slot="chat-tool-body"]') ? metrics('[data-slot="chat-tool-body"]') : null,
      toolHeader: metrics('[data-slot="tool-call-group-toggle"]'),
      toolIcons: toolIcons.map((icon) => ({
        width: icon.getBoundingClientRect().width,
        height: icon.getBoundingClientRect().height,
      })),
      toolHeight: toolRow.getBoundingClientRect().height,
      meta: metrics('[data-slot="chat-message-bubble"] span'),
      viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

async function measureViewportOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function waitForPreference(page: Page, size: number, writes: AccountPreferences[]) {
  await page.waitForFunction((expected) => {
    const store = (globalThis as unknown as {
      __SOULSTREAM_STORE__: { getState(): { chatFontSize: number } };
    }).__SOULSTREAM_STORE__;
    return store.getState().chatFontSize === expected;
  }, size);
  const deadline = Date.now() + 4_000;
  while (writes.at(-1)?.chatFontSize !== size && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
  assert(writes.at(-1)?.chatFontSize === size, `계정 설정에 ${size}px이 저장되지 않았습니다.`);
}

async function verifyFreshBrowserContext(
  browser: Browser,
  theme: Theme,
  account: AccountPreferences,
  writes: AccountPreferences[],
) {
  const context = await createContext(browser, theme);
  const page = await context.newPage();
  try {
    await preparePage(page, theme, account, writes);
    await openMain(page);
    await page.waitForFunction(() => {
      const store = (globalThis as unknown as {
        __SOULSTREAM_STORE__: { getState(): { chatFontSize: number } };
      }).__SOULSTREAM_STORE__;
      return store.getState().chatFontSize === 18;
    });
    return await page.evaluate(() => (globalThis as unknown as {
      __SOULSTREAM_STORE__: { getState(): { chatFontSize: number } };
    }).__SOULSTREAM_STORE__.getState().chatFontSize);
  } finally {
    await context.close();
  }
}

function assertMetrics(metrics: {
  theme: Theme;
  gaps: { task: number; session: number };
  collapsed: Awaited<ReturnType<typeof measureChat>>;
  expanded: Awaited<ReturnType<typeof measureChat>>;
  large: Awaited<ReturnType<typeof measureChat>>;
  mobile: Awaited<ReturnType<typeof measureChat>>;
  responsive: Array<{ width: number; height: number; overflow: number }>;
}) {
  const { theme, gaps, collapsed, expanded, large, mobile, responsive } = metrics;
  assert(gaps.task === 4 && gaps.session === 4, `${theme}: 카드 gap ${gaps.task}/${gaps.session}px`);
  assert(collapsed.toolHeight === 32, `${theme}: Tool Calls 접힘 높이 ${collapsed.toolHeight}px`);
  assert(collapsed.body.size === "14px" && collapsed.body.line === "22px", `${theme}: 14px 본문 ${JSON.stringify(collapsed.body)}`);
  assert(collapsed.code.size === "14px" && collapsed.input.size === "14px", `${theme}: 14px 코드/입력 미적용`);
  assert(expanded.toolBody?.size === "14px" && expanded.toolBody.line === "22px", `${theme}: 14px 도구 본문 ${JSON.stringify(expanded.toolBody)}`);
  assert(large.body.size === "18px" && large.body.line === "26px", `${theme}: 18px 본문 ${JSON.stringify(large.body)}`);
  assert(large.code.size === "18px" && large.input.size === "18px" && large.toolBody?.size === "18px", `${theme}: 18px 코드/도구/입력 미적용`);
  assert(collapsed.toolHeader.size === "12px" && collapsed.toolHeader.line === "18px", `${theme}: Tool Calls 헤더가 가변됐습니다.`);
  assert(collapsed.toolIcons.length === 2 && collapsed.toolIcons.every((icon) => icon.width === 14 && icon.height === 14), `${theme}: Tool Calls 아이콘이 14px이 아닙니다.`);
  assert(collapsed.meta.size === large.meta.size && collapsed.meta.line === large.meta.line, `${theme}: 메타 타이포가 가변됐습니다.`);
  assert(responsive.every((viewport) => viewport.overflow <= 0), `${theme}: 반응형 overflow ${JSON.stringify(responsive)}`);
  assert(mobile.body.size === "18px" && mobile.viewportOverflow <= 0, `${theme}: 모바일 18px/overflow ${JSON.stringify(mobile)}`);
}

function createAccountPreferences(theme: Theme): AccountPreferences {
  return {
    appearance: theme,
    chatFontSize: 14,
    wallpaper: { mode: "bokeh" },
    glass: { enabled: true, refraction: 75, blur: 5, chromatic: 0.8, specular: 0.25, tint: 0.42 },
  };
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function writeMetrics(theme: Theme, metrics: unknown) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

async function capture(page: Page, theme: Theme, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: false });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
