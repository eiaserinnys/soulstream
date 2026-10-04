import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const evidence = path.resolve("../.local/artifacts/20261004-chat-history");
mkdirSync(evidence, { recursive: true });
type HistoryPage = { messages: Record<string, unknown>[]; next_cursor: string | null };
function historyPage(upper: number, count: number, cursor: string | null): HistoryPage {
  return {
    messages: Array.from({ length: count }, (_, index) => {
      const id = upper - index;
      return { id, parent_event_id: null, event_type: "user_message",
        payload: { text: `대화 ${id}\n읽던 위치를 확인합니다.\n스크롤만으로 이어집니다.`, timestamp: id },
        created_at: new Date(id * 1_000).toISOString() };
    }),
    next_cursor: cursor,
  };
}
function statePage(id: number, cursor: string): HistoryPage {
  return { messages: [{ id, event_type: "input_request_expired", payload: { request_id: "expired", timestamp: id } }], next_cursor: cursor };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(page: Page, pages: HistoryPage[], options: { holdOlder?: boolean; failCursor?: string; live?: boolean } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("soul-dashboard-theme", "dark");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  const synced = new Set<string>();
  const liveGate = gate();
  await page.route("**/api/sessions/*/events*", async route => {
    const session = new URL(route.request().url()).pathname.split("/")[3];
    if (!synced.has(session)) {
      synced.add(session);
      return route.fulfill({ contentType: "text/event-stream", body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 100, is_live: true, status: "completed" })}\n\n` });
    }
    if (options.live) {
      await liveGate.promise;
      options.live = false;
      return route.fulfill({ contentType: "text/event-stream; charset=utf-8", body: `id: 1001\nevent: assistant_message\ndata: ${JSON.stringify({ type: "assistant_message", content: "과거를 읽는 중 도착한 새 응답", timestamp: 1001, tool_use_id: "live-1001", _final_for_live_stream: true })}\n\n` });
    }
    return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
  });
  const cursors: (string | null)[] = [];
  const olderGate = gate();
  let concurrent = 0, maxConcurrent = 0, fail = Boolean(options.failCursor);
  await page.route("**/api/sessions/*/timeline?*", async route => {
    const url = new URL(route.request().url()), cursor = url.searchParams.get("before");
    if (url.pathname.includes("run-beta-1")) return route.fulfill({ json: historyPage(500, 20, null) });
    cursors.push(cursor);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      if (cursor && options.holdOlder) await olderGate.promise;
      if (cursor === options.failCursor && fail) {
        fail = false;
        return await route.fulfill({ status: 503, json: { error: "temporary failure" } });
      }
      const index = cursor === null ? 0 : pages.findIndex(p => p.next_cursor === cursor) + 1;
      await route.fulfill({ json: pages[index] ?? historyPage(0, 0, null) });
    } finally { concurrent -= 1; }
  });
  await page.goto("/?session=run-alpha-1");
  const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
  await expect(root).toBeVisible();
  const scroller = root.locator('[data-virtuoso-scroller="true"]');
  await expect(scroller).toBeVisible();
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight)).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  return { root, scroller, cursors, maxConcurrent: () => maxConcurrent,
    releaseOlder: () => { options.holdOlder = false; olderGate.resolve(); },
    sendLive: liveGate.resolve };
}
async function movePointer(page: Page, scroller: Locator) {
  const box = await scroller.boundingBox();
  if (!box) throw new Error("채팅 스크롤 영역이 없습니다.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
async function wheelToTop(page: Page, scroller: Locator) {
  await movePointer(page, scroller);
  await page.mouse.wheel(0, -(await scroller.evaluate(el => el.scrollHeight)));
}
async function anchor(scroller: Locator) {
  return scroller.evaluate(el => {
    const viewport = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]")).map(marker => {
      const rects = Array.from(marker.children).map(row => row.getBoundingClientRect());
      return { key: marker.dataset.chatItemKey!, top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) };
    }).filter(row => row.bottom > viewport.top && row.top < viewport.bottom).sort((a, b) => a.top - b.top);
    if (!rows[0]) throw new Error("첫 가시 행이 없습니다.");
    return { key: rows[0].key, offset: rows[0].top - viewport.top, observedKey: (el as HTMLElement).dataset.chatFirstVisibleKey };
  });
}
async function bottomDistance(scroller: Locator) {
  return scroller.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop));
}
async function keyPosition(scroller: Locator, key: string) {
  return scroller.evaluate((el, targetKey) => {
    const viewport = el.getBoundingClientRect();
    const marker = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]"))
      .find(row => row.dataset.chatItemKey === targetKey);
    const rects = marker ? Array.from(marker.children).map(row => row.getBoundingClientRect()) : [];
    return {
      key: targetKey,
      offset: rects.length ? Math.min(...rects.map(row => row.top)) - viewport.top : null,
      visible: rects.length > 0 && Math.max(...rects.map(row => row.bottom)) > viewport.top
        && Math.min(...rects.map(row => row.top)) < viewport.bottom,
      viewportTop: viewport.top,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      retention: { ...((el as HTMLElement).dataset) },
    };
  }, key);
}
async function settledVisiblePosition(scroller: Locator, targetKey?: string) {
  let previous: Awaited<ReturnType<typeof keyPosition>> | null = null;
  let settled: { anchor: Awaited<ReturnType<typeof anchor>>; position: Awaited<ReturnType<typeof keyPosition>> } | null = null;
  let stableObservations = 0;
  await expect.poll(async () => {
    try {
      const current = await anchor(scroller);
      const position = await keyPosition(scroller, targetKey ?? current.key);
      const stable = position.visible && position.offset !== null && previous?.key === position.key
        && previous.offset !== null && Math.abs(position.offset - previous.offset) <= 0.5;
      stableObservations = stable ? stableObservations + 1 : 0;
      previous = position;
      settled = { anchor: current, position };
      return stableObservations >= 2;
    } catch {
      previous = null;
      stableObservations = 0;
      return false;
    }
  }, { intervals: [100] }).toBe(true);
  return settled!;
}
function recordEvidence(name: string, measurements: unknown) {
  writeFileSync(path.join(evidence, `${name}.json`), `${JSON.stringify(measurements, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ evidence: name, measurements }));
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: "disabled" });
}

