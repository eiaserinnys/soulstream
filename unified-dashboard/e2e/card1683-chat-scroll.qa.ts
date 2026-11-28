import { koreanLocale } from "./korean-locale.mjs";
import type { Browser, Locator, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// 캡처와 측정 출력, 개발 서버 기준 경로는 실행한 cwd와 상관없이 스크립트 파일 위치로 푼다.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(repoRoot, ".local/card1744");

// 이 리포는 playwright를 선언 의존성으로 갖지 않는다. 실행기가 PLAYWRIGHT_MODULE을 넘기지
// 않아도 돌도록 @playwright/test의 의존 경로에서 직접 푼다(run-v3-qa.mjs와 같은 방식).
if (!process.env.PLAYWRIGHT_MODULE) {
  try {
    const dashboardRequire = createRequire(path.join(repoRoot, "unified-dashboard/package.json"));
    const fromTest = createRequire(dashboardRequire.resolve("@playwright/test/package.json"));
    const entry = fromTest.resolve("playwright");
    const mjs = path.join(path.dirname(entry), "index.mjs");
    process.env.PLAYWRIGHT_MODULE = pathToFileURL(existsSync(mjs) ? mjs : entry).href;
  } catch {
    // 해석에 실패하면 실행기의 기본 해석(import "playwright")을 그대로 쓴다.
  }
}
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
async function sessionRoutes(page: Page, theme: "dark" | "light" = "dark") {
  await page.addInitScript((themeName) => {
    localStorage.setItem("soulstream-pas-device:qa@example.com", JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }));
    localStorage.setItem("soul-dashboard-theme", themeName);
    localStorage.setItem("ls.webglGlass", "0");
  }, theme);
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
const followButton = (root: Locator) => root.getByRole("button", { name: "자동 스크롤", exact: true });

async function chatPage(browser: Browser, width: number, height: number, deliverLive = false, fixedClock = true, theme: "dark" | "light" = "dark") {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", timezoneId: "Asia/Seoul", colorScheme: theme, locale: koreanLocale });
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
  await sessionRoutes(page, theme);
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
  const [follow, input, inputFrame, scroller] = await Promise.all([
    rectangle(followButton(root)),
    rectangle(root.locator('[data-slot="chat-input-composer"]')),
    rectangle(root.locator('[data-testid="chat-input"]')),
    rectangle(root.locator('[data-virtuoso-scroller="true"]')),
  ]);
  // 겹침 묶음(absolute)과 그 기준인 흐름 래퍼의 높이. 흐름 래퍼가 0이어야 단추가 한 줄을 차지하지 않는다.
  const followWrapperHeight = await followButton(root).evaluate(el => {
    const group = el.parentElement;
    const base = group?.parentElement ?? null;
    return {
      base: base?.getBoundingClientRect().height ?? null,
      group: group?.getBoundingClientRect().height ?? null,
    };
  }, undefined, { timeout: 5000 });
  // 목록 아래 끝과 입력창 위 끝 사이에 흐름 높이를 가진 요소가 있으면 단추가 한 줄을 차지한 것이다.
  const gap = await root.evaluate(rootEl => {
    const scroller = rootEl.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
    const input = rootEl.querySelector<HTMLElement>('[data-slot="chat-input-composer"]');
    if (!scroller || !input) return null;
    const top = scroller.getBoundingClientRect().bottom;
    const bottom = input.getBoundingClientRect().top;
    const elements: string[] = [];
    for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>("*"))) {
      if (el === scroller || el === input || scroller.contains(el) || input.contains(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0.5 && rect.top >= top - 0.5 && rect.bottom <= bottom + 0.5) {
        elements.push(`${el.tagName.toLowerCase()}${el.dataset.slot ? `[data-slot=${el.dataset.slot}]` : ""}:${rect.height.toFixed(1)}`);
      }
    }
    return { height: bottom - top, elements };
  }, undefined, { timeout: 5000 });
  // 단추가 작은 원(32px)이고 아이콘 색을 읽을 수 있는지 잰다. 곡률이 %면 폭 기준으로 푼다.
  const followCap = await followButton(root).evaluate(el => {
    const rect = el.getBoundingClientRect();
    const radiusText = getComputedStyle(el).borderTopLeftRadius;
    const radius = radiusText.endsWith("%")
      ? (Number.parseFloat(radiusText) / 100) * rect.width
      : Number.parseFloat(radiusText);
    const icon = el.querySelector("svg");
    return { width: rect.width, height: rect.height, radius, color: icon ? getComputedStyle(icon).color : null };
  }, undefined, { timeout: 5000 });
  return { follow, input, inputFrame, scroller, followWrapperHeight, gap, followCap };
}

type ControlGeometry = Awaited<ReturnType<typeof controlGeometry>>;

