/**
 * 카드 #1650 보완: 남은 영어 문구 한국어화와 대화 맨 위 표기 제거의 시각 검수.
 *
 * 검수 장면
 * 1. 플래너 실패 안내 1440 → 390 → 360: 기술 상세를 열어 요청 ID(UUID)가 상자 안에서
 *    낱말 중간에 끊기지 않고 가로로 넘치지 않는지 잰다.
 * 2. 카드 보드 실패 안내 360/390/1440: 같은 계측을 카드 보드 오류에도 한다.
 * 3. 대화 맨 위(1440/390): event=1 진입 뒤 마지막 이력 페이지를 붙잡아 두고, 풀린 뒤
 *    맨 위에서 마지막 휠을 한 번 더 굴렸을 때 첫 행 top 차이가 1px 이하인지 잰다.
 *    「대화의 시작」 표기가 DOM에 없어야 한다.
 * 4. 대화 한국어 문구(1440/390): 입력창 자리표시·「자동 스크롤」 아이콘 단추 접근 이름·「💭 생각」 이름표.
 * 5. 문서 패널 한국어 문구(1440/390): 기본 제목 「제목 없는 문서」·빈 본문 「빈 문서」·
 *    삭제 단추 툴팁/접근 이름 「문서 삭제」·제목/본문 접근 이름.
 * 6. 문서 패널 로딩 「불러오는 중」, 편집기 로딩 「편집기를 불러오는 중」.
 * 7. 전체 내용 보기 단추 로딩 「불러오는 중」(전문 요청 지연).
 * 8. 입력창 단추 이름(1440/390): 「보내기」·모드 「대화 이어가기」·첨부 「파일 첨부」의
 *    접근 이름/툴팁. 좁은 폭에서 단추가 입력창 밖으로 밀리거나 내용이 잘리지 않는지 잰다.
 * 9. 새 메시지 배너(1440/390): 실행 중 위로 스크롤한 뒤 새 이벤트가 도착하면
 *    「↓ 새 메시지」 배너가 뜨고, 실행 중 입력창 이름이 「개입」인지 확인한다.
 * 10. 따라가기 단추(1440/390, 누름/대조): 맨 아래에서 「자동 스크롤」을 누른 경우와
 *    누르지 않은 경우에 새 응답이 오면, 강조 상태·맨 아래 거리·새 메시지 배너가
 *    어떻게 달라지는지 견준다.
 *
 * 실행:
 *   VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43184 --strictPort
 *   PLAYWRIGHT_MODULE=$(realpath node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs) \
 *   V3_QA_BASE_URL=http://127.0.0.1:43184 \
 *   node soul-server-ts/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/card1650-keepall-korean.qa.ts
 *
 * V3_CARD1650_BASELINE=1 은 고치기 전(base) 계측용 이름표만 바꾼다.
 * 산출물은 unified-dashboard/e2e/evidence/card1650/ 에 저장한다.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43184";
const output = path.resolve(process.env.V3_CARD1650_OUTPUT ?? "unified-dashboard/e2e/evidence/card1650");
const baseline = process.env.V3_CARD1650_BASELINE === "1";
const suffix = baseline ? "before" : "after";
mkdirSync(output, { recursive: true });

const REQUEST_ID = "8dff6b9c-60a8-4c66-961c-b5c347fa9c0a";
const errorBody = {
  message: `upstream status 503 request_id: ${REQUEST_ID} https://soulstream.example.test/api/cards?folder_id=${REQUEST_ID}`,
  detail: `status 503 request_id: ${REQUEST_ID}`,
};

const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_models: [],
  show_generation_separator: true,
  show_character: false,
  animate_character: false,
  show_jev_candidates: true,
  turn_usage_mode: "collapsed" as const,
  show_turn_usage: true,
};
const persistentSession = {
  session_id: "run-alpha-2",
  display_name: "시각 검수 세션",
  node_id: "eiaserinnys",
  folder_id: "rb-alpha",
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};

async function ctx(browser: Browser, width: number, height = 1000) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    colorScheme: "dark",
  });
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  return { context, page };
}

async function installSessionRoutes(page: Page) {
  await page.addInitScript(() => localStorage.setItem(
    "soulstream-pas-device:qa@example.com",
    JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }),
  ));
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({
    json: { authenticated: true, user: { email: "qa@example.com", name: "QA" } },
  }));
  await page.route("**/api/persistent-sessions**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions") {
      return route.fulfill({ json: { sessions: [persistentSession], total: 1, create_defaults: null } });
    }
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions/run-alpha-2") {
      return route.fulfill({ json: { session: persistentSession } });
    }
    return route.fallback();
  });
}

