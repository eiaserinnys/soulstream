import type { Browser, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve(".local/card1683");
mkdirSync(output, { recursive: true });
const before = process.env.CARD1683_BEFORE === "1";
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
async function scenario(browser: Browser, baseUrl: string, width: number, target: "mid" | "final") {
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, reducedMotion: "reduce", timezoneId: "Asia/Seoul", colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await installV3VisualQaRoutes(page, {});
  await sessionRoutes(page);
  let synced = false;
  await page.route("**/api/sessions/*/events*", route => {
    if (!synced) { synced = true; return route.fulfill({ contentType: "text/event-stream", body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 100, is_live: true, status: "running" })}\n\n` }); }
    return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
  });
  const held = gate(); let requested = false; const cursors: (string | null)[] = [];
  await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), async route => {
    const cursor = new URL(route.request().url()).searchParams.get("before"); cursors.push(cursor);
    if ((target === "mid" && cursor === "older-60") || (target === "final" && cursor === "older-20")) { requested = true; await held.promise; }
    const data = cursor === null ? historyPage(100, 40, "older-60") : cursor === "older-60" ? historyPage(60, 40, "older-20") : historyPage(20, 20, null);
    await route.fulfill({ json: data });
  });
  try {
    await page.goto(`${baseUrl}/?session=run-alpha-2`, { waitUntil: "domcontentloaded" });
    if (width < 500) { await page.waitForTimeout(1500); await page.getByTestId("v3-mobile-tab-chat").click(); }
    const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(1000);
    const wheel = async () => { const box = await scroller.boundingBox(); assert(box, "스크롤 영역 없음"); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -(await scroller.evaluate(el => el.scrollHeight))); };
    for (let i = 0; i < 40 && !requested; i++) { await wheel(); await page.waitForTimeout(500); }
    assert(requested, `${target}: 페이지 요청 없음 ${JSON.stringify(cursors)}`);
    await page.waitForTimeout(800); await wheel(); await page.waitForTimeout(900);
    const key = target === "mid" ? "user-msg-61" : "user-msg-21";
    const position = () => scroller.evaluate((el, targetKey) => {
      const marker = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]")).find(row => row.dataset.chatItemKey === targetKey);
      const rects = marker ? Array.from(marker.children).map(row => row.getBoundingClientRect()) : [];
      return { offset: rects.length ? Math.min(...rects.map(rect => rect.top)) - el.getBoundingClientRect().top : null, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, retention: { ...(el as HTMLElement).dataset }, banner: el.parentElement?.textContent?.includes("새 메시지") ?? false };
    }, key);
    const initial = await position();
    await page.screenshot({ path: path.join(output, `${phase}-${width}-${target}-held.png`), animations: "disabled" });
    const samples = []; const start = performance.now(); held.release();
    for (let i = 0; i < 120; i++) { await pause(Math.max(0, start + i * 25 - performance.now())); samples.push({ ms: Math.round(performance.now() - start), ...(await position()) }); }
    const result = { width, target, key, cursors, initial, samples };
    writeFileSync(path.join(output, `${phase}-${width}-${target}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: path.join(output, `${phase}-${width}-${target}.png`), animations: "disabled" });
    console.log(JSON.stringify({ width, target, initial, min: Math.min(...samples.map(x => x.offset ?? Infinity)), max: Math.max(...samples.map(x => x.offset ?? -Infinity)), missing: samples.filter(x => x.offset === null).length, banner: samples.some(x => x.banner) }));
    if (!before) {
      assert(initial.offset !== null, `${width} ${target} 기준 행 없음`);
      assert(samples.every(x => x.offset !== null && Math.abs(x.offset - initial.offset!) <= 2), `${width} ${target} 행 위치 변화`);
      assert(samples.every(x => !x.banner), `${width} ${target} 이력 배너 오표시`);
    }
    return result;
  } finally { held.release(); await context.close(); }
}
async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); }); }
const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("corepack", ["pnpm", "--dir", "unified-dashboard", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:5200" }, stdio: "inherit", detached: true });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(`개발 서버 종료: ${server.exitCode}`); try { if ((await fetch(baseUrl)).ok) { ready = true; break; } } catch {} await pause(200); }
  assert(ready, "개발 서버 준비 시간 초과");
  await runPlaywrightLifecycle({ lockName: "card1683-chat-scroll", timeoutMs: 600000, launchOptions: { headless: true } }, async ({ browser }: { browser: Browser }) => {
    for (const width of [1440, 390]) for (const target of ["mid", "final"] as const) {
      if (!process.env.CARD1683_ONLY || process.env.CARD1683_ONLY === `${width}-${target}`) await scenario(browser, baseUrl, width, target);
    }
  });
  if (!before) throw new Error("배너·단추 배치와 키보드·화면 크기 변경 검증이 아직 구현되지 않았습니다.");
} finally {
  if (server.pid && server.exitCode === null) { process.kill(-server.pid, "SIGTERM"); await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5000)]); }
}