// This is also run against origin/main to check that the browser reproduces the defect.
test("wheel arrival at top loads without another input", async ({ page }) => {
  const { scroller, cursors } = await setup(page, [historyPage(100, 20, "older-80"), statePage(80, "older-79"), historyPage(79, 20, null)]);
  expect(cursors).toEqual([null]);
  await wheelToTop(page, scroller);
  await expect.poll(() => cursors.filter(Boolean).length).toBe(2);
});

test("long entry, wheel pagination, retention, rapid input and history end", async ({ page }) => {
  const h = await setup(page, [historyPage(100, 40, "older-60"), historyPage(60, 40, "older-20"), historyPage(20, 20, null)], { holdOlder: true });
  await expect.poll(() => bottomDistance(h.scroller)).toBeLessThanOrEqual(2);
  expect(h.cursors).toEqual([null]);
  await expect(h.root.getByRole("button", { name: "이전 대화 더 불러오기", exact: true })).toHaveCount(0);
  await wheelToTop(page, h.scroller);
  await expect.poll(() => h.cursors.length).toBe(2);
  await expect.poll(() => h.scroller.evaluate(el => el.scrollTop)).toBe(0);
  for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(150);
  const before = await anchor(h.scroller);
  expect(before.observedKey).toBe(before.key);
  const beforePosition = await keyPosition(h.scroller, before.key);
  h.releaseOlder();
  await expect(h.root.getByText("대화 60", { exact: false }).first()).toBeAttached();
  await page.waitForTimeout(400);
  const after = await anchor(h.scroller);
  const afterPosition = await keyPosition(h.scroller, before.key);
  recordEvidence("prepend-offset", { before, after, beforePosition, afterPosition, cursors: h.cursors });
  expect(afterPosition.offset).not.toBeNull();
  expect(afterPosition.visible).toBe(true);
  expect(Math.abs((afterPosition.offset ?? Infinity) - beforePosition.offset!)).toBeLessThanOrEqual(2);
  await screenshot(page, "wheel-loaded");
  await wheelToTop(page, h.scroller);
  await expect.poll(() => h.cursors.length).toBe(3);
  await wheelToTop(page, h.scroller);
  await expect(h.root.getByText(/Beginning of conversation/)).toBeVisible();
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(400);
  expect(h.cursors).toEqual([null, "older-60", "older-20"]);
  expect(h.maxConcurrent()).toBe(1);
  recordEvidence("wheel-complete", { cursors: h.cursors, maxConcurrent: h.maxConcurrent() });
});

test("keyboard Home loads older messages", async ({ page }) => {
  const h = await setup(page, [historyPage(100, 40, "older-60"), historyPage(60, 40, null)]);
  await h.scroller.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => h.cursors.length).toBe(2);
});

test("native scrollbar drag loads older messages", async ({ page }) => {
  const h = await setup(page, [historyPage(100, 40, "older-60"), historyPage(60, 40, null)]);
  await expect.poll(() => bottomDistance(h.scroller)).toBeLessThanOrEqual(2);
  const geometry = await h.scroller.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.right - 3, top: r.top, height: el.clientHeight, total: el.scrollHeight, gutter: (el as HTMLElement).offsetWidth - el.clientWidth };
  });
  test.skip(geometry.gutter === 0, "Headless Chromium exposes no draggable scrollbar gutter.");
  const thumbHeight = geometry.height * geometry.height / geometry.total;
  await page.mouse.move(geometry.x, geometry.top + geometry.height - thumbHeight / 2);
  await page.mouse.down();
  await page.mouse.move(geometry.x, geometry.top + thumbHeight / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => h.cursors.length).toBe(2);
});