function historyPage(upper: number, count: number, cursor: string | null) {
  return {
    messages: Array.from({ length: count }, (_, index) => {
      const id = upper - index;
      return {
        id,
        parent_event_id: null,
        event_type: "user_message",
        payload: { text: `대화 ${id}\n읽던 위치를 확인합니다.\n스크롤만으로 이어집니다.`, timestamp: id },
        created_at: new Date(id * 1_000).toISOString(),
      };
    }),
    next_cursor: cursor,
  };
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

/** chat-history.e2e.ts와 같은 방식으로 화면에 걸친 첫 행의 스크롤 영역 기준 top을 잡는다. */
async function anchor(scroller: Locator) {
  return scroller.evaluate(el => {
    const viewport = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]")).map(marker => {
      const rects = Array.from(marker.children).map(row => row.getBoundingClientRect());
      return {
        key: marker.dataset.chatItemKey!,
        top: Math.min(...rects.map(rect => rect.top)),
        bottom: Math.max(...rects.map(rect => rect.bottom)),
      };
    }).filter(row => row.bottom > viewport.top && row.top < viewport.bottom)
      .sort((a, b) => a.top - b.top);
    if (!rows[0]) throw new Error("첫 가시 행이 없습니다.");
    return { key: rows[0].key, offset: Math.round((rows[0].top - viewport.top) * 10) / 10 };
  });
}

async function keyPosition(scroller: Locator, key: string) {
  return scroller.evaluate((el, targetKey) => {
    const viewport = el.getBoundingClientRect();
    const marker = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-item-key]"))
      .find(row => row.dataset.chatItemKey === targetKey);
    const rects = marker ? Array.from(marker.children).map(row => row.getBoundingClientRect()) : [];
    return {
      key: targetKey,
      offset: rects.length ? Math.round((Math.min(...rects.map(row => row.top)) - viewport.top) * 10) / 10 : null,
      visible: rects.length > 0 && Math.max(...rects.map(row => row.bottom)) > viewport.top
        && Math.min(...rects.map(row => row.top)) < viewport.bottom,
      scrollTop: el.scrollTop,
    };
  }, key);
}

/** 실패 안내 안의 글(strong, p, pre, summary, button)을 줄 단위로 재고 낱말이 줄을 넘어 갔는지 본다. */
async function measureNotice(page: Page) {
  return page.locator(".v3-error-notice").first().evaluate(notice => {
    const box = notice.getBoundingClientRect();
    const parts = Array.from(notice.querySelectorAll("strong, p, pre, summary, button")).map(el => {
      const chars: { ch: string; top: number; right: number }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        for (let index = 0; index < node.data.length; index += 1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getClientRects()[0];
          if (!rect || node.data[index] === "\n") continue;
          chars.push({ ch: node.data[index], top: Math.round(rect.top), right: rect.right });
        }
      }
      const lines: { top: number; text: string }[] = [];
      for (const entry of chars) {
        const last = lines.at(-1);
        if (last && Math.abs(last.top - entry.top) <= 2) last.text += entry.ch;
        else lines.push({ top: entry.top, text: entry.ch });
      }
      const text = (el.textContent ?? "").trim();
      const hangulWords = text.split(/\s+/).filter(word => /[가-힣]/.test(word));
      const broken = hangulWords.filter(word => !lines.some(line => line.text.replace(/\s+/g, "").includes(word)));
      const maxRight = chars.reduce((maximum, entry) => Math.max(maximum, entry.right), 0);
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 300),
        lines: lines.map(line => line.text.trim()),
        broken,
        overflowPx: Math.round((maxRight - (box.right - 1)) * 10) / 10,
        rect: { x: Math.round(rect.x), w: Math.round(rect.width) },
      };
    });
    return {
      notice: {
        x: Math.round(box.x),
        w: Math.round(box.width),
        h: Math.round(box.height),
        scrollOver: notice.scrollWidth - notice.clientWidth,
      },
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      uuidVisible: (notice.textContent ?? "").includes("8dff6b9c-60a8-4c66-961c-b5c347fa9c0a"),
      parts,
    };
  });
}

type NoticeMeasurement = Awaited<ReturnType<typeof measureNotice>>;

function assertNoticeClean(name: string, measurement: NoticeMeasurement) {
  for (const part of measurement.parts) {
    assert(part.broken.length === 0, `${name}: <${part.tag}> 낱말 끊김 ${JSON.stringify(part.broken)} (${part.lines.join(" / ")})`);
    assert(part.overflowPx <= 0.5, `${name}: <${part.tag}> 가로 넘침 ${part.overflowPx}px`);
  }
  assert(measurement.notice.scrollOver <= 0, `${name}: 안내 상자 가로 넘침 ${measurement.notice.scrollOver}px`);
  assert(measurement.docOverflow <= 0, `${name}: 문서 가로 넘침 ${measurement.docOverflow}px`);
  assert(measurement.uuidVisible, `${name}: 기술 상세에 요청 ID(${REQUEST_ID})가 없음`);
}

