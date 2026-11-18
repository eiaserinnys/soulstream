import type { Browser, Locator, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve(".local/card1683");
mkdirSync(output, { recursive: true });
// Baseline and CSS isolation preserve failing evidence without passing the normal QA run.
const before = process.env.CARD1683_BEFORE === "1";
const isolateListTransition = before && process.env.CARD1683_ISOLATE_LIST_TRANSITION === "1";
const phase = process.env.CARD1683_PHASE ?? (before ? "before" : "after");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function historyPage(upper: number, count: number, next_cursor: string | null) {
  return { messages: Array.from({ length: count }, (_, index) => {
    const id = upper - index;
    return { id, parent_event_id: null, event_type: "user_message", payload: { text: `대화 ${id}\n읽던 위치를 확인합니다.\n스크롤만으로 이어집니다.`, timestamp: id }, created_at: new Date(id * 1000).toISOString() };
  }), next_cursor };
}
const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_models: [], show_generation_separator: true, show_character: false, animate_character: false, show_jev_candidates: true, turn_usage_mode: "collapsed", show_turn_usage: true };
const persistentSession = { session_id: "run-alpha-2", display_name: "시각 검수 세션", node_id: "eiaserinnys", folder_id: "rb-alpha", agent_id: "roselin_codex", agent_name: "로젤린", persistent: true, settings, runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null } };
async function sessionRoutes(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("soulstream-pas-device:qa@example.com", JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }));
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.com", name: "QA" } } }));
  await page.route("**/api/persistent-sessions**", route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions: [persistentSession], total: 1, create_defaults: null } });
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions/run-alpha-2") return route.fulfill({ json: { session: persistentSession } });
    return route.fallback();
  });
}
type HistoryTarget = "mid" | "final";
const chatRoot = (page: Page) => page.locator('[data-slot="chat-root"]').filter({ visible: true });
const bannerButton = (root: Locator) => root.getByRole("button", { name: "↓ 새 메시지", exact: true });
const followButton = (root: Locator) => root.getByRole("button", { name: "↓ 자동 스크롤", exact: true });

