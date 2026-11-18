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
 * 4. 대화 한국어 문구(1440/390): 입력창 자리표시·「↓ 맨 아래로」·「💭 생각」 이름표.
 * 5. 문서 패널 한국어 문구(1440/390): 기본 제목 「제목 없는 문서」·빈 본문 「빈 문서」·
 *    삭제 단추 툴팁/접근 이름 「문서 삭제」·제목/본문 접근 이름.
 * 6. 문서 패널 로딩 「불러오는 중」, 편집기 로딩 「편집기를 불러오는 중」.
 * 7. 전체 내용 보기 단추 로딩 「불러오는 중」(전문 요청 지연).
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
    const follow = page.getByRole("button", { name: /맨 아래로/ }).first();
    await follow.waitFor({ state: "visible", timeout: 30_000 });
    const composer = page.locator('textarea[placeholder="대화를 이어서 입력하세요"]').first();
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    const placeholder = await composer.getAttribute("placeholder");
    const followText = (await follow.textContent())?.trim() ?? null;
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
      assert(followText?.includes("맨 아래로") === true, `따라가기 단추 문구 불일치: ${followText}`);
      assert(thinkingText === "💭 생각", `생각 이름표 불일치: ${thinkingText}`);
    }
    return { placeholder, followText, thinkingText };
  } finally {
    await context.close();
  }
}

async function documentPanel(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    // 샘플 문서는 네트워크를 타지 않는다. 받는 모듈에서 기본 제목·빈 본문 상태를 만든다.
    await page.route("**/client/v3/dialogues-api.ts*", async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "value = document;",
        'value = { ...document, title: "제목 없는 문서", body: "" };',
      );
      await route.fulfill({ response, body });
    });
    await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
    const titleInput = page.locator('input[aria-label="문서 제목"]').first();
    await titleInput.waitFor({ state: "visible", timeout: 30_000 });
    const titleValue = await titleInput.inputValue();
    const titlePlaceholder = await titleInput.getAttribute("placeholder");
    const body = page.locator('[data-testid="markdown-read-body"]').first();
    await body.waitFor({ state: "visible", timeout: 30_000 });
    const bodyText = (await body.textContent())?.trim() ?? null;
    const deleteButton = page.locator('button[title="문서 삭제"]').first();
    await deleteButton.waitFor({ state: "attached", timeout: 10_000 });
    const deleteTitle = await deleteButton.getAttribute("title");
    const deleteAria = await deleteButton.getAttribute("aria-label");
    const deleteDisabled = await deleteButton.isDisabled();
    await page.screenshot({ path: path.join(output, `document-panel-1440-${suffix}.png`), animations: "disabled" });
    const headerBox = await titleInput.evaluate(el => {
      const header = el.parentElement?.getBoundingClientRect();
      return header ? { x: header.x, y: header.y, width: header.width, height: header.height } : null;
    });
    if (headerBox) {
      await page.screenshot({
        path: path.join(output, `document-panel-header-1440-${suffix}.png`),
        animations: "disabled",
        clip: {
          x: Math.max(0, headerBox.x - 8),
          y: Math.max(0, headerBox.y - 8),
          width: Math.min(1440 - Math.max(0, headerBox.x - 8), headerBox.width + 16),
          height: headerBox.height + 16,
        },
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, `document-panel-390-${suffix}.png`), animations: "disabled" });
    if (!baseline) {
      assert(titleValue === "제목 없는 문서", `기본 제목 불일치: ${titleValue}`);
      assert(titlePlaceholder === "제목 없는 문서", `제목 자리표시 불일치: ${titlePlaceholder}`);
      assert(bodyText?.includes("빈 문서") === true, `빈 본문 문구 불일치: ${bodyText}`);
      assert(deleteTitle === "문서 삭제", `삭제 단추 툴팁 불일치: ${deleteTitle}`);
      assert(deleteAria === "문서 삭제", `삭제 단추 접근 이름 불일치: ${deleteAria}`);
      assert(deleteDisabled === false, "삭제 단추가 비활성");
    }
    return { titleValue, titlePlaceholder, bodyText, deleteTitle, deleteAria, deleteDisabled };
  } finally {
    await context.close();
  }
}

async function documentLoading(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await page.route("**/client/v3/dialogues-api.ts*", async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "value = document;",
        "await new Promise((resolve) => setTimeout(resolve, 4000)); value = document;",
      );
      await route.fulfill({ response, body });
    });
    await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
    const loading = page.locator('[data-slot="frame-loading"]').first();
    await loading.waitFor({ state: "visible", timeout: 20_000 });
    const label = (await loading.textContent())?.trim() ?? null;
    await page.screenshot({ path: path.join(output, `document-loading-1440-${suffix}.png`), animations: "disabled" });
    if (!baseline) assert(label?.includes("불러오는 중") === true, `문서 로딩 문구 불일치: ${label}`);
    return { label };
  } finally {
    await context.close();
  }
}

async function editorLoading(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    await page.route("**/MarkdownCodeMirrorEditor.tsx*", async route => {
      await new Promise(resolve => setTimeout(resolve, 8_000));
      await route.fallback();
    });
    await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
    const edit = page.getByTestId("markdown-edit-start");
    await edit.waitFor({ state: "visible", timeout: 30_000 });
    await edit.click();
    const loading = page.locator('[data-slot="frame-loading"]').first();
    await loading.waitFor({ state: "visible", timeout: 15_000 });
    const label = (await loading.textContent())?.trim() ?? null;
    await page.screenshot({ path: path.join(output, `editor-loading-1440-${suffix}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const stillLoading = await loading.isVisible().catch(() => false);
    if (stillLoading) {
      await page.screenshot({ path: path.join(output, `editor-loading-390-${suffix}.png`), animations: "disabled" });
    }
    if (!baseline) assert(label?.includes("편집기를 불러오는 중") === true, `편집기 로딩 문구 불일치: ${label}`);
    return { label, stillLoading };
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
  timeoutMs: 420_000,
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
  measured.documentPanel = await documentPanel(browser);
  measured.documentLoading = await documentLoading(browser);
  measured.editorLoading = await editorLoading(browser);
  measured.fullContent1440 = await fullContentLoading(browser, 1440);
  measured.fullContent390 = await fullContentLoading(browser, 390);
  return measured;
});
writeFileSync(path.join(output, `metrics-${suffix}.json`), JSON.stringify({ baseline, result }, null, 2));
console.log(JSON.stringify({ baseline, output, result }, null, 2));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