async function plannerNotice(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await installV3VisualQaRoutes(page, { unifiedFolderView: true });
    await page.route("**/api/planner/folders/folder-ops**", route => route.fulfill({ status: 503, json: errorBody }));
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const nav = page.getByTestId("v3-all-projects");
    await nav.waitFor({ state: "visible", timeout: 30_000 });
    await nav.getByText("Soulstream 운영", { exact: true }).click();
    const notice = page.locator(".v3-error-notice").first();
    await notice.waitFor({ state: "visible", timeout: 15_000 });
    await notice.locator("summary").click();
    await page.waitForTimeout(400);
    const wide = await measureNotice(page);
    await page.screenshot({ path: path.join(output, `planner-error-1440-${suffix}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const narrow390 = await measureNotice(page);
    await page.screenshot({ path: path.join(output, `planner-error-390-${suffix}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 360, height: 844 });
    await page.waitForTimeout(500);
    const narrow360 = await measureNotice(page);
    await page.screenshot({ path: path.join(output, `planner-error-360-${suffix}.png`), animations: "disabled" });
    if (!baseline) {
      assertNoticeClean("플래너 1440", wide);
      assertNoticeClean("플래너 390", narrow390);
      assertNoticeClean("플래너 360", narrow360);
    }
    return { wide, narrow390, narrow360 };
  } finally {
    await context.close();
  }
}

async function cardBoard(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await page.route((url: URL) => url.pathname === "/api/cards", route => route.fulfill({ status: 503, json: errorBody }));
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    const notice = page.locator(".v3-error-notice").filter({ hasText: "카드를 불러오지 못했습니다." }).first();
    await notice.waitFor({ state: "visible", timeout: 30_000 });
    await notice.locator("summary").click();
    await page.waitForTimeout(400);
    const measurement = await measureNotice(page);
    await page.screenshot({ path: path.join(output, `cardboard-${width}-${suffix}.png`), animations: "disabled" });
    const box = await notice.boundingBox();
    if (box) {
      await page.screenshot({
        path: path.join(output, `cardboard-${width}-${suffix}-notice.png`),
        animations: "disabled",
        clip: {
          x: Math.max(0, box.x - 16),
          y: Math.max(0, box.y - 16),
          width: Math.min(width - Math.max(0, box.x - 16), box.width + 32),
          height: Math.min(884, box.height + 32),
        },
      });
    }
    if (!baseline) assertNoticeClean(`카드 보드 ${width}`, measurement);
    return measurement;
  } finally {
    await context.close();
  }
}