async function chatPage(browser: Browser, width: number, height: number, deliverLive = false, fixedClock = true) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", timezoneId: "Asia/Seoul", colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  if (process.env.CARD1683_TRACE === "1") await page.addInitScript(() => {
    const trace: unknown[] = [];
    Object.assign(window, { card1683Trace: trace });
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    function log(el: Element, operation: string, argument: unknown) {
      if (!el.matches("[data-chat-scroller]")) return;
      const list = el.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
      trace.push({ time: performance.now(), operation, argument, top: descriptor.get!.call(el),
        height: el.scrollHeight, listTop: list?.offsetTop, listHeight: list?.offsetHeight,
        listStyle: list?.getAttribute("style") });
    }
    for (const key of ["scrollBy", "scrollTo"] as const) {
      const original = Element.prototype[key];
      Object.defineProperty(Element.prototype, key, {
        value(this: Element, ...args: unknown[]) {
          log(this, key, args);
          return Reflect.apply(original, this, args);
        },
      });
    }
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...descriptor,
      set(this: Element, value: number) {
        log(this, "set", value);
        descriptor.set!.call(this, value);
      },
    });
  });
  // Playwright clock fakes requestAnimationFrame, setTimeout and performance.now. Virtuoso and the
  // viewport retention then run frame callbacks apart from layout and ResizeObserver delivery, so the
  // history timing scenario keeps the browser clock.
  if (fixedClock) await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await installV3VisualQaRoutes(page, {});
  await sessionRoutes(page);
  let synced = false;
  let sentLive = false;
  const live = gate();
  await page.route(url => url.pathname === "/api/sessions/run-alpha-2/events", route => {
    if (!synced) { synced = true; return route.fulfill({ contentType: "text/event-stream", body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 100, is_live: true, status: "running" })}\n\n` }); }
    if (deliverLive && !sentLive) {
      sentLive = true;
      return live.promise.then(() => route.fulfill({
        contentType: "text/event-stream",
        body: `id: 101\nevent: assistant_message\ndata: ${JSON.stringify({ type: "assistant_message", timestamp: 101, content: "새 응답이 도착했습니다. 이전 대화를 읽은 다음 확인할 수 있습니다.", tool_use_id: "card1683-live-101", _final_for_live_stream: true })}\n\n`,
      }));
    }
    return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
  });
  return { context, page, live };
}

async function openChat(page: Page, baseUrl: string, width: number) {
  await page.goto(`${baseUrl}/?session=run-alpha-2`, { waitUntil: "domcontentloaded" });
  if (width < 500) await page.getByTestId("v3-mobile-tab-chat").click();
  await chatRoot(page).locator('[data-virtuoso-scroller="true"]').waitFor({ state: "visible", timeout: 30000 });
}

async function historyScenario(browser: Browser, baseUrl: string, width: number, target: HistoryTarget) {
  const { context, page } = await chatPage(browser, width, width === 1440 ? 1000 : 844, false, false);
  const held = gate();
  let requested = false;
  const network: { cursor: string | null; event: "request" | "response"; at: number }[] = [];
  await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), async route => {
    const cursor = new URL(route.request().url()).searchParams.get("before");
    network.push({ cursor, event: "request", at: performance.now() });
    if ((target === "mid" && cursor === "older-60") || (target === "final" && cursor === "older-20")) { requested = true; await held.promise; }
    const data = cursor === null ? historyPage(100, 40, "older-60") : cursor === "older-60" ? historyPage(60, 40, "older-20") : historyPage(20, 20, null);
    await route.fulfill({ json: data });
    network.push({ cursor, event: "response", at: performance.now() });
  });
  try {
    await openChat(page, baseUrl, width);
    const root = chatRoot(page);
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor({ state: "visible", timeout: 30000 });
    if (isolateListTransition) await page.addStyleTag({
      content: '.v3-shell [data-testid="virtuoso-item-list"] { transition-property: none !important; }',
    });
    await page.waitForTimeout(1000);
    const wheel = async () => { const box = await scroller.boundingBox(); assert(box, "스크롤 영역 없음"); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -(await scroller.evaluate(el => el.scrollHeight))); };
    for (let i = 0; i < 40 && !requested; i++) { await wheel(); await page.waitForTimeout(500); }
    assert(requested, `${target}: 페이지 요청 없음 ${JSON.stringify(network)}`);
    await page.waitForTimeout(800); await wheel(); await page.waitForTimeout(900);
    const key = target === "mid" ? "user-msg-61" : "user-msg-21";
    const position = () => scroller.evaluate((el, targetKey) => {
      const marker = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]")).find(row => row.dataset.chatItemKey === targetKey);
      const rects = marker ? Array.from(marker.children).map(row => row.getBoundingClientRect()) : [];
      const root = el.closest<HTMLElement>('[data-slot="chat-root"]')!;
      const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-item-index]"));
      const first = rows[0];
      const last = rows.at(-1);
      const list = el.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
      const listStyle = list ? getComputedStyle(list) : null;
      const describe = (row: HTMLElement | undefined) => ({
        key: row?.querySelector<HTMLElement>("[data-chat-item-key]")?.dataset.chatItemKey,
        index: row?.dataset.itemIndex,
        dataIndex: row?.dataset.index,
      });
      return {
        at: performance.now(),
        offset: rects.length ? Math.min(...rects.map(rect => rect.top)) - el.getBoundingClientRect().top : null,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        firstItemIndex: Number(root.dataset.chatFirstItemIndex),
        count: Number(root.dataset.chatItemCount),
        prependedCount: Number(root.dataset.chatPrependedCount),
        first: describe(first),
        last: describe(last),
        spacer: list?.getAttribute("style"),
        layout: listStyle && {
          top: list?.offsetTop, height: list?.offsetHeight,
          paddingTop: listStyle.paddingTop, paddingBottom: listStyle.paddingBottom,
          display: listStyle.display, flex: listStyle.flex,
          transition: listStyle.transition, marginTop: listStyle.marginTop,
        },
        retention: { ...(el as HTMLElement).dataset },
        banner: Array.from(root.querySelectorAll("button")).some(button => button.textContent?.includes("새 메시지")),
      };
    }, key);
    const initial = await position();
    await page.screenshot({ path: path.join(output, `${phase}-${width}-${target}-held.png`), animations: "disabled" });
    const browserStart = await page.evaluate(() => performance.now());
    const samples = []; const start = performance.now(); held.release();
    for (let i = 0; i <= 120; i++) {
      await pause(Math.max(0, start + i * 25 - performance.now()));
      const { at, ...measurement } = await position();
      samples.push({ scheduledMs: i * 25, ms: Math.round(at - browserStart), ...measurement });
    }
    const trace = await page.evaluate(start => {
      const entries = (window as Window & { card1683Trace?: { time: number }[] }).card1683Trace ?? [];
      return entries.filter(entry => entry.time >= start).map(({ time, ...entry }) => ({ ms: Math.round(time - start), ...entry }));
    }, browserStart);
    const result = { width, target, key, network: network.map(({ at, ...entry }) => ({ ...entry, ms: Math.round(at - start) })), initial, samples, trace };
    writeFileSync(path.join(output, `${phase}-${width}-${target}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: path.join(output, `${phase}-${width}-${target}.png`), animations: "disabled" });
    console.log(JSON.stringify({ width, target, initial, min: Math.min(...samples.map(x => x.offset ?? Infinity)), max: Math.max(...samples.map(x => x.offset ?? -Infinity)), missing: samples.filter(x => x.offset === null).length, banner: samples.some(x => x.banner) }));
    if (!before) {
      assert(initial.offset !== null, `${width} ${target} 기준 행 없음`);
      assert(samples.some(sample => sample.count > initial.count && sample.prependedCount > initial.prependedCount),
        `${width} ${target} 붙임 반영 없음`);
      assert(samples.every(x => x.offset !== null && Math.abs(x.offset - initial.offset!) <= 2), `${width} ${target} 행 위치 변화`);
      assert(samples.every(x => !x.banner), `${width} ${target} 이력 배너 오표시`);
    }
    return result;
  } finally { held.release(); await context.close(); }
}

