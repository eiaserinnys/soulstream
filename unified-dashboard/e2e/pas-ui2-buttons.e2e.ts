import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/pas-ui2-buttons-web");
mkdirSync(output, { recursive: true });

const sessionId = "run-alpha-2";
const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_model: null,
  show_generation_separator: true,
  show_character: true,
  show_jev_candidates: true,
  animate_character: false,
  show_turn_usage: true,
};
const session = {
  session_id: sessionId,
  display_name: "PAS 버튼 검수",
  node_id: "eiaserinnys",
  folder_id: "folder-amber",
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: {
    current_model: { model_preset: null, reasoning_effort: null, model: "codex" },
    pending: null,
  },
};
const createDefaults = {
  node_id: "eiaserinnys",
  preferred_agent_id: "roselin_codex",
  settings,
  initial_instruction: "PAS UI 버튼 검수",
  unavailable_reason: null,
};

async function prepare(page: Page, width: number) {
  const errors: string[] = [];
  let releaseLiveEvent = () => {};
  const liveEventGate = new Promise<void>(resolve => { releaseLiveEvent = resolve; });
  let eventStreamRequests = 0;
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, {
    timelineEventCount: 80,
    liveEventText: "새 메시지 버튼 검수",
  });
  await page.route("**/api/persistent-sessions**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/persistent-sessions" && request.method() === "GET") {
      return route.fulfill({ json: { sessions: [session], total: 1, create_defaults: createDefaults } });
    }
    if (url.pathname === `/api/persistent-sessions/${sessionId}` && request.method() === "GET") {
      return route.fulfill({ json: { session } });
    }
    if (url.pathname === `/api/persistent-sessions/${sessionId}` && request.method() === "PUT") {
      return route.fulfill({ json: { session, model_change: "none" } });
    }
    return route.fallback();
  });
  await page.route("**/api/sessions/*/events", async route => {
    const requestIndex = eventStreamRequests++;
    if (requestIndex === 1) {
      await liveEventGate;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          "retry: 60000",
          "",
          "id: 81",
          "event: assistant_message",
          `data: ${JSON.stringify({
            type: "assistant_message",
            timestamp: 81,
            content: `새 메시지 버튼 검수 ${sessionId}`,
            tool_use_id: `${sessionId}-live`,
            _final_for_live_stream: true,
          })}`,
          "",
          "",
        ].join("\n"),
      });
    }
    if (requestIndex > 1) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 60000\n\n: idle\n\n" });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        "retry: 100",
        "",
        "event: history_sync",
        `data: ${JSON.stringify({ type: "history_sync", last_event_id: 80, is_live: true, status: "running" })}`,
        "",
        "",
      ].join("\n"),
    });
  });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: {
    authenticated: true,
    user: { email: "qa@example.test", name: "QA", isAdmin: true },
  } }));
  await page.goto(`/persistent/${sessionId}`);
  await expect(page.getByTestId("persistent-session-screen")).toBeVisible();
  await expect(page.getByRole("button", { name: "홈", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "서버 설정", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "작업 목록", exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
  const scroller = page.locator('[data-virtuoso-scroller="true"]');
  await expect(scroller).toBeVisible();
  await expect(page.getByText(/^히스토리 run-alpha-2 #/).first()).toBeVisible();
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(900);
  await expect.poll(() => scroller.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(2);
  const initialScrollTop = await scroller.evaluate(element => element.scrollTop);
  expect(initialScrollTop).toBeGreaterThan(0);
  return { errors, scroller, releaseLiveEvent };
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}

for (const width of [1440, 1280]) {
  test(`PAS bare icon caps ${width}`, async ({ page }) => {
    const { errors, scroller, releaseLiveEvent } = await prepare(page, width);
    const screen = page.getByTestId("persistent-session-screen");
    const bare = screen.locator('button[data-appearance="bare"]');
    await expect(bare).not.toHaveCount(0);

    const dimensions = await bare.evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        label: button.getAttribute("aria-label"),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        borderWidth: style.borderWidth,
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        appearance: button.dataset.appearance,
      };
    }));
    expect(dimensions.some(item => item.width === 44 && item.height === 44)).toBe(true);
    expect(dimensions.some(item => item.width === 32 && item.height === 32)).toBe(true);
    for (const item of dimensions) {
      expect(item.borderWidth).toBe("0px");
      expect(item.boxShadow).toBe("none");
      expect(item.appearance).toBe("bare");
    }
    const headerRects = await screen.locator(".persistent-session-header .dashboard-icon-cap").evaluateAll(buttons =>
      buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { label: button.getAttribute("aria-label"), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
    expect(headerRects).toHaveLength(3);
    expect(Math.max(...headerRects.map(rect => rect.y)) - Math.min(...headerRects.map(rect => rect.y))).toBeLessThanOrEqual(1);
    writeFileSync(path.join(output, `pas-${width}-geometry.json`), JSON.stringify({ bare: dimensions, header: headerRects }, null, 2));

    const send = page.locator('[data-testid="send-button"]');
    await expect(send).toBeDisabled();
    await capture(page, `pas-${width}-rest`);

    const home = page.getByRole("button", { name: "홈", exact: true });
    await page.keyboard.press("Tab");
    await expect(home).toBeFocused();
    const focusStyle = await home.evaluate(button => ({
      focusVisible: button.matches(":focus-visible"),
      outlineStyle: getComputedStyle(button).outlineStyle,
      boxShadow: getComputedStyle(button).boxShadow,
    }));
    expect(focusStyle.focusVisible).toBe(true);
    expect(focusStyle.outlineStyle !== "none" || focusStyle.boxShadow !== "none").toBe(true);
    await capture(page, `pas-${width}-focus`);

    const initialScrollTop = await scroller.evaluate(element => element.scrollTop);
    await scroller.hover();
    await page.mouse.wheel(0, -500);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThan(initialScrollTop);
    await expect.poll(() => scroller.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeGreaterThan(48);
    releaseLiveEvent();
    await expect(page.getByText("새 메시지 버튼 검수 run-alpha-2", { exact: true })).toBeVisible();
    const newMessages = page.getByRole("button", { name: "새 메시지로 이동", exact: true });
    await expect(newMessages).toBeVisible();
    await expect.poll(() => scroller.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeGreaterThan(48);
    const newMessagesStyle = await newMessages.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, background: style.backgroundColor, borderWidth: style.borderWidth, boxShadow: style.boxShadow };
    });
    const expectedColors = await screen.evaluate(element => {
      const probe = document.createElement("div");
      element.appendChild(probe);
      probe.style.backgroundColor = "var(--persistent-session-panel)";
      const panel = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "";
      probe.style.color = "var(--foreground)";
      const foreground = getComputedStyle(probe).color;
      probe.remove();
      return { panel, foreground };
    });
    expect(newMessagesStyle.width).toBe(44);
    expect(newMessagesStyle.height).toBe(44);
    expect(newMessagesStyle.background).toBe(expectedColors.panel);
    expect(newMessagesStyle.borderWidth).toBe("0px");
    expect(newMessagesStyle.boxShadow).toBe("none");
    await capture(page, `pas-${width}-new-messages-rest`);
    writeFileSync(path.join(output, `pas-${width}-new-messages-geometry.json`), JSON.stringify(newMessagesStyle, null, 2));

    const taskToggle = page.getByRole("button", { name: "작업 목록", exact: true });
    await taskToggle.hover();
    await expect.poll(() => taskToggle.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await expect.poll(() => taskToggle.evaluate(button => getComputedStyle(button).color)).toBe(expectedColors.foreground);
    const bareHoverStyle = await taskToggle.evaluate(button => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    });

    await newMessages.hover();
    await expect.poll(() => newMessages.evaluate(button => getComputedStyle(button).backgroundColor)).toBe(bareHoverStyle.background);
    await expect.poll(() => newMessages.evaluate(button => getComputedStyle(button).color)).toBe(bareHoverStyle.color);
    const hoverStyle = await newMessages.evaluate(button => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(hoverStyle.background).not.toBe(expectedColors.panel);
    expect(hoverStyle.color).toBe(expectedColors.foreground);
    await capture(page, `pas-${width}-new-messages-hover`);

    await page.mouse.down();
    await expect.poll(() => newMessages.evaluate(button => getComputedStyle(button).backgroundColor)).toBe(hoverStyle.background);
    await expect.poll(() => newMessages.evaluate(button => getComputedStyle(button).color)).toBe(hoverStyle.color);
    const pressedStyle = await newMessages.evaluate(button => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(pressedStyle.background).not.toBe(expectedColors.panel);
    expect(pressedStyle.color).toBe(expectedColors.foreground);
    await capture(page, `pas-${width}-new-messages-pressed`);
    await page.mouse.up();
    await expect(newMessages).toHaveCount(0);
    await expect.poll(() => scroller.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(2);

    await taskToggle.hover();
    const hoverBackground = await taskToggle.evaluate(button => getComputedStyle(button).backgroundColor);
    expect(hoverBackground).not.toBe("rgba(0, 0, 0, 0)");
    await capture(page, `pas-${width}-hover`);
    await taskToggle.hover();
    await page.mouse.down();
    const pressedBackground = await taskToggle.evaluate(button => getComputedStyle(button).backgroundColor);
    expect(pressedBackground).not.toBe("rgba(0, 0, 0, 0)");
    await capture(page, `pas-${width}-pressed`);
    await page.mouse.up();
    await expect(screen.locator(".persistent-session-tasks")).toBeVisible();
    await expect(taskToggle).toHaveCount(0);
    await expect(page.getByRole("button", { name: "작업 목록 닫기", exact: true })).toBeVisible();
    await capture(page, `pas-${width}-tasks-open`);

    expect(errors).toEqual([]);
  });
}