async function chatTop(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await installSessionRoutes(page);
    const synced = new Set<string>();
    await page.route("**/api/sessions/*/events*", async route => {
      const session = new URL(route.request().url()).pathname.split("/")[3];
      if (!synced.has(session)) {
        synced.add(session);
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 100, is_live: true, status: "running" })}\n\n`,
        });
      }
      return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
    });
    const cursors: (string | null)[] = [];
    let releaseFinalPage!: () => void;
    const finalPageGate = new Promise<void>(resolve => { releaseFinalPage = resolve; });
    let finalPageRequested = false;
    const pages = [historyPage(100, 40, "older-60"), historyPage(60, 40, "older-20"), historyPage(20, 20, null)];
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), async route => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("before");
      cursors.push(cursor);
      if (cursor === null) return route.fulfill({ json: pages[0] });
      if (cursor === "older-60") return route.fulfill({ json: pages[1] });
      if (cursor === "older-20") {
        finalPageRequested = true;
        await finalPageGate;
        return route.fulfill({ json: pages[2] });
      }
      return route.fulfill({ json: { messages: [], next_cursor: null } });
    });
    await page.goto(`${baseUrl}/?session=run-alpha-2&event=1`, { waitUntil: "domcontentloaded" });
    if (width < 500) {
      await page.waitForTimeout(1_500);
      await page.getByTestId("v3-mobile-tab-chat").click();
    }
    const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
    await root.waitFor({ state: "visible", timeout: 30_000 });
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor({ state: "visible", timeout: 30_000 });
    for (let poll = 0; poll < 100 && !finalPageRequested; poll += 1) await page.waitForTimeout(200);
    assert(finalPageRequested, "마지막 이력 페이지 요청이 오지 않았습니다.");
    await page.waitForTimeout(800);
    // 마지막 페이지를 붙잡은 채 맨 위로 올라가 기준 행을 잡는다.
    await wheelToTop(page, scroller);
    await page.waitForTimeout(800);
    const beforeRelease = await anchor(scroller).catch(() => null);
    releaseFinalPage();
    for (let poll = 0; poll < 60; poll += 1) {
      await page.waitForTimeout(200);
      const loading = await root.evaluate(el => el.textContent?.includes("이전 대화를 불러오는 중") ?? false);
      if (!loading) break;
    }
    await page.waitForTimeout(800);
    // 이력이 모두 올라온 뒤 맨 위로 다시 맞춘다.
    await wheelToTop(page, scroller);
    await page.waitForTimeout(900);
    const firstRow = await anchor(scroller).catch(() => null);
    const firstRowBefore = firstRow ? await keyPosition(scroller, firstRow.key) : null;
    await wheelToTop(page, scroller);
    await page.waitForTimeout(900);
    const firstRowAfter = firstRow ? await keyPosition(scroller, firstRow.key) : null;
    const markerCount = await page.getByText("대화의 시작", { exact: true }).count();
    const delta = firstRowBefore?.offset !== null && firstRowBefore?.offset !== undefined
      && firstRowAfter?.offset !== null && firstRowAfter?.offset !== undefined
      ? Math.abs(Math.round((firstRowAfter.offset - firstRowBefore.offset) * 10) / 10)
      : null;
    await page.screenshot({ path: path.join(output, `chat-top-${width}-${suffix}.png`), animations: "disabled" });
    if (!baseline) {
      assert(markerCount === 0, `대화 맨 위 표기가 남아 있음: ${markerCount}개`);
      assert(cursors.length >= 3, `이력 페이지가 모두 불리지 않음: ${JSON.stringify(cursors)}`);
      assert(delta !== null && delta <= 1, `마지막 휠 뒤 첫 행 top 차이 ${delta}px`);
    }
    return { width, cursors, beforeRelease, firstRow, firstRowBefore, firstRowAfter, delta, markerCount };
  } finally {
    await context.close();
  }
}

async function chatKorean(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await installSessionRoutes(page);
    const synced = new Set<string>();
    await page.route("**/api/sessions/*/events*", async route => {
      const session = new URL(route.request().url()).pathname.split("/")[3];
      if (!synced.has(session)) {
        synced.add(session);
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 2, is_live: true, status: "completed" })}\n\n`,
        });
      }
      return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
    });
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), route => route.fulfill({
      json: {
        messages: [
          {
            id: 2,
            parent_event_id: null,
            event_type: "assistant_message",
            payload: { timestamp: 2, content: "생각을 마친 뒤의 응답입니다.", tool_use_id: "card1650-2", _final_for_live_stream: true },
            created_at: "2026-07-27T10:00:02.000Z",
          },
          {
            id: 1,
            parent_event_id: null,
            event_type: "thinking",
            payload: { timestamp: 1, thinking: "생각 블록의 본문입니다." },
            created_at: "2026-07-27T10:00:01.000Z",
          },
        ],
        next_cursor: null,
      },
    }));
    await page.goto(`${baseUrl}/?session=run-alpha-1`, { waitUntil: "domcontentloaded" });
    if (width < 500) {
      await page.waitForTimeout(1_500);
      await page.getByTestId("v3-mobile-tab-chat").click();
    }
    const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
    await root.waitFor({ state: "visible", timeout: 30_000 });
    const thinking = page.getByText("💭 생각", { exact: true }).first();
    await thinking.waitFor({ state: "visible", timeout: 30_000 });
    const follow = page.getByRole("button", { name: /자동 스크롤/ }).first();
    await follow.waitFor({ state: "visible", timeout: 30_000 });
    const composer = page.locator('textarea[placeholder="대화를 이어서 입력하세요"]').first();
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    const placeholder = await composer.getAttribute("placeholder");
    const followLabel = await follow.getAttribute("aria-label");
    const thinkingText = (await thinking.textContent())?.trim() ?? null;
    await page.screenshot({ path: path.join(output, `chat-korean-${width}-${suffix}.png`), animations: "disabled" });
    const composerBox = await composer.boundingBox();
    if (composerBox) {
      await page.screenshot({
        path: path.join(output, `chat-composer-${width}-${suffix}.png`),
        animations: "disabled",
        clip: {
          x: Math.max(0, composerBox.x - 48),
          y: Math.max(0, composerBox.y - 120),
          width: Math.min(width - Math.max(0, composerBox.x - 48), composerBox.width + 96),
          height: Math.min(844, composerBox.height + 160),
        },
      });
    }
    if (!baseline) {
      assert(placeholder === "대화를 이어서 입력하세요", `입력창 자리표시 불일치: ${placeholder}`);
      assert(followLabel === "자동 스크롤", `따라가기 단추 접근 이름 불일치: ${followLabel}`);
      assert(thinkingText === "💭 생각", `생각 이름표 불일치: ${thinkingText}`);
    }
    return { placeholder, followLabel, thinkingText };
  } finally {
    await context.close();
  }
}