function rectangle(locator: Locator) {
  return locator.evaluate(el => {
    const { left, right, top, bottom, height, width } = el.getBoundingClientRect();
    return { left, right, top, bottom, height, width };
  }, undefined, { timeout: 5000 });
}

async function controlGeometry(root: Locator) {
  const banner = bannerButton(root);
  const [scroll, follow, send, input, message] = await Promise.all([
    rectangle(root.locator('[data-virtuoso-scroller="true"]')),
    rectangle(followButton(root)),
    rectangle(root.getByTestId("send-button")),
    rectangle(root.locator('[data-slot="chat-input-composer"]')),
    await banner.isVisible() ? rectangle(banner) : null,
  ]);
  return { scroll, follow, send, input, message };
}

function overlaps(a: Awaited<ReturnType<typeof rectangle>>, b: typeof a) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

async function controlScenario(browser: Browser, baseUrl: string, width: number) {
  const { context, page, live } = await chatPage(browser, width, width === 1440 ? 900 : 844, true);
  const results: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];
  function check(condition: boolean, label: string) {
    checks[label] = condition;
    if (!condition) errors.push(label);
  }
  const screenshot = (state: string) => page.screenshot({
    path: path.join(output, `${phase}-controls-${width}-${state}.png`), animations: "disabled",
  });
  try {
    await page.route(url => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname),
      route => route.fulfill({ json: historyPage(100, 100, null) }));
    await openChat(page, baseUrl, width);
    const root = chatRoot(page);
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    const follow = followButton(root);
    const banner = bannerButton(root);
    const textarea = root.getByRole("textbox");
    const focused = (locator: Locator) => locator.evaluate(el => el === el.ownerDocument.activeElement);
    await follow.waitFor({ state: "visible" });
    await root.locator('[data-chat-item-key="user-msg-100"]').waitFor({ state: "attached", timeout: 10000 });
    results.on = await controlGeometry(root);
    check(await follow.getAttribute("aria-pressed") === "true", "초기 자동 스크롤 aria-pressed");
    await screenshot("on");
    await follow.click();
    check(await follow.getAttribute("aria-pressed") === "false", "자동 스크롤 off aria-pressed");
    check(await focused(follow), "자동 스크롤 off 뒤 초점");
    await scroller.hover();
    await page.mouse.wheel(0, -1200);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-chat-scroller]')!;
      return el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight;
    }, undefined, { timeout: 10000 });
    const off = await controlGeometry(root);
    results.off = off;
    check(!await banner.isVisible(), "새 이벤트 전 배너 표시");
    await screenshot("off");
    live.release();
    await banner.waitFor({ state: "visible", timeout: 30000 });
    const shown = await controlGeometry(root);
    results.message = shown;
    function checkGeometry(geometry: typeof shown, label: string) {
      const { scroll, follow, input, message } = geometry;
      check(Math.abs(follow.right - input.right) <= 1, `${label} 자동 스크롤과 입력창 오른쪽 정렬`);
      if (message) {
        check(!overlaps(message, scroll), `${label} 배너와 목록 겹침`);
        check(!overlaps(message, follow), `${label} 두 단추 겹침`);
        check(Math.abs(message.top + message.height / 2 - follow.top - follow.height / 2) <= 1,
          `${label} 두 단추 세로 가운데`);
        check(Math.abs(message.height - follow.height) <= 1, `${label} 두 단추 높이`);
      }
    }
    checkGeometry(shown, "배너 보임");
    check(Math.abs(shown.scroll.height - off.scroll.height) <= 1, "배너 표시 전후 목록 높이");
    await screenshot("message");

    await scroller.focus();
    await page.keyboard.press("Tab");
    check(await focused(banner), "목록 다음 Tab은 새 메시지");
    await page.keyboard.press("Tab");
    check(await focused(follow), "새 메시지 다음 Tab은 자동 스크롤");
    await page.keyboard.press("Shift+Tab");
    check(await focused(banner), "자동 스크롤에서 Shift+Tab으로 새 메시지");

    if (width === 390) {
      await page.setViewportSize({ width: 360, height: 844 });
      await page.waitForTimeout(200);
      const narrow = await controlGeometry(root);
      results.narrow = narrow;
      checkGeometry(narrow, "360폭");
      check(narrow.message !== null && narrow.message.left >= 0 && narrow.follow.right <= 360, "360폭 단추 잘림");
      check(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1)
        && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "360폭 가로 스크롤");
      await screenshot("360");
      await page.setViewportSize({ width: 390, height: 844 });
    }

    if (width === 1440) {
      const draft = "창 크기 변경 중에도 작성 중인 메시지";
      await textarea.fill(draft);
      const firstVisible = () => scroller.evaluate(el => {
        const edge = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]"))
          .map(marker => ({ key: marker.dataset.chatItemKey, row: marker.firstElementChild?.getBoundingClientRect() }))
          .find(({ row }) => row && row.bottom > edge.top && row.top < edge.bottom)?.key ?? null;
      });
      const original = await firstVisible();
      const originalScrollTop = await scroller.evaluate(el => el.scrollTop);
      for (const next of [390, 1440]) {
        const height = next === 390 ? 844 : 900;
        await page.setViewportSize({ width: next, height });
        if (next === 390) await page.getByTestId("v3-mobile-tab-chat").click();
        await scroller.waitFor({ state: "visible" });
        await page.waitForTimeout(350);
        const layout = await controlGeometry(root);
        const key = await firstVisible();
        const top = await scroller.evaluate(el => el.scrollTop);
        results[`resize${next}`] = { layout, key, top, original, originalScrollTop };
        checkGeometry(layout, `크기 변경 ${next}`);
        check(layout.input.top >= 0 && layout.input.bottom <= height, `크기 변경 ${next} 입력창 화면 안`);
        check(layout.message !== null, `크기 변경 ${next} 배너 유지`);
        check(key !== null && key === original, `크기 변경 ${next} 첫 행 유지 (${original} → ${key})`);
        check(Math.abs(top - originalScrollTop) <= 2, `크기 변경 ${next} 스크롤 위치 유지`);
        check(await textarea.inputValue() === draft, `크기 변경 ${next} 입력 유지`);
        await screenshot(`resize-${next}`);
      }
    }

    await banner.focus();
    await page.keyboard.press("Enter");
    await banner.waitFor({ state: "hidden" });
    check(await focused(follow), "새 메시지로 이동 뒤 자동 스크롤 단추 초점");
    check(await follow.getAttribute("aria-pressed") === "true", "새 메시지로 이동 뒤 자동 스크롤 on");
    await root.getByText("새 응답이 도착했습니다.", { exact: false }).waitFor({ state: "visible" });
    await follow.click();
    await follow.click();
    check(await follow.getAttribute("aria-pressed") === "true" && await focused(follow), "자동 스크롤 on 뒤 상태와 초점");
  } catch (error) {
    errors.push(String(error));
    await screenshot("failure");
  } finally {
    writeFileSync(path.join(output, `${phase}-controls-${width}.json`), JSON.stringify({ ...results, checks, errors }, null, 2));
    live.release();
    await context.close();
  }
  assert(before || errors.length === 0, `${width} 조작 검사: ${errors.join(", ")}`);
}
async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); }); }
const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("corepack", ["pnpm", "--dir", "unified-dashboard", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:5200" }, stdio: "inherit", detached: true });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(`개발 서버 종료: ${server.exitCode}`); try { if ((await fetch(baseUrl)).ok) { ready = true; break; } } catch {} await pause(200); }
  assert(ready, "개발 서버 준비 시간 초과");
  await runPlaywrightLifecycle({ lockName: "card1683-chat-scroll", timeoutMs: 600000, launchOptions: { headless: true } }, async ({ browser }: { browser: Browser }) => {
    const failures: string[] = [];
    async function run(label: string, action: () => Promise<unknown>) {
      if (process.env.CARD1683_ONLY && process.env.CARD1683_ONLY !== label) return;
      try { await action(); } catch (error) { failures.push(`${label}: ${String(error)}`); }
    }
    for (const width of [1440, 390]) for (const target of ["mid", "final"] as const) {
      await run(`${width}-${target}`, () => historyScenario(browser, baseUrl, width, target));
    }
    for (const width of [1440, 390]) await run(`controls-${width}`, () => controlScenario(browser, baseUrl, width));
    assert(failures.length === 0, failures.join("\n"));
  });
} finally {
  if (server.pid && server.exitCode === null) { process.kill(-server.pid, "SIGTERM"); await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5000)]); }
}