for (const stateOnly of [false, true]) test(`initial ${stateOnly ? "zero-row" : "short"} page fills without input`, async ({ page }) => {
  const first = stateOnly ? statePage(100, "older-99") : historyPage(100, 1, "older-99");
  const h = await setup(page, [first, historyPage(99, 40, null)]);
  await expect.poll(() => h.cursors.length).toBe(2);
  await expect.poll(() => bottomDistance(h.scroller)).toBeLessThanOrEqual(2);
  await screenshot(page, stateOnly ? "zero-row-filled" : "short-filled");
});

test("error pauses automatic loading and retry resumes", async ({ page }) => {
  const h = await setup(page, [historyPage(100, 40, "older-60"), historyPage(60, 40, "older-20"), historyPage(20, 20, null)], { failCursor: "older-60" });
  await wheelToTop(page, h.scroller);
  const retry = h.root.getByRole("button", { name: "이전 대화를 불러오지 못했습니다. 다시 시도", exact: true });
  await expect(retry).toBeVisible();
  await screenshot(page, "error-retry");
  const attempts = h.cursors.length;
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(400);
  expect(h.cursors.length).toBe(attempts);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await wheelToTop(page, h.scroller);
  await expect.poll(() => h.cursors.at(-1)).toBe("older-20");
});

test("late A response cannot enter session B", async ({ page }) => {
  const h = await setup(page, [historyPage(100, 40, "older-60"), historyPage(60, 40, null)], { holdOlder: true });
  await expect.poll(() => bottomDistance(h.scroller)).toBeLessThanOrEqual(2);
  await wheelToTop(page, h.scroller);
  await expect.poll(() => h.cursors.length).toBe(2);
  await page.route("**/cogito/search**", route => route.fulfill({ json: {
    results: [],
    session_results: [{ session_id: "run-beta-1", title: "모바일 탭 구현", excerpt: "전환할 세션 B", updated_at: "2026-10-04T00:00:00Z",
      evidence: [], session_url: "/?session=run-beta-1",
      best_match: { event_id: null, match_source: "session_title", excerpt: "전환할 세션 B" } }],
  } }));
  await page.keyboard.press("Control+K");
  const search = page.getByRole("dialog", { name: "세션 기록 검색" });
  await search.getByPlaceholder("검색어를 입력하세요...").fill("모바일");
  await search.getByText("전환할 세션 B", { exact: true }).click();
  await expect(search).toHaveCount(0);
  const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
  await expect(root.getByText("대화 500", { exact: false }).first()).toBeAttached();
  h.releaseOlder();
  await page.waitForTimeout(400);
  await expect(root.getByText("대화 60", { exact: false })).toHaveCount(0);
  recordEvidence("session-switch", { cursors: h.cursors, url: page.url(), sessionBVisible: true, staleAAbsent: true });
});

test("live SSE while reading history preserves the visible row", async ({ page }) => {
  const h = await setup(page, [historyPage(100, 40, "older-60"), historyPage(60, 40, null)], { holdOlder: true, live: true });
  await expect.poll(() => bottomDistance(h.scroller)).toBeLessThanOrEqual(2);
  await wheelToTop(page, h.scroller);
  await expect.poll(() => h.cursors.length).toBe(2);
  await expect.poll(() => h.scroller.evaluate(el => el.scrollTop)).toBe(0);
  const beforePrepend = await settledVisiblePosition(h.scroller);
  h.releaseOlder();
  await expect(h.root.getByText("대화 60", { exact: false }).first()).toBeAttached();
  await expect.poll(() => h.scroller.getAttribute("data-chat-viewport-retention-pending")).not.toBe("true");
  const settled = await settledVisiblePosition(h.scroller, beforePrepend.position.key);
  const before = settled.position;
  const beforePosition = settled.position;
  const viewportHeight = await h.scroller.evaluate(el => el.clientHeight);
  const distanceBefore = await bottomDistance(h.scroller);
  expect(beforePosition.offset).not.toBeNull();
  expect(beforePosition.visible).toBe(true);
  expect(distanceBefore).toBeGreaterThan(viewportHeight);
  const liveResponse = page.waitForResponse(async response =>
    response.url().includes("/events") && (await response.text()).includes("id: 1001\n"));
  h.sendLive();
  await liveResponse;
  await expect(h.root.getByRole("button", { name: /New Messages/ })).toBeVisible();
  await page.waitForTimeout(300);
  const afterPosition = await keyPosition(h.scroller, before.key);
  const after = await anchor(h.scroller).catch(() => null);
  const distanceAfter = await bottomDistance(h.scroller);
  recordEvidence("sse-offset", { beforePrepend, before, after, beforePosition, afterPosition,
    viewportHeight, distanceBefore, distanceAfter, cursors: h.cursors });
  await screenshot(page, "sse-after");
  expect(afterPosition.offset).not.toBeNull();
  expect(afterPosition.visible).toBe(true);
  expect(Math.abs((afterPosition.offset ?? Infinity) - beforePosition.offset!)).toBeLessThanOrEqual(2);
  expect(distanceAfter).toBeGreaterThan(viewportHeight);
});