async function chatButtons(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await installSessionRoutes(page);
    const synced = new Set<string>();
    await page.route("**/api/sessions/*/events*", async route => {
      const session = new URL(route.request().url()).pathname.split("/")[3];
      if (!synced.has(session)) {
        synced.add(session);
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 2, is_live: true, status: "completed" })}\n\n`,
        });
      }
      return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
    });
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), route => route.fulfill({
      json: {
        messages: [
          {
            id: 2,
            parent_event_id: null,
            event_type: "assistant_message",
            payload: { timestamp: 2, content: "입력창 단추 이름 검수 응답입니다.", tool_use_id: "card1650-buttons-2", _final_for_live_stream: true },
            created_at: "2026-07-27T10:00:02.000Z",
          },
          {
            id: 1,
            parent_event_id: null,
            event_type: "thinking",
            payload: { timestamp: 1, thinking: "입력창 단추 이름 검수 생각입니다." },
            created_at: "2026-07-27T10:00:01.000Z",
          },
        ],
        next_cursor: null,
      },
    }));
    await page.goto(`${baseUrl}/?session=run-alpha-1`, { waitUntil: "domcontentloaded" });
    if (width < 500) {
      await page.waitForTimeout(1_500);
      await page.getByTestId("v3-mobile-tab-chat").click();
    }
    const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
    await root.waitFor({ state: "visible", timeout: 30_000 });
    // 이력이 실제로 그려진 뒤 잰다. 빈 상태에서는 입력창이 대화 영역 위쪽에 붙는다.
    await root.getByText("입력창 단추 이름 검수 응답입니다.", { exact: false }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const send = page.getByTestId("send-button").first();
    await send.waitFor({ state: "visible", timeout: 30_000 });
    const sendLabel = await send.getAttribute("aria-label");
    const sendTitle = await send.getAttribute("title");
    const mode = page.locator('[data-slot="chat-input-mode"]').first();
    const modeLabel = await mode.getAttribute("title");
    const attach = page.locator('button[aria-label="파일 첨부"]').first();
    await attach.waitFor({ state: "visible", timeout: 10_000 });
    const attachLabel = await attach.getAttribute("aria-label");
    const attachTitle = await attach.getAttribute("title");
    const layout = await root.evaluate(el => {
      const pick = (selector: string) => {
        const nodes = Array.from(el.querySelectorAll<HTMLElement>(selector));
        return nodes.find(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }) ?? null;
      };
      const box = (selector: string) => {
        const node = pick(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      };
      const composer = pick('[data-slot="chat-input-composer"]');
      return {
        composer: box('[data-slot="chat-input-composer"]'),
        send: box('[data-testid="send-button"]'),
        attach: box('button[aria-label="파일 첨부"]'),
        mode: box('[data-slot="chat-input-mode"]'),
        body: box('[data-slot="chat-input-body"]'),
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        composerOverflow: composer ? composer.scrollWidth - composer.clientWidth : null,
      };
    });
    await page.screenshot({ path: path.join(output, `chat-buttons-${width}-${suffix}.png`), animations: "disabled" });
    const composerBox = layout.composer;
    if (composerBox) {
      await page.screenshot({
        path: path.join(output, `chat-input-${width}-${suffix}.png`),
        animations: "disabled",
        clip: {
          x: Math.max(0, composerBox.x - 8),
          y: Math.max(0, composerBox.y - 8),
          width: Math.min(width - Math.max(0, composerBox.x - 8), composerBox.width + 16),
          height: composerBox.height + 16,
        },
      });
    }
    if (!baseline) {
      assert(sendLabel === "보내기", `보내기 단추 접근 이름 불일치: ${sendLabel}`);
      assert(sendTitle === "보내기", `보내기 단추 툴팁 불일치: ${sendTitle}`);
      assert(modeLabel === "대화 이어가기", `입력 모드 이름 불일치: ${modeLabel}`);
      assert(attachLabel === "파일 첨부", `첨부 단추 접근 이름 불일치: ${attachLabel}`);
      assert(attachTitle === "파일 첨부", `첨부 단추 툴팁 불일치: ${attachTitle}`);
      const { composer, send: sendBox, attach: attachBox, mode: modeBox, body } = layout;
      assert(composer && sendBox && attachBox && modeBox && body, "입력창 구성 요소를 찾지 못했습니다.");
      assert(sendBox.x >= composer.x && sendBox.right <= composer.right + 0.5, `보내기 단추가 입력창 밖으로 밀림: ${JSON.stringify({ composer, sendBox })}`);
      assert(attachBox.x >= composer.x - 0.5 && attachBox.right <= composer.right + 0.5, `첨부 단추가 입력창 밖으로 밀림: ${JSON.stringify({ composer, attachBox })}`);
      assert(modeBox.x >= composer.x - 0.5, `입력 모드 아이콘이 입력창 밖으로 밀림: ${JSON.stringify({ composer, modeBox })}`);
      assert(body.right <= sendBox.x + 0.5, `본문 칸이 보내기 단추를 침범: ${JSON.stringify({ body, sendBox })}`);
      assert(sendBox.scrollWidth <= sendBox.clientWidth, `보내기 단추 내용 잘림: ${JSON.stringify(sendBox)}`);
      assert(attachBox.scrollWidth <= attachBox.clientWidth, `첨부 단추 내용 잘림: ${JSON.stringify(attachBox)}`);
      assert(layout.composerOverflow !== null && layout.composerOverflow <= 0, `입력창 내용 가로 넘침 ${layout.composerOverflow}px`);
      assert(layout.documentOverflow <= 0, `문서 가로 넘침 ${layout.documentOverflow}px`);
    }
    return { sendLabel, sendTitle, modeLabel, attachLabel, attachTitle, layout };
  } finally {
    await context.close();
  }
}

async function newMessagesBanner(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await installSessionRoutes(page);
    const synced = new Set<string>();
    let releaseLive!: () => void;
    const liveGate = new Promise<void>(resolve => { releaseLive = resolve; });
    let liveServed = false;
    await page.route("**/api/sessions/*/events*", async route => {
      const session = new URL(route.request().url()).pathname.split("/")[3];
      if (!synced.has(session)) {
        synced.add(session);
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 80, is_live: true, status: "running" })}\n\n`,
        });
      }
      await liveGate;
      if (!liveServed) {
        liveServed = true;
        return route.fulfill({
          contentType: "text/event-stream; charset=utf-8",
          body: `id: 101\nevent: assistant_message\ndata: ${JSON.stringify({ type: "assistant_message", content: "위로 올린 뒤 도착한 새 응답", timestamp: 101, tool_use_id: "live-101", _final_for_live_stream: true })}\n\n`,
        });
      }
      return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
    });
    const messages = Array.from({ length: 80 }, (_, index) => {
      const id = 80 - index;
      return {
        id,
        parent_event_id: null,
        event_type: "user_message",
        payload: { text: `새 메시지 배너 검수 ${id}\n위로 스크롤한 상태를 확인합니다.\n새 이벤트가 오면 배너가 뜹니다.`, timestamp: id },
        created_at: new Date(id * 1_000).toISOString(),
      };
    });
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), route => {
      const cursor = new URL(route.request().url()).searchParams.get("before");
      return route.fulfill({ json: cursor === null ? { messages, next_cursor: null } : { messages: [], next_cursor: null } });
    });
    await page.goto(`${baseUrl}/?session=run-alpha-2`, { waitUntil: "domcontentloaded" });
    if (width < 500) {
      await page.waitForTimeout(1_500);
      await page.getByTestId("v3-mobile-tab-chat").click();
    }
    const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
    await root.waitFor({ state: "visible", timeout: 30_000 });
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor({ state: "visible", timeout: 30_000 });
    for (let poll = 0; poll < 100; poll += 1) {
      const ready = await scroller.evaluate(el => el.scrollHeight > el.clientHeight + 100
        && el.scrollHeight - el.clientHeight - el.scrollTop <= 48);
      if (ready) break;
      await page.waitForTimeout(200);
    }
    const scrollState = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
    assert(scrollState.height > scrollState.client + 100, `대화 이력이 로드되지 않음: ${JSON.stringify(scrollState)}`);
    await page.waitForTimeout(600);
    const send = page.getByTestId("send-button").first();
    await send.waitFor({ state: "visible", timeout: 30_000 });
    const sendLabel = await send.getAttribute("aria-label");
    const modeLabel = await page.locator('[data-slot="chat-input-mode"]').first().getAttribute("title");
    await movePointer(page, scroller);
    const viewportHeight = await scroller.evaluate(el => el.clientHeight);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(800);
    const distance = await scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    releaseLive();
    const banner = root.getByRole("button", { name: /새 메시지/ }).first();
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    const bannerText = (await banner.textContent())?.trim() ?? null;
    const oldBannerCount = await root.getByText("New Messages", { exact: false }).count();
    const layout = await banner.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        fontSize: style.fontSize,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    await page.screenshot({ path: path.join(output, `new-messages-${width}-${suffix}.png`), animations: "disabled" });
    await page.screenshot({
      path: path.join(output, `new-messages-banner-${width}-${suffix}.png`),
      animations: "disabled",
      clip: {
        x: Math.max(0, layout.x - 120),
        y: Math.max(0, layout.y - 140),
        width: Math.min(width - Math.max(0, layout.x - 120), layout.width + 240),
        height: layout.height + 180,
      },
    });
    if (!baseline) {
      assert(distance > viewportHeight, `위로 스크롤이 충분하지 않음: 거리 ${distance}px, 보이는 높이 ${viewportHeight}px`);
      assert(bannerText?.includes("새 메시지") === true, `새 메시지 배너 문구 불일치: ${bannerText}`);
      assert(oldBannerCount === 0, `옛 영어 배너가 남아 있음: ${oldBannerCount}개`);
      assert(sendLabel === "개입", `실행 중 보내기 단추 접근 이름 불일치: ${sendLabel}`);
      assert(modeLabel === "개입", `실행 중 입력 모드 이름 불일치: ${modeLabel}`);
      assert(layout.scrollWidth <= layout.clientWidth, `배너 내용 잘림: ${JSON.stringify(layout)}`);
      assert(layout.documentOverflow <= 0, `배너 문서 가로 넘침 ${layout.documentOverflow}px`);
    }
    return { width, scrollState, viewportHeight, distance, bannerText, oldBannerCount, sendLabel, modeLabel, layout };
  } finally {
    await context.close();
  }
}