function checkOverlap(
  { follow, scroller, followWrapperHeight, gap, followCap }: ControlGeometry,
  label: string,
  check: (condition: boolean, label: string) => void,
) {
  const right = scroller.right - follow.right;
  const bottom = scroller.bottom - follow.bottom;
  check(Math.abs(right - 15) <= 1, `${label} 자동 스크롤 오른쪽 간격 ${right.toFixed(1)}px`);
  check(Math.abs(bottom - 15) <= 1, `${label} 자동 스크롤 아래 간격 ${bottom.toFixed(1)}px`);
  check(
    follow.left >= scroller.left && follow.right <= scroller.right
      && follow.top >= scroller.top && follow.bottom <= scroller.bottom,
    `${label} 자동 스크롤이 목록 스크롤 영역 안`,
  );
  check(Math.abs(followCap.width - 32) <= 1 && Math.abs(followCap.height - 32) <= 1,
    `${label} 자동 스크롤 32px 크기 (${followCap.width.toFixed(1)}x${followCap.height.toFixed(1)})`);
  check(followCap.radius >= followCap.width / 2 - 0.5,
    `${label} 자동 스크롤 원형 곡률 ${followCap.radius.toFixed(1)}px`);
  check(followWrapperHeight.base !== null && followWrapperHeight.base <= 0.5,
    `${label} 자동 스크롤 흐름 래퍼 높이 0 (${JSON.stringify(followWrapperHeight)})`);
  check(gap !== null && gap.elements.length === 0,
    `${label} 목록과 입력창 사이 높이 있는 요소 없음 (${JSON.stringify(gap)})`);
}