async function followToggle(browser: Browser, width: number, press: boolean) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await installSessionRoutes(page);
    const synced = new Set<string>();
    let releaseLive!: () => void;
    const liveGate = new Promise<void>(resolve => { releaseLive = resolve; });
    let liveServed = false;
    await page.route("**/api/sessions/*/events*", async route => {
      const session = new URL(route.request().url()).pathname.split("/")[3];
      if (!synced.has(session)) {
        synced.add(session);
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: history_sync\ndata: ${JSON.stringify({ type: "history_sync", last_event_id: 80, is_live: true, status: "running" })}\n\n`,
        });
      }
      await liveGate;
      if (!liveServed) {
        liveServed = true;
        return route.fulfill({
          contentType: "text/event-stream; charset=utf-8",
          body: `id: 101\nevent: assistant_message\ndata: ${JSON.stringify({ type: "assistant_message", content: "단추를 누른 뒤 도착한 새 응답\n둘째 줄\n셋째 줄\n넷째 줄", timestamp: 101, tool_use_id: "live-101", _final_for_live_stream: true })}\n\n`,
        });
      }
      return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
    });
    const messages = Array.from({ length: 80 }, (_, index) => {
      const id = 80 - index;
      return {
        id,
        parent_event_id: null,
        event_type: "user_message",
        payload: { text: `따라가기 검수 ${id}\n둘째 줄\n셋째 줄`, timestamp: id },
        created_at: new Date(id * 1_000).toISOString(),
      };
    });
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), route => {
      const cursor = new URL(route.request().url()).searchParams.get("before");
      return route.fulfill({ json: cursor === null ? { messages, next_cursor: null } : { messages: [], next_cursor: null } });
    });
    await page.goto(`${baseUrl}/?session=run-alpha-2`, { waitUntil: "domcontentloaded" });
    if (width < 500) {
      await page.waitForTimeout(1_500);
      await page.getByTestId("v3-mobile-tab-chat").click();
    }
    const root = page.locator('[data-slot="chat-root"]').filter({ visible: true });
    await root.waitFor({ state: "visible", timeout: 30_000 });
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor({ state: "visible", timeout: 30_000 });
    for (let poll = 0; poll < 100; poll += 1) {
      const ready = await scroller.evaluate(el => el.scrollHeight > el.clientHeight + 100
        && el.scrollHeight - el.clientHeight - el.scrollTop <= 48);
      if (ready) break;
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(800);
    const follow = root.getByRole("button", { name: /자동 스크롤/ }).first();
    await follow.waitFor({ state: "visible", timeout: 30_000 });
    const state = async () => ({
      label: (await follow.textContent())?.trim() ?? null,
      highlighted: ((await follow.getAttribute("class")) ?? "").includes("text-accent-blue"),
      distance: Math.round(await scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)),
      banner: await root.getByRole("button", { name: /새 메시지/ }).count(),
      liveVisible: await root.getByText("단추를 누른 뒤 도착한 새 응답").count(),
    });
    const tag = `${width}-${press ? "pressed" : "control"}`;
    const before = await state();
    await page.screenshot({ path: path.join(output, `follow-${tag}-1-before-${suffix}.png`), animations: "disabled" });
    if (press) {
      await follow.click();
      await page.waitForTimeout(700);
    }
    const afterPress = await state();
    await page.screenshot({ path: path.join(output, `follow-${tag}-2-after-press-${suffix}.png`), animations: "disabled" });
    releaseLive();
    for (let poll = 0; poll < 75; poll += 1) {
      if (await root.getByText("단추를 누른 뒤 도착한 새 응답").count() > 0) break;
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1_200);
    const afterLive = await state();
    const liveInView = await root.getByText("단추를 누른 뒤 도착한 새 응답").first().evaluate((el, scrollerEl) => {
      const rect = el.getBoundingClientRect();
      const viewport = (scrollerEl as HTMLElement).getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    }, await scroller.elementHandle()).catch(() => false);
    await page.screenshot({ path: path.join(output, `follow-${tag}-3-after-live-${suffix}.png`), animations: "disabled" });
    if (!baseline) {
      assert(before.label === "↓ 자동 스크롤", `따라가기 단추 문구 불일치: ${before.label}`);
      assert(before.highlighted, "따라가기 단추가 켜진 상태로 시작하지 않음");
      assert(afterPress.highlighted === !press, `누른 뒤 단추 강조 불일치: ${afterPress.highlighted}`);
      assert(afterLive.liveVisible > 0, "새 응답이 대화에 나타나지 않음");
      if (press) {
        assert(afterLive.highlighted === false, "누른 뒤 새 응답이 와도 단추가 강조되어 있음");
        assert(afterLive.banner === 1, `누른 뒤 새 메시지 배너 ${afterLive.banner}개`);
        assert(afterLive.distance > 48, `누른 뒤 새 응답이 와도 맨 아래로 따라감: 거리 ${afterLive.distance}px`);
      } else {
        assert(afterLive.highlighted, "누르지 않았는데 단추 강조가 풀림");
        assert(afterLive.banner === 0, `누르지 않았는데 새 메시지 배너 ${afterLive.banner}개`);
        assert(afterLive.distance <= 48, `누르지 않았는데 맨 아래를 따라가지 않음: 거리 ${afterLive.distance}px`);
      }
    }
    return { tag, before, afterPress, afterLive, liveInView };
  } finally {
    await context.close();
  }
}

async function fullContentLoading(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width, width < 500 ? 844 : 1000);
  try {
    await installV3VisualQaRoutes(page, { timelineEventCount: 2, liveEventText: "검수 메시지" });
    await installSessionRoutes(page);
    const longThinking = Array.from({ length: 80 }, (_, index) => `생각 ${index + 1}번째 줄: 화면 배치와 여백을 다시 살펴본다.`).join("\n");
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/timeline$/.test(url.pathname), route => route.fulfill({
      json: {
        messages: [
          {
            id: 2,
            parent_event_id: null,
            event_type: "assistant_message",
            payload: { timestamp: 2, content: "긴 생각 뒤의 답", tool_use_id: "t-2", _final_for_live_stream: true },
            created_at: "2026-07-27T10:00:02.000Z",
          },
          {
            id: 1,
            parent_event_id: null,
            event_type: "thinking",
            payload: { timestamp: 1, thinking: longThinking },
            created_at: "2026-07-27T10:00:01.000Z",
          },
        ],
        next_cursor: null,
      },
    }));
    await page.route((url: URL) => /^\/api\/sessions\/[^/]+\/events\/1$/.test(url.pathname), async route => {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      await route.fulfill({ json: { event: { type: "thinking", thinking: longThinking } } });
    });
    await page.goto(`${baseUrl}/?session=run-alpha-2&event=2`, { waitUntil: "domcontentloaded" });
    if (width < 500) {
      await page.waitForTimeout(1_500);
      await page.getByTestId("v3-mobile-tab-chat").click();
    }
    const button = page.getByRole("button", { name: /전체 내용 보기/ }).first();
    await button.waitFor({ state: "visible", timeout: 30_000 });
    await button.scrollIntoViewIfNeeded();
    const before = await button.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { text: el.textContent, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    });
    await page.screenshot({ path: path.join(output, `fullcontent-${width}-idle-${suffix}.png`), animations: "disabled" });
    await button.click();
    const busy = page.getByRole("button", { name: "불러오는 중" }).first();
    await busy.waitFor({ state: "visible", timeout: 4_000 });
    const during = await busy.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        text: el.textContent,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        fontSize: style.fontSize,
        disabled: (el as HTMLButtonElement).disabled,
      };
    });
    await page.screenshot({ path: path.join(output, `fullcontent-${width}-loading-${suffix}.png`), animations: "disabled" });
    const clip = await busy.boundingBox();
    if (clip) {
      await page.screenshot({
        path: path.join(output, `fullcontent-${width}-loading-zoom-${suffix}.png`),
        animations: "disabled",
        clip: {
          x: Math.max(0, clip.x - 120),
          y: Math.max(0, clip.y - 140),
          width: Math.min(420, width - Math.max(0, clip.x - 120)),
          height: 200,
        },
      });
    }
    if (!baseline) {
      assert(before.text?.includes("전체 내용 보기") === true, `전체 내용 보기 단추 문구 불일치: ${before.text}`);
      assert(during.text?.trim() === "불러오는 중", `전체 내용 보기 로딩 문구 불일치: ${during.text}`);
    }
    return { before, during };
  } finally {
    await context.close();
  }
}

const result = await runPlaywrightLifecycle({
  lockName: "card1650-keepall-korean",
  timeoutMs: 600_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
}, async ({ browser }) => {
  const measured: Record<string, unknown> = { baseline };
  measured.planner = await plannerNotice(browser);
  for (const width of [360, 390, 1440]) {
    measured[`cardboard-${width}`] = await cardBoard(browser, width);
  }
  measured.chatTop1440 = await chatTop(browser, 1440);
  measured.chatTop390 = await chatTop(browser, 390);
  measured.chatKorean1440 = await chatKorean(browser, 1440);
  measured.chatKorean390 = await chatKorean(browser, 390);
  measured.chatButtons1440 = await chatButtons(browser, 1440);
  measured.chatButtons390 = await chatButtons(browser, 390);
  measured.newMessages1440 = await newMessagesBanner(browser, 1440);
  measured.newMessages390 = await newMessagesBanner(browser, 390);
  for (const width of [1440, 390]) {
    for (const press of [false, true]) {
      measured[`follow${width}${press ? "Pressed" : "Control"}`] = await followToggle(browser, width, press);
    }
  }
  measured.fullContent1440 = await fullContentLoading(browser, 1440);
  measured.fullContent390 = await fullContentLoading(browser, 390);
  return measured;
});
writeFileSync(path.join(output, `metrics-${suffix}.json`), JSON.stringify({ baseline, result }, null, 2));
console.log(JSON.stringify({ baseline, output, result }, null, 2));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