async function controlScenario(browser: Browser, baseUrl: string, width: number, theme: "dark" | "light" = "dark") {
  const { context, page, live } = await chatPage(browser, width, width === 1440 ? 900 : 844, true, true, theme);
  const results: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];
  function check(condition: boolean, label: string) {
    checks[label] = condition;
    if (!condition) errors.push(label);
  }
  const checkOverlapAt = (geometry: ControlGeometry, label: string) => checkOverlap(geometry, label, check);
  async function checkBannerTogether(target: Locator, width: number, label: string) {
    const [banner, follow, scroller, inputFrame] = await Promise.all([
      rectangle(bannerButton(target)),
      rectangle(followButton(target)),
      rectangle(target.locator('[data-virtuoso-scroller="true"]')),
      rectangle(target.locator('[data-testid="chat-input"]')),
    ]);
    results[`together-${label}`] = { banner, follow, scroller, inputFrame };
    const disjoint = banner.right <= follow.left || follow.right <= banner.left
      || banner.bottom <= follow.top || follow.bottom <= banner.top;
    check(disjoint, `${label} 배너와 자동 스크롤 겹침 (${JSON.stringify({ banner, follow })})`);
    for (const [name, rect] of [["배너", banner], ["자동 스크롤", follow]] as const) {
      check(rect.left >= scroller.left - 0.5 && rect.right <= scroller.right + 0.5
        && rect.top >= scroller.top - 0.5 && rect.bottom <= scroller.bottom + 0.5,
        `${label} ${name} 목록 영역 안 (잘림 없음) (${JSON.stringify({ rect, scroller })})`);
      check(rect.left >= 0 && rect.right <= width, `${label} ${name} 화면 폭 안 (${rect.left}..${rect.right})`);
    }
    const verticalShift = (banner.top + banner.bottom) / 2 - (follow.top + follow.bottom) / 2;
    check(Math.abs(verticalShift) <= 1, `${label} 배너와 자동 스크롤 세로 중심 차이 ${verticalShift.toFixed(1)}px`);
    const centerShift = (banner.left + banner.right) / 2 - (scroller.left + scroller.right) / 2;
    check(Math.abs(centerShift) <= 1, `${label} 배너 가로 중심과 목록 중심 차이 ${centerShift.toFixed(1)}px`);
    const sideGap = follow.left - banner.right;
    check(sideGap >= 8, `${label} 배너 오른쪽 끝과 자동 스크롤 왼쪽 끝 사이 ${sideGap.toFixed(1)}px`);
    const seatDifference = inputFrame.top - scroller.bottom;
    check(Math.abs(seatDifference) <= 1, `${label} 목록 아래 끝과 입력창 위 끝 차이 ${seatDifference.toFixed(1)}px`);
    // 겹침 묶음의 빈 영역이 목록을 막지 않는지: 배너 높이에서 목록 왼쪽 + 40px 지점이 목록 안 요소여야 한다.
    const hit = await target.evaluate((rootEl, point) => {
      const scroller = rootEl.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
      const el = document.elementFromPoint(point.x, point.y);
      return {
        hit: el ? `${el.tagName.toLowerCase()}${el.getAttribute("data-chat-item-key") ? `[${el.getAttribute("data-chat-item-key")}]` : ""}` : null,
        inside: !!el && !!scroller && scroller.contains(el),
      };
    }, { x: scroller.left + 40, y: (banner.top + banner.bottom) / 2 }, { timeout: 5000 });
    results[`hit-${label}`] = hit;
    check(hit.inside, `${label} 배너 높이 목록 왼쪽+40px 지점이 목록 안 요소 (${JSON.stringify(hit)})`);
  }
  const screenshot = (state: string) => page.screenshot({
    path: path.join(output, `${phase}-controls-${theme}-${width}-${state}.png`), animations: "disabled",
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
    const on = await controlGeometry(root);
    results.on = on;
    checkOverlapAt(on, "자동 스크롤 켜짐");
    check(await follow.getAttribute("aria-pressed") === "true", "초기 자동 스크롤 aria-pressed");
    check(on.followCap.color !== null, `자동 스크롤 아이콘 색 읽기 (${on.followCap.color})`);
    await screenshot("on");
    await follow.click();
    check(await follow.getAttribute("aria-pressed") === "false", "자동 스크롤 off aria-pressed");
    check(await focused(follow), "자동 스크롤 off 뒤 초점");
    const offColor = await follow.evaluate(el => {
      const icon = el.querySelector("svg");
      return icon ? getComputedStyle(icon).color : null;
    }, undefined, { timeout: 5000 });
    check(offColor !== null && offColor !== on.followCap.color,
      `자동 스크롤 아이콘 색 켜짐/꺼짐 (${on.followCap.color} vs ${offColor})`);
    await scroller.hover();
    await page.mouse.wheel(0, -1200);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-chat-scroller]')!;
      return el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight;
    }, undefined, { timeout: 10000 });
    const off = await controlGeometry(root);
    results.off = off;
    checkOverlapAt(off, "자동 스크롤 꺼짐");
    check(!await banner.isVisible(), "새 이벤트 전 배너 표시");
    await screenshot("off");
    live.release();
    await banner.waitFor({ state: "visible", timeout: 30000 });
    const shown = await controlGeometry(root);
    results.message = shown;
    checkOverlapAt(shown, "배너 보임");
    await checkBannerTogether(root, width, `배너 보임 ${width}`);
    check(Math.abs(shown.follow.top - off.follow.top) <= 1
      && Math.abs(shown.follow.left - off.follow.left) <= 1, "배너 표시 전후 자동 스크롤 위치");
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
      checkOverlapAt(narrow, "360폭");
      check(narrow.follow.left >= 0 && narrow.follow.right <= 360, "360폭 자동 스크롤 잘림");
      await checkBannerTogether(root, 360, "360폭 배너");
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
        checkOverlapAt(layout, `크기 변경 ${next}`);
        check(layout.input.top >= 0 && layout.input.bottom <= height, `크기 변경 ${next} 입력창 화면 안`);
        check(await banner.isVisible(), `크기 변경 ${next} 배너 유지`);
        await checkBannerTogether(root, next, `크기 변경 ${next} 배너`);
        check(key !== null && key === original, `크기 변경 ${next} 첫 행 유지 (${original} → ${key})`);
        check(Math.abs(top - originalScrollTop) <= 2, `크기 변경 ${next} 스크롤 위치 유지`);
        check(await textarea.inputValue() === draft, `크기 변경 ${next} 입력 유지`);
        await screenshot(`resize-${next}`);
      }
    }

    await banner.focus();
    await page.keyboard.press("Enter");
    await banner.waitFor({ state: "hidden" });
    check(await follow.getAttribute("aria-pressed") === "true", "새 메시지로 이동 뒤 자동 스크롤 on");
    await root.getByText("새 응답이 도착했습니다.", { exact: false }).waitFor({ state: "visible" });
    await follow.click();
    await follow.click();
    check(await follow.getAttribute("aria-pressed") === "true" && await focused(follow), "자동 스크롤 on 뒤 상태와 초점");
    if (width === 390) {
      // 360폭의 켜짐 화면. 켜면 새 메시지 배너가 닫히므로 배너 검사 뒤 맨 끝에서 찍는다.
      await page.setViewportSize({ width: 360, height: 844 });
      await page.waitForTimeout(200);
      await screenshot("360-on");
      await page.setViewportSize({ width: 390, height: 844 });
    }
  } catch (error) {
    errors.push(String(error));
    await screenshot("failure");
  } finally {
    writeFileSync(path.join(output, `${phase}-controls-${theme}-${width}.json`), JSON.stringify({ ...results, checks, errors }, null, 2));
    live.release();
    await context.close();
  }
  assert(before || errors.length === 0, `${theme} ${width} 조작 검사: ${errors.join(", ")}`);
}
async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); }); }
const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("corepack", ["pnpm", "--dir", "unified-dashboard", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: repoRoot, env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:5200" }, stdio: "inherit", detached: true });
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
    for (const theme of ["dark", "light"] as const) {
      for (const width of [1440, 390]) await run(`controls-${theme}-${width}`, () => controlScenario(browser, baseUrl, width, theme));
    }
    assert(failures.length === 0, failures.join("\n"));
  });
} finally {
  if (server.pid && server.exitCode === null) { process.kill(-server.pid, "SIGTERM"); await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5000)]); }
}
