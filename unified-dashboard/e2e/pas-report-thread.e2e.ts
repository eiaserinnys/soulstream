import { expect, test, type Locator, type Page, type Route } from "./test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CardComment, CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { PersistentReportEntry } from "../../packages/wire-schema/src/persistent_report";
import { buildPasThreadFixture, PAS_THREAD_IDS as ID, type PasThreadFixture } from "../client/v3/pas-report-thread/pas-report-thread-fixtures";
import { chatUiSession, installChatUiRoutes } from "./chat-ui-fixtures";

/**
 * 결재형 보고 창(#1871) 화면 시험. 시안 QA(pas-report-1707-thread.qa.mjs) 가운데 실제 화면에 해당하는 검사를
 * 운영 형태 표본으로 옮겼다. 캡처와 조작 결과(operations.md)는 PAS_REPORT_THREAD_SHOTS에 쓴다.
 */
/**
 * 보고 창 화면 시험의 가짜 서버. 운영 웹에 로그인하거나 쿠키를 만들지 않고, 로컬 개발 서버 위에서
 * page.route로 판, 카드 목록과 상세, 답, 커멘트, 상태, 미루기 응답을 채운다.
 */
interface Call { method: string; path: string; body: Record<string, unknown> | null }
interface Harness {
  fixture: PasThreadFixture;
  calls: Call[];
  /** 이 카드의 상세 응답을 풀어 줄 때까지 붙든다(로딩 표시를 보려고). */
  holdDetail(cardId: string): () => void;
  /** 이 카드의 상세 응답을 실패시킨다. false로 풀면 다시 정상이다. */
  failDetail(cardId: string, fail: boolean): void;
  /** 판의 장을 바꿔 세션 스트림으로 내보낸다. */
  publishEntries(): Promise<void>;
  /** 카드 상세를 바꾸고 card_updated를 내보낸다. */
  touchCard(cardId: string, change: (detail: CardDetail) => void): Promise<void>;
  callsOf(method: string, pattern: RegExp): Call[];
}

const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_models: [], show_generation_separator: true, show_character: false, show_jev_candidates: true, animate_character: false, show_turn_usage: true, turn_usage_mode: "collapsed" };
const sse = (type: string, payload: object, id: number) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

async function installThreadScreen(page: Page, options: { fixture?: PasThreadFixture; theme: "light" | "dark" }): Promise<Harness> {
  const fixture = options.fixture ?? buildPasThreadFixture();
  const calls: Call[] = [];
  const held = new Map<string, Promise<void>>();
  const failing = new Set<string>();
  const queue: string[] = [];
  const waiters: (() => void)[] = [];
  let eventId = 100;
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: "reduce" });
  await installChatUiRoutes(page, { ui: false, count: 3 });
  await page.addInitScript(theme => localStorage.setItem("soul-dashboard-theme", theme), options.theme);
  await page.route("**/api/user/preferences", route => route.fulfill({ json: { preferences: { appearance: options.theme }, hasBackground: false } }));

  const resource = () => ({ session_id: chatUiSession, display_name: "보고 검수", node_id: "eiaserinnys", folder_id: "rb-alpha", agent_id: "roselin_codex", agent_name: "로젤린",
    persistent: true, persistent_report: fixture.entries, settings, runtime: { current_model: { model_preset: null, reasoning_effort: null, model: "codex" }, pending: null } });
  await page.route("**/api/persistent-sessions**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      const key = decodeURIComponent(pathname.split("/").pop()!);
      calls.push({ method: "DELETE", path: pathname, body: null });
      fixture.entries = fixture.entries.filter(entry => entry.key !== key);
      return route.fulfill({ json: { ok: true, changed: true, entries: fixture.entries.map(({ key, title }) => ({ key, title })), persistent_report: fixture.entries } });
    }
    if (pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions: [resource()], total: 1, create_defaults: { node_id: "eiaserinnys", preferred_agent_id: "roselin_codex", settings, initial_instruction: "", unavailable_reason: null } } });
    if (pathname.endsWith("/instructions")) return route.fulfill({ json: { instructions: [] } });
    return route.fulfill({ json: { session: resource() } });
  });
  let streams = 0;
  await page.route("**/api/sessions/stream?*", async route => {
    if (streams++ === 0) return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + sse("session_list", { sessions: [{ agentSessionId: chatUiSession, status: "running", eventCount: 3, nodeId: "eiaserinnys", agentId: "roselin_codex" }], total: 1 }, 1) });
    while (!queue.length) await new Promise<void>(resolve => waiters.push(resolve));
    return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + queue.splice(0).join("") });
  });
  let events = 0;
  await page.route("**/api/sessions/*/events*", async route => {
    if (events++ === 0) return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + sse("history_sync", { last_event_id: 3, is_live: true, status: "running" }, 3) });
    await new Promise<void>(() => undefined);
  });
  const emit = (type: string, payload: object) => { queue.push(sse(type, payload, ++eventId)); for (const wake of waiters.splice(0)) wake(); };

  // 카드 패널이 세션을 오른쪽 칸에 열 때 묻는 세션 조회. 카드 상세의 연결 세션을 세션 요약 모양으로 돌려준다.
  await page.route(url => url.pathname === "/api/sessions", route => {
    const wanted = new URL(route.request().url()).searchParams.getAll("session_id");
    const rows = Object.values(fixture.details).flatMap(detail => detail.sessions).filter(session => wanted.includes(session.sessionId))
      .map(session => ({ agentSessionId: session.sessionId, folderId: "pas-rt-folder", status: session.status, sessionType: "claude", createdAt: session.createdAt, updatedAt: session.updatedAt,
        nodeId: session.nodeId, agentId: session.agentId, agentName: session.agentName, displayName: session.displayName ?? session.agentName }));
    return route.fulfill({ json: { sessions: rows, total: rows.length } });
  });
  const touch = (card: CardRow) => { card.version += 1; card.updatedAt = new Date().toISOString(); };
  const syncCard = (detail: CardDetail) => { fixture.cards[detail.card.id] = detail.card; const index = fixture.list.findIndex(card => card.id === detail.card.id); if (index >= 0) fixture.list[index] = detail.card; };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route(url => url.pathname.startsWith("/api/cards"), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON() as Record<string, unknown>;
    if (url.pathname === "/api/cards") {
      const completed = url.searchParams.get("includeCompleted") === "true";
      return json(route, { cards: fixture.list.filter(card => completed || card.status !== "done") });
    }
    const [, , , rawId, ...rest] = url.pathname.split("/");
    const id = decodeURIComponent(rawId);
    const detail = fixture.details[id];
    if (!detail) return json(route, { detail: { error: { code: "CARD_NOT_FOUND", message: "카드가 없습니다" } } }, 404);
    const suffix = "/" + rest.join("/");
    if (method === "GET" && rest.length === 0) {
      await held.get(id);
      if (failing.has(id)) return json(route, { detail: { error: { code: "SERVER", message: "카드를 불러오지 못했습니다" } } }, 503);
      return json(route, detail);
    }
    calls.push({ method, path: url.pathname, body });
    if (method === "PATCH" && rest.length === 0) {
      const next = body as { snoozedUntil?: string | null; expectedVersion?: number };
      if (next.expectedVersion !== detail.card.version) return json(route, { detail: { error: { code: "VERSION_CONFLICT", message: "카드가 바뀌었습니다" } } }, 409);
      detail.card.snoozedUntil = next.snoozedUntil ?? null;
      touch(detail.card); syncCard(detail);
      return json(route, { card: detail.card });
    }
    if (method === "POST" && suffix === "/comments") {
      const input = body as { body: string; itemId?: number; questionId?: string };
      if (input.itemId !== undefined && input.questionId !== undefined) return json(route, { detail: { error: { code: "BAD_REQUEST", message: "질문 글타래에는 항목을 함께 줄 수 없습니다" } } }, 400);
      const comment: CardComment = { id: `sent-${detail.comments!.length + 1}`, cardId: id, authorKind: "user", authorId: "director", sessionId: null, kind: "comment",
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }), ...(input.questionId === undefined ? {} : { questionId: input.questionId }), body: input.body, createdAt: new Date().toISOString() };
      detail.comments!.push(comment); touch(detail.card);
      return json(route, comment);
    }
    if (method === "POST" && /^\/questions\/[^/]+\/answer$/.test(suffix)) {
      const question = detail.questions.find(item => suffix.includes(item.id));
      const input = body as { mode: "choice" | "text"; option?: string; answer?: string };
      if (question) { question.answer = input.mode === "choice" ? input.option! : input.answer!; question.answeredAt = new Date().toISOString(); }
      touch(detail.card);
      fixture.entries = fixture.entries.map(entry => entry.question_id && question && entry.question_id === question.id ? { ...entry, state: "answered", answer: question.answer ?? "" } : entry);
      return json(route, detail);
    }
    if (method === "POST" && suffix === "/status") {
      const input = body as { status: CardRow["status"]; expectedVersion: number };
      detail.card.status = input.status; touch(detail.card); syncCard(detail);
      fixture.entries = fixture.entries.filter(entry => entry.card_id !== id || input.status === "review");
      if (input.status === "review" && !fixture.entries.some(entry => entry.card_id === id)) fixture.entries.push(buildPasThreadFixture().entries.find(entry => entry.card_id === id)!);
      return json(route, detail);
    }
    return json(route, detail);
  });

  return {
    fixture, calls,
    holdDetail(cardId) {
      let release!: () => void;
      held.set(cardId, new Promise<void>(resolve => { release = () => { held.delete(cardId); resolve(); }; }));
      return release;
    },
    failDetail(cardId, fail) { if (fail) failing.add(cardId); else failing.delete(cardId); },
    async publishEntries() { emit("session_updated", { agent_session_id: chatUiSession, persistent_report: fixture.entries as PersistentReportEntry[] }); },
    async touchCard(cardId, change) { change(fixture.details[cardId]); touch(fixture.details[cardId].card); emit("card_updated", { cardId, folderId: fixture.details[cardId].card.folderId }); },
    callsOf: (method, pattern) => calls.filter(call => call.method === method && pattern.test(call.path)),
  };
}


const shots = process.env.PAS_REPORT_THREAD_SHOTS ?? path.resolve(import.meta.dirname, "../../.local/pas-report-thread");
mkdirSync(shots, { recursive: true });
type Theme = "light" | "dark";

const gateRows: { item: string; result: string; basis: string }[] = [];
const dialogRows: { target: string; open: string; first: string; enter: string; esc: string; after: string }[] = [];
const gate = (item: string, result: "통과" | "해당 없음", basis: string) => { if (!gateRows.some(row => row.item === item && row.basis === basis)) gateRows.push({ item, result, basis }); };

test.afterAll(() => {
  const order = (value: string) => Number(value.split(" ")[0]);
  const merged = new Map<string, string[]>();
  for (const row of gateRows.sort((a, b) => order(a.item) - order(b.item))) merged.set(row.item, [...(merged.get(row.item) ?? []), `${row.result}: ${row.basis}`]);
  const lines = [
    "# 결재형 보고 창 조작 결과 (카드 #1871 웹)", "",
    "실행: `PAS_REPORT_THREAD_SHOTS=<이 폴더> corepack pnpm -C unified-dashboard exec playwright test --config e2e/playwright.pas-report-thread.config.ts`", "",
    "시험과 가짜 서버(page.route 응답)는 모두 `unified-dashboard/e2e/pas-report-thread.e2e.ts` 안에 있다.", "",
    "## 14번부터 18번", "", "| 항목 | 결과 | 근거 |", "|---|---|---|",
    ...[...merged.entries()].map(([item, rows]) => `| ${item} | ${rows.some(row => row.startsWith("통과")) ? "통과" : "해당 없음"} | ${rows.map(row => row.replace(/^(통과|해당 없음): /, "")).join(" / ")} |`), "",
    "## 대화상자와 줄 안 편집", "", "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "|---|---|---|---|---|---|",
    ...dialogRows.map(row => `| ${row.target} | ${row.open} | ${row.first} | ${row.enter} | ${row.esc} | ${row.after} |`), "",
  ];
  writeFileSync(path.join(shots, "operations.md"), lines.join("\n"), "utf8");
});

const dialogOf = (page: Page) => page.getByTestId("pas-report-thread-dialog");
const railRow = (page: Page, cardId: string) => dialogOf(page).locator(`.pas-rt-rail-item[data-card-id="${cardId}"]`);
const decideOf = (page: Page) => dialogOf(page).getByTestId("pas-rt-decide");
const scrollOf = (page: Page) => dialogOf(page).getByTestId("pas-rt-thread-scroll");
const openCap = (page: Page) => page.getByTestId("report-deck").locator('[data-current="true"]').getByTestId("pas-report-open-window");
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });
/** 채운 주 단추가 이름 붙은 다른 단추보다 앞(같은 줄이면 왼쪽, 줄바꿈이면 위)이다. */
const primaryFirst = (scope: Locator, primary: string, others: string[]) => scope.evaluate((root, args) => {
  const find = (name: string) => [...root.querySelectorAll("button")].find(node => node.textContent?.trim() === name)!.getBoundingClientRect();
  const first = find(args.primary);
  return args.others.every(name => { const box = find(name); return first.top < box.top - 1 || (Math.abs(first.top - box.top) <= 1 && first.left < box.left); });
}, { primary, others });
const atBottom = (scroll: Locator) => scroll.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const focusedInside = (page: Page) => page.evaluate(() => {
  const active = document.activeElement;
  return Boolean(active && active !== document.body && active.closest('[data-testid="pas-report-thread-dialog"]'));
});

async function openScreen(page: Page, width: number, theme: Theme, options: { height?: number; fixture?: PasThreadFixture; beforeGoto?: (page: Page) => Promise<void> } = {}) {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  const harness = await installThreadScreen(page, { theme, fixture: options.fixture });
  await options.beforeGoto?.(page);
  await page.goto(`/persistent/${chatUiSession}`);
  await expect(page.getByTestId("report-deck")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return harness;
}
async function openWindow(page: Page) {
  await openCap(page).click();
  await expect(dialogOf(page)).toBeVisible();
  await expect(dialogOf(page).getByTestId("pas-rt-timeline")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function pick(page: Page, cardId: string) {
  const narrow = await dialogOf(page).getByTestId("pas-rt-rail-toggle").isVisible();
  if (narrow && !(await railRow(page, cardId).isVisible())) await dialogOf(page).getByTestId("pas-rt-rail-toggle").click();
  await railRow(page, cardId).click();
  await expect(railRow(page, cardId)).toHaveAttribute("aria-current", "true");
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[data-testid="pas-report-thread-dialog"]')!;
    const targets = [dialog, ...dialog.querySelectorAll<HTMLElement>(".pas-rt-head, .pas-rt-rail, .pas-rt-thread-scroll, .pas-rt-decide")];
    return targets.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className);
  });
  expect(overflow).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`1440 ${theme}: 레일 묶음, 안건 종류별 결재 단추, 맨 아래에서 시작`, async ({ page }) => {
    await openScreen(page, 1440, theme);
    await openWindow(page);
    const dialog = dialogOf(page);
    // 처음 초점은 지금 안건 행, 레일은 판의 카드 장만 담는다(PAS 자체 장 제외).
    await expect(railRow(page, ID.review)).toBeFocused();
    const sections = await dialog.locator(".pas-rt-rail section").evaluateAll(nodes => nodes.map(node => [node.getAttribute("aria-label"), node.querySelectorAll(".pas-rt-rail-item").length]));
    expect(sections).toEqual([["결재 대기", 4], ["진행 중", 2], ["미뤄 둠", 1]]);
    await expect(dialog.locator(".pas-rt-rail-item")).toHaveCount(7);
    await expect(dialog.locator(".pas-rt-hold-note")).toHaveText("보류함 3개");
    await expect(dialog.getByText("PAS 자체 보고")).toHaveCount(0);
    // 스레드는 맨 아래에서 시작하고 결재 상자는 그 아래 고정이다.
    await expect.poll(() => atBottom(scrollOf(page))).toBe(true);
    await shot(page, `w1440-${theme}-pending-review`);
    const decide = decideOf(page);
    await expect(button(decide, "완료")).toBeVisible();
    await expect(button(decide, "보류")).toBeVisible();
    await expect.poll(() => primaryFirst(decide, "완료", ["보류", "지시 적기", "답변 미루기"])).toBe(true);
    await expect(button(decide, "지시 적기")).toBeVisible();
    await expect(button(decide, "답변 미루기")).toBeVisible();
    // 질문: 선택지, 다르게 답하기, 되묻기, 답변 미루기. 질문이 열려 있으면 일반 지시 적기는 없다.
    await pick(page, ID.question);
    await expect(dialog.getByTestId("pas-rt-timeline")).toContainText("의존 관계 표시");
    for (const name of ["카드 안에 줄로 보여 주기", "별도 그래프로 보여 주기"]) await expect(decide.locator(".pas-rt-choice").filter({ hasText: name })).toBeVisible();
    await expect(decide.locator(".pas-rt-choice").first()).toContainText("권함");
    // 열린 선택 질문의 선택지는 결재 상자 알약 한 곳에서만 눌린다. 스레드에는 설명만 읽기 전용으로 있다.
    const timeline = dialog.getByTestId("pas-rt-timeline");
    await expect(timeline.getByTestId("pas-rt-question-options")).toContainText("카드 행 아래에 기다리는 카드 번호를 한 줄로 적는다");
    await expect(timeline.getByTestId("pas-rt-question-options")).toContainText("보드 위에 화살표 그래프를 그린다");
    for (const name of ["카드 안에 줄로 보여 주기", "별도 그래프로 보여 주기"]) await expect(timeline.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
    await expect(timeline.locator('.pas-rt-question[data-open] [data-slot="button"]')).toHaveCount(0);
    // 답한 질문의 모양은 그대로(고른 선택지 표시)다.
    await expect(timeline.locator('.pas-rt-question:not([data-open]) [aria-pressed="true"]')).toContainText("계속");
    for (const name of ["다르게 답하기", "되묻기", "답변 미루기"]) await expect(button(decide, name)).toBeVisible();
    await expect(button(decide, "지시 적기")).toHaveCount(0);
    await expect.poll(() => atBottom(scrollOf(page))).toBe(true);
    await shot(page, `w1440-${theme}-question`);
    // 부탁: 했어, 되묻기, 답변 미루기.
    await pick(page, ID.request);
    for (const name of ["했어", "되묻기", "답변 미루기"]) await expect(button(decide, name)).toBeVisible();
    // 채운 주 단추 「했어」가 왼쪽 묶음 첫 자리, 되묻기와 답변 미루기는 오른쪽 묶음이다.
    await expect.poll(() => primaryFirst(decide, "했어", ["되묻기", "답변 미루기"])).toBe(true);
    await expect(button(decide, "다르게 답하기")).toHaveCount(0);
    await expect(button(decide, "지시 적기")).toHaveCount(0);
    // 막힘: 확인했어, 지시 적기, 답변 미루기.
    await pick(page, ID.blocked);
    for (const name of ["확인했어", "지시 적기", "답변 미루기"]) await expect(button(decide, name)).toBeVisible();
    await expect.poll(() => primaryFirst(decide, "확인했어", ["지시 적기", "답변 미루기"])).toBe(true);
    await shot(page, `w1440-${theme}-blocked`);
    // 진행 중, 검증 대기: 지시 적기만.
    for (const id of [ID.running, ID.verifying]) {
      await pick(page, id);
      await expect(button(decide, "지시 적기")).toBeVisible();
      await expect(button(decide, "답변 미루기")).toHaveCount(0);
      await expect(button(decide, "완료")).toHaveCount(0);
    }
    await shot(page, `w1440-${theme}-running`);
    // 미뤄 둔 안건은 그 종류의 단추 그대로, 답변 미루기 자리에 미루기 해제.
    await pick(page, ID.snoozed);
    await expect(button(decide, "미루기 해제")).toBeVisible();
    await expect(button(decide, "답변 미루기")).toHaveCount(0);
    await expect(button(decide, "완료")).toBeVisible();
    await expect(decide.locator(".pas-rt-hint")).toContainText("미뤄 둠");
    await shot(page, `w1440-${theme}-snoozed`);
    gate("13 로딩 상태", "통과", "카드 상세를 기다리는 동안 스레드 자리에 로딩 표시(로딩과 실패 시험)");
  });
}

test("1440: 가장자리 선과 위쪽 끝 정렬", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  const geometry = await dialogOf(page).evaluate(root => {
    const box = (selector: string, scope: ParentNode = root) => scope.querySelector(selector)!.getBoundingClientRect();
    const active = root.querySelector<HTMLElement>(".pas-rt-rail-item[data-active]")!;
    const head = box(".pas-rt-rail-head h2"), title = box(".pas-rt-rail-title", active), item = active.getBoundingClientRect();
    const rail = box(".pas-rt-rail"), thread = box(".pas-rt-thread"), scroll = box(".pas-rt-thread-scroll"), decide = box(".pas-rt-decide");
    const firstButton = box('.pas-rt-decide [data-slot="button"]'), timeline = box(".pas-rt-timeline");
    const second = root.querySelectorAll(".pas-rt-rail section")[1].querySelector(".pas-rt-rail-head")!.getBoundingClientRect();
    const firstSectionLast = root.querySelectorAll(".pas-rt-rail section")[0].getBoundingClientRect();
    return { headLeft: head.left, titleLeft: title.left, barGap: title.left - item.left, railTop: rail.top, threadTop: thread.top,
      decideLeft: decide.left, buttonLeft: firstButton.left, timelineLeft: timeline.left, scrollLeft: scroll.left,
      sectionGap: second.top - firstSectionLast.bottom };
  });
  // 레일 구역 머리와 행 글자의 시작선은 1px 안, 강조 막대 뒤에는 12px 순수 여백이 남는다.
  expect(Math.abs(geometry.headLeft - geometry.titleLeft)).toBeLessThanOrEqual(1);
  expect(geometry.barGap).toBeCloseTo(17, 0);
  expect(geometry.railTop).toBeCloseTo(geometry.threadTop, 0);
  // 결재 상자 첫 단추와 스레드 첫 줄은 같은 왼쪽 선이다.
  expect(Math.abs(geometry.buttonLeft - geometry.timelineLeft)).toBeLessThanOrEqual(1);
  // 레일 구역 사이는 24px(--v3-space-6).
  expect(geometry.sectionGap).toBeGreaterThanOrEqual(23);
  expect(geometry.sectionGap).toBeLessThanOrEqual(26);
});

test("자동 스크롤: 위로 올리면 꺼지고 알약이 겹쳐 뜨며, 알약이나 맨 아래에서 다시 켜진다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  const scroll = scrollOf(page);
  const jump = dialogOf(page).getByTestId("pas-rt-jump-latest");
  await expect(jump).toHaveCount(0);
  await expect.poll(() => atBottom(scroll)).toBe(true);
  // 새 경과가 오면 맨 아래에서 켜진 채 따라 내려간다.
  await harness.touchCard(ID.review, detail => detail.comments!.push({ id: "live-1", cardId: ID.review, authorKind: "agent", authorId: "roselin", sessionId: null, kind: "comment", body: "실시간 경과 하나", createdAt: new Date().toISOString() }));
  await expect(dialogOf(page).getByTestId("pas-rt-timeline")).toContainText("실시간 경과 하나");
  await expect.poll(() => atBottom(scroll)).toBe(true);
  // 위로 올리면 꺼지고 오른쪽 아래에 알약이 겹쳐 뜬다. 본문 높이는 그대로다.
  const before = await scroll.evaluate(node => node.clientHeight);
  await scroll.evaluate(node => { node.scrollTop = 0; });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText("최신 경과로 ↓");
  expect(await scroll.evaluate(node => node.clientHeight)).toBe(before);
  const placement = await page.evaluate(() => {
    const pill = document.querySelector('[data-testid="pas-rt-jump-latest"]')!.getBoundingClientRect();
    const area = document.querySelector('[data-testid="pas-rt-thread-scroll"]')!.getBoundingClientRect();
    return { right: area.right - pill.right, bottom: area.bottom - pill.bottom, overlapsThread: pill.top >= area.top && pill.bottom <= area.bottom };
  });
  expect(placement.overlapsThread).toBe(true);
  expect(placement.right).toBeGreaterThan(0);
  expect(placement.right).toBeLessThan(48);
  await shot(page, "w1440-light-scrolled-up-jump-pill");
  // 읽던 줄은 새 경과가 와도 밀리지 않고, 알약은 새 경과를 알린다.
  await harness.touchCard(ID.review, detail => detail.comments!.push({ id: "live-2", cardId: ID.review, authorKind: "agent", authorId: "roselin", sessionId: null, kind: "comment", body: "위에서 읽는 동안 온 경과", createdAt: new Date().toISOString() }));
  await expect(jump).toHaveText("최신 경과로 ↓");
  await expect(jump).toHaveAttribute("data-new", "true");
  expect(await scroll.evaluate(node => node.scrollTop)).toBeLessThan(8);
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => atBottom(scroll)).toBe(true);
  await expect(scroll).toBeFocused();
  // 위로 올렸다가 손으로 맨 아래까지 내려도 다시 켜진다.
  await scroll.evaluate(node => { node.scrollTop = 0; });
  await expect(jump).toBeVisible();
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(jump).toHaveCount(0);
  await harness.touchCard(ID.review, detail => detail.comments!.push({ id: "live-3", cardId: ID.review, authorKind: "agent", authorId: "roselin", sessionId: null, kind: "comment", body: "다시 켜진 뒤 경과", createdAt: new Date().toISOString() }));
  await expect(dialogOf(page).getByTestId("pas-rt-timeline")).toContainText("다시 켜진 뒤 경과");
  await expect.poll(() => atBottom(scroll)).toBe(true);
  gate("14 누른 뒤 초점", "통과", "복귀 알약을 누르면 스레드 스크롤 칸으로 초점이 간다");
});

test("스레드 내용: 원 요청, 이정표, 커멘트, 기술 기록 한 줄 접기, 확인 항목은 맨 아래", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  const timeline = dialogOf(page).getByTestId("pas-rt-timeline");
  await expect(timeline.locator('[data-kind="request"]')).toHaveCount(1);
  await expect(timeline.locator('[data-kind="milestone"]').filter({ hasText: "위임: 세라피엘" })).toHaveCount(1);
  await expect(timeline.locator('[data-kind="milestone"]').filter({ hasText: "상태: 검수 대기" })).toHaveCount(1);
  await expect(timeline.locator('[data-kind="milestone"]').filter({ hasText: "레일과 결재 상자를 연결했습니다." })).toHaveCount(1);
  await expect(timeline.locator('[data-kind="comments"]').first()).toContainText("시안 r11 그대로 가고");
  // 이어진 노트는 「기술 기록 N건」 한 줄이고, 눌러 펼친다.
  const notes = timeline.getByRole("button", { name: /기술 기록 2건/ });
  await expect(notes).toHaveAttribute("aria-expanded", "false");
  await expect(timeline).not.toContainText("baseline 확인");
  await notes.click();
  await expect(notes).toHaveAttribute("aria-expanded", "true");
  await expect(timeline).toContainText("baseline 확인");
  // 확인 항목은 스레드 맨 아래, 결재 상자 바로 위다.
  await scrollOf(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
  const order = await page.evaluate(() => {
    const items = document.querySelector('[data-kind="items"]')!.getBoundingClientRect();
    const last = [...document.querySelectorAll('.pas-rt-event')].at(-1)!.getBoundingClientRect();
    const decide = document.querySelector('[data-testid="pas-rt-decide"]')!.getBoundingClientRect();
    return { itemsIsLast: Math.abs(items.top - last.top) < 1, above: items.bottom <= decide.top + 1 };
  });
  expect(order).toEqual({ itemsIsLast: true, above: true });
  await expect(timeline.getByTestId("card-check-items")).toContainText("레일과 스레드가 같은 안건을 가리킨다");
  // 증거 그림은 눌러 확대된다(확인 항목의 증거 표시와 확대).
  const evidence = timeline.locator(".v3-card-check-item-evidence img").first();
  await evidence.scrollIntoViewIfNeeded();
  await evidence.click();
  await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(1);
  await expect(dialogOf(page)).toBeVisible();
  await expect(evidence).toBeVisible();
  dialogRows.push({ target: "증거 확대(CardImageViewer)", open: "확인 항목의 증거 그림을 누른다", first: "확대 창(정본)", enter: "해당 없음", esc: "확대 창만 닫는다. 보고 창은 그대로", after: "눌렀던 증거 그림" });
  gate("15 Tab과 Esc", "통과", "증거 확대를 Esc로 닫으면 보고 창은 그대로 남는다");
});

test("질문 안건: 선택지로 답하면 처리됨으로 옮기고 다음 결재 대기 안건으로 넘어간다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.question);
  await decideOf(page).locator(".pas-rt-choice").first().click();
  await expect.poll(() => harness.callsOf("POST", /answer$/).length).toBe(1);
  expect(harness.callsOf("POST", /answer$/)[0].body).toMatchObject({ mode: "choice", option: "카드 안에 줄로 보여 주기" });
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveCount(1);
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveAttribute("data-card-id", ID.question);
  // 다음 결재 대기 안건(부탁)으로 넘어가 있고, 처리된 안건은 결재 대기에 남지 않는다.
  await expect(railRow(page, ID.request)).toHaveAttribute("aria-current", "true");
  // 선택지는 결재 상자 알약에서 골랐고, 초점은 다음 안건 행에 선다.
  await expect(railRow(page, ID.request)).toBeFocused();
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item')).toHaveCount(3);
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item[data-card-id="' + ID.question + '"]')).toHaveCount(0);
  await shot(page, "w1440-light-processed");
  gate("14 누른 뒤 초점", "통과", "선택지로 답한 뒤 초점이 사라지지 않고 보고 창 안에 있다");
  expect(await focusedInside(page)).toBe(true);
});

test("질문 안건: 다르게 답하기는 글 답으로 질문을 끝내고, 되묻기는 질문을 유지한다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.question);
  const decide = decideOf(page);
  // 되묻기: 입력창이 열리고 questionId를 붙인 커멘트로 가며, 질문은 그대로 열려 있다.
  await button(decide, "되묻기").click();
  const composer = decide.getByRole("textbox", { name: "물어볼 것" });
  await expect(composer).toBeFocused();
  await expect(decide.locator(".v3-card-target-notice")).toContainText("되묻기");
  await composer.fill("언제 스캔하는 거야?");
  await button(decide, "답 전송").click();
  await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(1);
  expect(harness.callsOf("POST", /comments$/)[0].body).toMatchObject({ body: "언제 스캔하는 거야?", questionId: "pas-rt-question-1" });
  expect(harness.callsOf("POST", /comments$/)[0].body).not.toHaveProperty("itemId");
  await expect(decide.getByRole("textbox")).toHaveCount(0);
  await expect(button(decide, "되묻기")).toBeFocused();
  await expect(dialogOf(page).locator('section[aria-label="처리됨"]')).toHaveCount(0);
  await expect(railRow(page, ID.question)).toHaveAttribute("aria-current", "true");
  await expect(dialogOf(page).getByTestId("pas-rt-timeline")).toContainText("언제 스캔하는 거야?");
  // 다르게 답하기: 글 답(text)으로 질문을 끝낸다.
  await button(decide, "다르게 답하기").click();
  await decide.getByRole("textbox", { name: "다르게 답하기" }).fill("그래프 말고 표로 해줘");
  await button(decide, "답 전송").click();
  await expect.poll(() => harness.callsOf("POST", /answer$/).length).toBe(1);
  expect(harness.callsOf("POST", /answer$/)[0].body).toMatchObject({ mode: "text", answer: "그래프 말고 표로 해줘" });
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveAttribute("data-card-id", ID.question);
  dialogRows.push({ target: "결재 상자 입력창(되묻기, 다르게 답하기, 지시 적기)", open: "해당 단추를 누른다", first: "입력창", enter: "전송(Shift+Enter는 줄바꿈)", esc: "입력창을 닫는다", after: "연 단추" });
  gate("14 누른 뒤 초점", "통과", "되묻기 입력창을 열면 입력창에, 전송하면 연 단추(되묻기)로 초점이 돌아간다");
});

test("항목 지시: 질문이 없으면 itemId, 열려 있으면 questionId와 「N번 항목: 」 머리글", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  // 질문이 없는 검수 안건: 커멘트에 itemId.
  const target = dialogOf(page).getByTestId("card-check-items").getByRole("button", { name: "고칠 점 남기기" }).first();
  await target.click();
  const decide = decideOf(page);
  await expect(decide.locator(".v3-card-target-notice")).toContainText("1번 항목");
  const composer = decide.getByRole("textbox", { name: "커멘트" });
  await expect(composer).toBeFocused();
  await composer.fill("이 항목은 다시 보여 줘");
  await button(decide, "커멘트 전송").click();
  await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(1);
  expect(harness.callsOf("POST", /comments$/)[0].body).toMatchObject({ body: "이 항목은 다시 보여 줘", itemId: 1 });
  expect(harness.callsOf("POST", /comments$/)[0].body).not.toHaveProperty("questionId");
  await expect(target).toBeFocused();
  // 질문이 열려 있는 안건: 서버가 둘을 함께 받지 않으므로 questionId에 글 머리 번호.
  await pick(page, ID.question);
  await dialogOf(page).getByTestId("card-check-items").getByRole("button", { name: "고칠 점 남기기" }).first().click();
  await decide.getByRole("textbox", { name: "커멘트" }).fill("표시안이 시안과 달라");
  await button(decide, "커멘트 전송").click();
  await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(2);
  const sent = harness.callsOf("POST", /comments$/)[1].body!;
  expect(sent).toMatchObject({ body: "1번 항목: 표시안이 시안과 달라", questionId: "pas-rt-question-1" });
  expect(sent).not.toHaveProperty("itemId");
  await expect(dialogOf(page).locator('section[aria-label="처리됨"]')).toHaveCount(0);
});

test("부탁 안건은 했어로 끝내고, 막힘 안건은 확인했어로 판에서 내린다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.request);
  await button(decideOf(page), "했어").click();
  await expect.poll(() => harness.callsOf("POST", /answer$/).length).toBe(1);
  expect(harness.callsOf("POST", /answer$/)[0].body).toMatchObject({ mode: "choice", option: "했어" });
  await expect(railRow(page, ID.blocked)).toHaveAttribute("aria-current", "true");
  await button(decideOf(page), "확인했어").click();
  await expect.poll(() => harness.callsOf("DELETE", /persistent-sessions/).length).toBe(1);
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveCount(2);
});

test("검수 안건: 완료와 보류, 5초 되돌리기, 지시 적기", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  const decide = decideOf(page);
  // 지시 적기는 일반 커멘트(질문과 항목 없음)다. 입력창은 평소 보이지 않다가 누를 때만 열린다.
  await expect(decide.getByRole("textbox")).toHaveCount(0);
  await button(decide, "지시 적기").click();
  const composer = decide.getByRole("textbox", { name: "커멘트" });
  await expect(composer).toBeFocused();
  await composer.fill("두 번째 항목 증거를 더 붙여 줘");
  await button(decide, "커멘트 전송").click();
  await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(1);
  expect(harness.callsOf("POST", /comments$/)[0].body).toEqual(expect.objectContaining({ body: "두 번째 항목 증거를 더 붙여 줘" }));
  expect(harness.callsOf("POST", /comments$/)[0].body).not.toHaveProperty("questionId");
  expect(harness.callsOf("POST", /comments$/)[0].body).not.toHaveProperty("itemId");
  await expect(button(decide, "지시 적기")).toBeFocused();
  // Esc는 입력창만 닫고 보고 창은 그대로, 초점은 연 단추로 돌아간다.
  await button(decide, "지시 적기").click();
  await expect(decide.getByRole("textbox", { name: "커멘트" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(decide.getByRole("textbox")).toHaveCount(0);
  await expect(dialogOf(page)).toBeVisible();
  await expect(button(decide, "지시 적기")).toBeFocused();
  // 완료: 기존 완료 훅 그대로(최신 version을 읽어 /status로), 다음 안건으로 넘어가고 되돌리기 줄이 선다.
  await button(decide, "완료").click();
  await expect.poll(() => harness.callsOf("POST", /status$/).length).toBe(1);
  expect(harness.callsOf("POST", /status$/)[0].body).toMatchObject({ status: "done" });
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveAttribute("data-card-id", ID.review);
  await expect(railRow(page, ID.question)).toHaveAttribute("aria-current", "true");
  const undo = decide.locator(".pas-rt-undo").getByRole("button", { name: "되돌리기" });
  await expect(undo).toBeVisible();
  await expect(decide.locator(".pas-rt-undo-label")).toContainText("#1871");
  await expect(undo).toBeFocused();
  await undo.click();
  await expect.poll(() => harness.callsOf("POST", /status$/).length).toBe(2);
  expect(harness.callsOf("POST", /status$/)[1].body).toMatchObject({ status: "review" });
  await expect(dialogOf(page).locator('section[aria-label="처리됨"]')).toHaveCount(0);
  await expect(railRow(page, ID.review)).toHaveAttribute("aria-current", "true");
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item')).toHaveCount(4);
  // 보류도 같은 길이다.
  await button(decideOf(page), "보류").click();
  await expect.poll(() => harness.callsOf("POST", /status$/).length).toBe(3);
  expect(harness.callsOf("POST", /status$/)[2].body).toMatchObject({ status: "on_hold" });
  gate("14 누른 뒤 초점", "통과", "처분하면 되돌리기 단추로, 입력창을 닫으면 연 단추로 초점이 간다");
});

test("답변 미루기: 선택지, 미뤄 둠 이동과 시각, 되돌리기와 미루기 해제", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  const decide = decideOf(page);
  const before = Date.now();
  await button(decide, "답변 미루기").click();
  const options = decide.locator("[data-snooze-option]");
  const ids = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-snooze-option")));
  expect(ids).toEqual(Number(await page.evaluate(() => new Date().getHours())) < 18 ? ["hour", "evening", "tomorrow", "three-days"] : ["hour", "tomorrow", "three-days"]);
  await shot(page, "w1440-light-snooze-open");
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(dialogOf(page)).toBeVisible();
  await expect(button(decide, "답변 미루기")).toBeFocused();
  await button(decide, "답변 미루기").click();
  await decide.locator('[data-snooze-option="hour"]').click();
  await expect.poll(() => harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/).length).toBe(1);
  const patch = harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/)[0].body as { snoozedUntil: string; expectedVersion: number; idempotencyKey: string };
  expect(Date.parse(patch.snoozedUntil) - before).toBeGreaterThan(55 * 60_000);
  expect(Date.parse(patch.snoozedUntil) - before).toBeLessThan(65 * 60_000);
  expect(patch.expectedVersion).toBe(3);
  expect(patch.idempotencyKey).toMatch(/^card-web:/);
  const snoozedSection = dialogOf(page).locator('section[aria-label="미뤄 둠"]');
  await expect(snoozedSection.locator(".pas-rt-rail-item")).toHaveCount(2);
  await expect(snoozedSection.locator(`.pas-rt-rail-item[data-card-id="${ID.review}"] [data-slot="badge"]`)).toContainText(/\d{2}:\d{2}/);
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item')).toHaveCount(3);
  await expect(railRow(page, ID.question)).toHaveAttribute("aria-current", "true");
  // 답변 미루기는 되돌리기 줄이 서고, 되돌리면 해제 PATCH(null)로 결재 대기에 돌아온다.
  const undo = decide.locator(".pas-rt-undo").getByRole("button", { name: "되돌리기" });
  await expect(undo).toBeVisible();
  await expect(decide.locator(".pas-rt-undo-label")).toContainText("#1871 미뤄 둠");
  await undo.click();
  await expect.poll(() => harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/).length).toBe(2);
  expect(harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/)[1].body).toMatchObject({ snoozedUntil: null });
  await expect(snoozedSection.locator(".pas-rt-rail-item")).toHaveCount(1);
  await expect(railRow(page, ID.review)).toHaveAttribute("aria-current", "true");
  // 이미 미뤄 둔 안건에서는 미루기 해제로 즉시 돌아온다.
  await pick(page, ID.snoozed);
  await button(decideOf(page), "미루기 해제").click();
  await expect.poll(() => harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/).length).toBe(3);
  expect(harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/)[2].body).toMatchObject({ snoozedUntil: null });
  await expect(dialogOf(page).locator('section[aria-label="미뤄 둠"]')).toHaveCount(0);
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item')).toHaveCount(5);
});

test("답변 미루기 실패는 결재 상자에 알리고 안건을 그대로 둔다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  // 다른 곳에서 카드가 바뀌어 version이 어긋난 상태(최신 version을 읽기 전에 서버가 앞서 간다).
  await page.route("**/api/cards/*", async route => {
    if (route.request().method() === "PATCH") return route.fulfill({ status: 409, json: { detail: { error: { code: "VERSION_CONFLICT", message: "카드가 바뀌었습니다" } } } });
    return route.fallback();
  });
  const decide = decideOf(page);
  await button(decide, "답변 미루기").click();
  await decide.locator('[data-snooze-option="hour"]').click();
  await expect(decide.getByRole("alert")).toBeVisible();
  await expect(decide.getByRole("alert")).toContainText("카드가 바뀌었습니다");
  await expect(railRow(page, ID.review)).toHaveAttribute("aria-current", "true");
  await expect(dialogOf(page).locator('section[aria-label="미뤄 둠"] .pas-rt-rail-item')).toHaveCount(1);
  await expect(button(decide, "답변 미루기")).toBeEnabled();
  void harness;
  gate("17 오류 상태", "통과", "미루기가 실패하면 결재 상자에 알림이 서고 안건과 단추는 그대로 다시 누를 수 있다");
});

test("미룬 시각이 되면 화면 타이머로 결재 대기에 돌아온다(서버 호출 없음)", async ({ page }) => {
  const fixture = buildPasThreadFixture();
  fixture.cards[ID.snoozed].snoozedUntil = new Date(Date.now() + 5000).toISOString();
  const harness = await openScreen(page, 1440, "light", { fixture });
  await openWindow(page);
  const snoozedSection = dialogOf(page).locator('section[aria-label="미뤄 둠"]');
  await expect(snoozedSection.locator(".pas-rt-rail-item")).toHaveCount(1);
  const writes = harness.calls.length;
  await expect(snoozedSection).toHaveCount(0, { timeout: 15_000 });
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item')).toHaveCount(5);
  expect(harness.calls.length).toBe(writes);
  await expect(dialogOf(page).locator(`section[aria-label="결재 대기"] .pas-rt-rail-item[data-card-id="${ID.snoozed}"]`)).toHaveCount(1);
});

test("로딩과 실패: 스레드 자리에 로딩 표시, 실패하면 그 자리에 실패 안내와 다시 시도", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  const release = harness.holdDetail(ID.blocked);
  harness.failDetail(ID.request, true);
  await openWindow(page);
  // 상세를 기다리는 안건: 틀이 먼저 서고 스레드 자리에 로딩 표시가 있다. 결재 단추는 아직 안 보인다.
  await railRow(page, ID.blocked).click();
  const loading = dialogOf(page).getByTestId("pas-rt-thread-loading");
  await expect(loading).toBeVisible();
  await expect(dialogOf(page).getByTestId("pas-rt-decide")).toBeVisible();
  await shot(page, "w1440-light-thread-loading");
  release();
  await expect(loading).toHaveCount(0);
  await expect(dialogOf(page).getByTestId("pas-rt-timeline")).toContainText("모델 한도가 풀릴 때까지");
  // 실패하면 그 자리가 실패 안내로 바뀐다.
  await railRow(page, ID.request).click();
  const failure = dialogOf(page).getByTestId("pas-rt-thread-error");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("불러오지 못했습니다");
  await shot(page, "w1440-light-thread-error");
  harness.failDetail(ID.request, false);
  await button(failure, "다시 시도").click();
  await expect(failure).toHaveCount(0);
  await expect(dialogOf(page).getByTestId("pas-rt-timeline")).toContainText("인증 코드가 만료됐습니다");
  gate("13 로딩 상태", "통과", "상세를 붙들어 로딩 캡처(w1440-light-thread-loading), 틀과 결재 상자는 먼저 서 있다");
  gate("17 오류 상태", "통과", "상세 응답 실패 캡처(w1440-light-thread-error), 다시 시도로 정상 복구");
});

test("카드 패널 열기: 보고 창 위에 겹치고, Esc로 닫으면 같은 안건과 스크롤과 연 단추로 돌아온다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  const scroll = scrollOf(page);
  await scroll.evaluate(node => { node.scrollTop = Math.max(0, node.scrollHeight / 3); });
  const top = await scroll.evaluate(node => node.scrollTop);
  const opener = dialogOf(page).getByTestId("pas-rt-open-card-panel");
  await opener.click();
  const workspace = page.getByTestId("v3-card-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace.getByTestId("card-detail")).toContainText("PAS 결재형 보고 창 구현");
  await shot(page, "w1440-light-card-panel");
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await expect(dialogOf(page)).toBeVisible();
  await expect(railRow(page, ID.review)).toHaveAttribute("aria-current", "true");
  expect(Math.abs((await scroll.evaluate(node => node.scrollTop)) - top)).toBeLessThanOrEqual(2);
  await expect(opener).toBeFocused();
  // 닫기 단추로도 같다.
  await opener.click();
  await workspace.getByRole("button", { name: "카드 닫기", exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await expect(opener).toBeFocused();
  // 마지막 Esc가 보고 창을 닫고 초점은 말풍선의 연 단추로 돌아간다.
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(openCap(page)).toBeFocused();
  dialogRows.push({ target: "카드 패널(CardWorkspace) 겹침", open: "머리줄 「카드 패널 열기」", first: "카드 닫기 단추(정본)", enter: "해당 없음", esc: "패널만 닫는다. 보고 창, 안건, 스크롤 그대로", after: "「카드 패널 열기」" });
  dialogRows.push({ target: "보고 창(Dialog)", open: "말풍선 머리줄 「보고 창 열기」", first: "지금 안건 행(좁은 폭은 「안건 목록」 단추)", enter: "해당 없음", esc: "열린 것 하나씩(카드 패널, 서랍, 증거 확대, 보고 창 순)", after: "말풍선의 「보고 창 열기」" });
  gate("14 누른 뒤 초점", "통과", "보고 창은 지금 안건 행으로 열리고 닫으면 말풍선의 연 단추로, 카드 패널은 닫으면 연 단추로 돌아간다");
  gate("15 Tab과 Esc", "통과", "카드 패널, 보고 창 순서로 Esc가 하나씩 닫는다. 바깥 화면은 그대로다");
});

test("Tab은 보고 창 안에서만 돌고 보이지 않는 요소에 서지 않는다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  const visited = new Set<string>();
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return { inside: false, visible: false, label: "body" };
      return { inside: Boolean(active.closest('[data-testid="pas-report-thread-dialog"]')), visible: active.getClientRects().length > 0 && !active.closest("[inert]"),
        label: active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 20) ?? active.tagName };
    });
    expect(state.inside, `Tab ${step}: ${state.label}`).toBe(true);
    expect(state.visible, `Tab ${step}: ${state.label}`).toBe(true);
    visited.add(state.label);
  }
  expect(visited.size).toBeGreaterThan(8);
  gate("15 Tab과 Esc", "통과", "Tab 40번 동안 초점은 보고 창 안의 보이는 요소에만 선다");
});

for (const width of [390, 360] as const) {
  test(`${width}: 레일은 「안건 목록」 서랍, 긴 글도 가로 스크롤 없이 말줄임과 줄바꿈`, async ({ page }) => {
    await openScreen(page, width, "light", { height: 800 });
    await openWindow(page);
    const dialog = dialogOf(page);
    const toggle = dialog.getByTestId("pas-rt-rail-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeFocused();
    await expect(dialog.locator(".pas-rt-rail")).toBeHidden();
    await expect(dialog.locator(".pas-rt-rail-item").first()).toBeHidden();
    await noHorizontalOverflow(page);
    await shot(page, `w${width}-light-pending-review`);
    // 서랍: 열면 지금 안건 행에 초점, 스레드는 가려져 초점이 들어가지 않는다.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(railRow(page, ID.review)).toBeFocused();
    await expect(dialog.locator(".pas-rt-thread")).toHaveAttribute("inert", "");
    await noHorizontalOverflow(page);
    await shot(page, `w${width}-light-drawer`);
    // Esc는 서랍만 닫고 보고 창은 그대로, 초점은 「안건 목록」 단추로 돌아간다.
    await page.keyboard.press("Escape");
    await expect(dialog.locator(".pas-rt-rail")).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // 서랍에서 행을 고르면 그 안건이 열리고 서랍이 닫힌다.
    await toggle.click();
    await railRow(page, ID.question).click();
    await expect(dialog.locator(".pas-rt-rail")).toBeHidden();
    await expect(dialog.getByTestId("pas-rt-timeline")).toContainText("의존 관계 표시");
    await expect(toggle).toBeFocused();
    await noHorizontalOverflow(page);
    for (const id of [ID.review, ID.question, ID.request, ID.blocked, ID.running, ID.snoozed]) {
      await pick(page, id);
      await noHorizontalOverflow(page);
    }
    await pick(page, ID.review);
    await shot(page, `w${width}-light-thread-bottom`);
    await dialog.getByTestId("pas-rt-decide").getByRole("button", { name: "답변 미루기" }).click();
    await noHorizontalOverflow(page);
    await shot(page, `w${width}-light-snooze-open`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    // 긴 제목은 두 줄까지 보이고 단추는 밀려나지 않는다.
    const headBox = await dialog.locator(".pas-rt-head").boundingBox();
    const toolsBox = await dialog.locator(".pas-rt-tools").boundingBox();
    expect(toolsBox!.x + toolsBox!.width).toBeLessThanOrEqual(headBox!.x + headBox!.width + 1);
    gate("16 최소 폭에서 넘침과 잘림", "통과", `${width}px에서 긴 제목과 모든 안건 종류를 돌며 보고 창, 머리줄, 레일, 스레드, 결재 상자의 가로 넘침 없음`);
    gate("15 Tab과 Esc", "통과", `${width}px 서랍은 Esc로 서랍만 닫는다. 서랍이 닫힌 레일은 초점을 받지 않는다`);
    gate("14 누른 뒤 초점", "통과", `${width}px 서랍을 열면 지금 안건 행으로, 닫거나 행을 고르면 「안건 목록」 단추로 초점이 간다`);
    if (width === 390) dialogRows.push({ target: "안건 목록 서랍(820px 아래)", open: "머리줄 「안건 목록」 단추", first: "지금 안건 행", enter: "행을 열고 서랍을 닫는다", esc: "서랍만 닫는다", after: "「안건 목록」 단추" });
  });
}

test("820: 왼쪽 고정 레일, 819: 서랍으로 바뀐다", async ({ page }) => {
  await openScreen(page, 820, "light");
  await openWindow(page);
  const dialog = dialogOf(page);
  await expect(dialog.getByTestId("pas-rt-rail-toggle")).toHaveCount(0);
  await expect(dialog.locator(".pas-rt-rail")).toBeVisible();
  await expect(railRow(page, ID.review)).toBeFocused();
  await noHorizontalOverflow(page);
  await shot(page, "w820-light-pending-review");
  const rail = await dialog.locator(".pas-rt-rail").boundingBox();
  const thread = await dialog.locator(".pas-rt-thread").boundingBox();
  expect(Math.abs(rail!.y - thread!.y)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 819, height: 900 });
  await expect(dialog.getByTestId("pas-rt-rail-toggle")).toBeVisible();
  await expect(dialog.locator(".pas-rt-rail")).toBeHidden();
  await noHorizontalOverflow(page);
});

test("창 크기를 바꿔도 안건과 스크롤과 입력 중인 글이 유지되고 배치가 다시 선다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.blocked);
  await button(decideOf(page), "지시 적기").click();
  await decideOf(page).getByRole("textbox", { name: "커멘트" }).fill("쓰던 글");
  const dialog = dialogOf(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(dialog.getByTestId("pas-rt-rail-toggle")).toBeVisible();
  await expect(dialog.locator(".pas-rt-rail")).toBeHidden();
  await expect(dialog.locator(".pas-rt-title")).toContainText("배포 검증이 한도에 막혀 멈춤");
  await expect(decideOf(page).getByRole("textbox", { name: "커멘트" })).toHaveValue("쓰던 글");
  await noHorizontalOverflow(page);
  // 서랍을 연 채 넓히면 서랍 상태가 남지 않고 고정 레일이 선다.
  await dialog.getByTestId("pas-rt-rail-toggle").click();
  await expect(dialog.locator(".pas-rt-rail")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog.getByTestId("pas-rt-rail-toggle")).toHaveCount(0);
  await expect(dialog.locator(".pas-rt-rail")).toBeVisible();
  await expect(dialog.locator(".pas-rt-thread")).not.toHaveAttribute("inert", "");
  await expect(railRow(page, ID.blocked)).toHaveAttribute("aria-current", "true");
  await expect(decideOf(page).getByRole("textbox", { name: "커멘트" })).toHaveValue("쓰던 글");
  await noHorizontalOverflow(page);
  gate("18 창 크기 바꾸기", "통과", "1440에서 390으로, 서랍을 연 채 1440으로 바꿔도 안건, 입력 중인 글이 유지되고 레일이 그 폭의 모양으로 다시 선다");
});

test("빈 판: 결재할 안건이 없으면 빈 안내와 레일만 남는다", async ({ page }) => {
  const fixture = buildPasThreadFixture();
  // 진행 중 카드도 없는 판: 카드 목록에는 보류한 카드만 남는다.
  fixture.list = fixture.list.filter(card => card.status === "on_hold");
  const harness = await openScreen(page, 1440, "light", { fixture });
  await openWindow(page);
  // 모든 결재 대기 안건을 처리해 판을 비운다.
  fixture.entries = fixture.entries.filter(entry => !entry.card_id);
  await harness.publishEntries();
  await expect(dialogOf(page).locator('section[aria-label="결재 대기"] .pas-rt-rail-item')).toHaveCount(0);
  await expect(dialogOf(page).locator('section[aria-label="미뤄 둠"]')).toHaveCount(0);
  await expect(dialogOf(page).getByTestId("pas-rt-empty")).toBeVisible();
  // 안건이 없으면 결재 상자 자리도 없다. 내용 없는 띠가 스레드 칸 바닥에 남지 않는다.
  await expect(dialogOf(page).getByTestId("pas-rt-decide")).toHaveCount(0);
  const gap = await dialogOf(page).evaluate(root => root.querySelector(".pas-rt-thread")!.getBoundingClientRect().bottom - root.querySelector(".pas-rt-thread-scroll")!.getBoundingClientRect().bottom);
  expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  await shot(page, "w1440-light-empty");
});

test("처리됨은 창을 닫으면 비운다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.request);
  await button(decideOf(page), "했어").click();
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toHaveCount(0);
  await openWindow(page);
  await expect(dialogOf(page).locator('section[aria-label="처리됨"]')).toHaveCount(0);
  void harness;
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 820, 390, 360] as const) {
    test(`캡처 ${width} ${theme}: 검수 결재 대기와 질문 안건`, async ({ page }) => {
      await openScreen(page, width, theme, { height: width <= 390 ? 800 : 900 });
      await page.screenshot({ path: path.join(shots, `w${width}-${theme}-bubble.png`) });
      await openWindow(page);
      await shot(page, `w${width}-${theme}-review`);
      await pick(page, ID.question);
      await expect.poll(() => atBottom(scrollOf(page))).toBe(true);
      await noHorizontalOverflow(page);
      await shot(page, `w${width}-${theme}-question`);
      await pick(page, ID.snoozed);
      await shot(page, `w${width}-${theme}-snoozed`);
    });
  }
}

/* 세라피엘 1차 검수와 코드 감수 반영(#1871): 고친 결함마다 다시 깨지면 잡히는 단언 */

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } });
  return page.evaluate(async encoded => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, png.toString("base64"));
}
const luminance = ([r, g, b]: number[]) => {
  const channel = (value: number) => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: number[], b: number[]) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };

for (const theme of ["light", "dark"] as const) {
  test(`결함 5 ${theme}: 이정표 점과 확인 항목 위 괘선이 바탕과 2:1 이상으로 보인다`, async ({ page }) => {
    await openScreen(page, 1440, theme);
    await openWindow(page);
    const timeline = dialogOf(page).getByTestId("pas-rt-timeline");
    await expect.poll(() => atBottom(scrollOf(page))).toBe(true);
    await scrollOf(page).evaluate(node => { node.scrollTop = Math.max(0, node.scrollHeight / 3); });
    const dots = timeline.locator(".pas-rt-milestone-dot");
    expect(await dots.count()).toBeGreaterThan(2);
    for (const tone of ["now", "status"]) {
      const dot = timeline.locator(`.pas-rt-milestone[data-tone="${tone}"] .pas-rt-milestone-dot`).first();
      await dot.scrollIntoViewIfNeeded();
      const box = (await dot.boundingBox())!;
      const dotPixel = await pixel(page, box.x + box.width / 2, box.y + box.height / 2);
      const ground = await pixel(page, box.x + box.width + 4, box.y + box.height / 2);
      expect(contrast(dotPixel, ground), `${theme} ${tone} 점`).toBeGreaterThanOrEqual(2);
    }
    // 확인 항목 위 괘선: 위쪽 테두리 줄 화소와 그 위 여백 화소를 비교한다.
    const items = timeline.locator(".pas-rt-items");
    await items.scrollIntoViewIfNeeded();
    const rect = (await items.boundingBox())!;
    const ground = await pixel(page, rect.x + 60, rect.y - 6);
    const rule = [await pixel(page, rect.x + 60, rect.y), await pixel(page, rect.x + 60, rect.y + 1)];
    expect(Math.max(...rule.map(value => contrast(value, ground))), `${theme} 확인 항목 위 괘선`).toBeGreaterThanOrEqual(2);
  });
}

test("결함 5: 여러 줄로 감긴 이정표의 점과 시각은 첫 줄에 맞는다", async ({ page }) => {
  const harness = await openScreen(page, 360, "light", { height: 800 });
  await harness.touchCard(ID.review, detail => detail.nowHistory!.push({ text: "여러 줄로 감기는 아주 긴 상황판 문구입니다. 긴 경로와 설명이 이어져 좁은 폭에서는 네 줄 넘게 내려갑니다. ".repeat(3), turn: "agent", ask: null, at: new Date(Date.now() - 60_000).toISOString() }));
  await openWindow(page);
  const milestone = dialogOf(page).locator('.pas-rt-milestone[data-tone="now"]').last();
  await milestone.scrollIntoViewIfNeeded();
  const geometry = await milestone.evaluate(node => {
    const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    return { height: own.height, top: own.top, dotCenter: box(".pas-rt-milestone-dot").top + box(".pas-rt-milestone-dot").height / 2, timeTop: box("time").top, line: parseFloat(getComputedStyle(node).lineHeight) };
  });
  expect(geometry.height).toBeGreaterThan(geometry.line * 2.5);
  expect(Math.abs(geometry.dotCenter - (geometry.top + geometry.line / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.timeTop - geometry.top)).toBeLessThanOrEqual(1);
});

test("결함 8: 이정표 글은 끌어서와 더블클릭으로 선택되고, 누르는 요소는 선택되지 않는다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  const text = dialogOf(page).locator(".pas-rt-milestone-text").filter({ hasText: "레일과 결재 상자를 연결했습니다." });
  await text.scrollIntoViewIfNeeded();
  expect(await text.evaluate(node => getComputedStyle(node).userSelect)).not.toBe("none");
  // 글자가 있는 자리(첫 낱말)를 더블클릭한다. 줄 끝 빈자리가 아니다.
  await text.dblclick({ position: { x: 6, y: 6 } });
  expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? "")).toContain("레일");
  const box = (await text.boundingBox())!;
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? "")).toContain("결재 상자를 연결했습니다.");
  // 누르는 요소(레일 행, 결재 단추, 기술 기록 토글)는 지금처럼 글자를 선택하지 않는다.
  for (const target of [railRow(page, ID.review), button(decideOf(page), "완료"), dialogOf(page).getByRole("button", { name: /기술 기록/ })]) {
    expect(await target.evaluate(node => getComputedStyle(node).userSelect), "누르는 요소").toBe("none");
  }
});

for (const width of [1440, 820, 390] as const) {
  test(`결함 7 ${width}: 확인 항목 상자와 결재 상자의 오른쪽 끝이 1px 안이다`, async ({ page }) => {
    await openScreen(page, width, "light", { height: width <= 390 ? 800 : 900 });
    await openWindow(page);
    const scroll = scrollOf(page);
    expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), "스크롤바가 있는 상태").toBe(true);
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const rightEdges = () => page.evaluate(() => {
      const right = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().right ?? null;
      return { items: right('[data-testid="card-check-items"]'), stamps: right(".pas-rt-stamps"), dock: right(".pas-rt-decide .v3-card-comment-dock"),
        lastButton: [...document.querySelectorAll<HTMLElement>(".pas-rt-stamps-secondary [data-slot=button]")].at(-1)?.getBoundingClientRect().right ?? null };
    });
    let edges = await rightEdges();
    expect(Math.abs(edges.items! - edges.stamps!)).toBeLessThanOrEqual(1);
    if (width >= 820) expect(Math.abs(edges.items! - edges.lastButton!)).toBeLessThanOrEqual(1);
    await button(decideOf(page), "지시 적기").click();
    edges = await rightEdges();
    expect(Math.abs(edges.items! - edges.dock!)).toBeLessThanOrEqual(1);
    // 왼쪽 시작선은 그대로 같다.
    const left = await page.evaluate(() => ({ items: document.querySelector('[data-testid="card-check-items"]')!.getBoundingClientRect().left, dock: document.querySelector(".pas-rt-decide .v3-card-comment-dock")!.getBoundingClientRect().left }));
    expect(Math.abs(left.items - left.dock)).toBeLessThanOrEqual(1);
  });
}

test("결함 1: 열린 선택 질문은 결재 상자에서만 고르고, 어디서 고르든 초점은 다음 안건 행에 선다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.question);
  const timeline = dialogOf(page).getByTestId("pas-rt-timeline");
  // 스레드 쪽에는 눌리는 선택지가 없다. 눌러도 아무 일도 없는 죽은 단추를 두지 않는다.
  await expect(timeline.locator(".pas-rt-question[data-open] .v3-card-question-choices")).toHaveCount(0);
  await expect(timeline.getByTestId("pas-rt-question-options").locator("button, [role=button]")).toHaveCount(0);
  await timeline.getByTestId("pas-rt-question-options").getByText("카드 안에 줄로 보여 주기").click();
  expect(harness.callsOf("POST", /answer$/)).toHaveLength(0);
  // 눌리는 선택지 묶음은 결재 상자 한 곳뿐이다.
  const pressable = await dialogOf(page).locator(".pas-rt-thread").getByRole("button", { name: /카드 안에 줄로 보여 주기|별도 그래프로 보여 주기/ }).count();
  expect(pressable, "결재 상자 알약 두 개만").toBe(2);
  await decideOf(page).getByRole("button", { name: /별도 그래프로 보여 주기/ }).click();
  await expect.poll(() => harness.callsOf("POST", /answer$/).length).toBe(1);
  expect(harness.callsOf("POST", /answer$/)[0].body).toMatchObject({ mode: "choice", option: "별도 그래프로 보여 주기" });
  await expect(railRow(page, ID.request)).toBeFocused();
  gate("14 누른 뒤 초점", "통과", "열린 선택 질문은 결재 상자 알약에서만 고르고 초점은 다음 안건 행에 선다(스레드에는 눌리는 선택지가 없다)");
});

for (const width of [390, 360] as const) {
  test(`결함 1 ${width}: 좁은 폭에서 선택지로 답하면 초점이 「안건 목록」 단추에 선다`, async ({ page }) => {
    const harness = await openScreen(page, width, "light", { height: 800 });
    await openWindow(page);
    await pick(page, ID.question);
    const dialog = dialogOf(page);
    await expect(dialog.locator(".pas-rt-question[data-open] .v3-card-question-choices")).toHaveCount(0);
    // 알약 묶음은 결재 상자에서 줄바꿈하되 넘치지 않는다.
    await noHorizontalOverflow(page);
    await decideOf(page).locator(".pas-rt-choice").first().click();
    await expect.poll(() => harness.callsOf("POST", /answer$/).length).toBe(1);
    await expect(dialog.getByTestId("pas-rt-rail-toggle")).toBeFocused();
  });
}

test("결함 2: 담당 세션이 있는 카드의 결재 상자 입력창은 파일 첨부가 붙고, 담당 세션이 없는 카드만 안내가 뜬다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await harness.touchCard(ID.blocked, detail => { detail.card.assigneeSessionId = null; detail.card.assigneeKind = "agent"; });
  await openWindow(page);
  const decide = decideOf(page);
  // 담당 세션이 있는 검수 카드: 파일 선택창이 열린다.
  await button(decide, "지시 적기").click();
  const chooser = page.waitForEvent("filechooser");
  await button(decide, "파일 첨부").click();
  await chooser;
  await expect(decide.getByText("첨부는 곧 지원합니다")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // 질문이 열린 안건의 되묻기 입력창도 같다.
  await pick(page, ID.question);
  await button(decide, "되묻기").click();
  const questionChooser = page.waitForEvent("filechooser");
  await button(decide, "파일 첨부").click();
  await questionChooser;
  await page.keyboard.press("Escape");
  // 담당 세션이 없는 카드에서만 지금 안내가 뜬다.
  await pick(page, ID.blocked);
  await button(decide, "지시 적기").click();
  await button(decide, "파일 첨부").click();
  await expect(decide.getByText("첨부는 곧 지원합니다")).toBeVisible();
});

test("결함 3: 카드 패널에서 세션을 누르면 새 탭이 아니라 오른쪽 칸에 세션이 열리고, Esc로 같은 안건과 스크롤로 돌아온다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  const popups: string[] = [];
  page.context().on("page", opened => popups.push(opened.url()));
  const scroll = scrollOf(page);
  await scroll.evaluate(node => { node.scrollTop = Math.max(0, node.scrollHeight / 3); });
  const top = await scroll.evaluate(node => node.scrollTop);
  const opener = dialogOf(page).getByTestId("pas-rt-open-card-panel");
  await opener.click();
  const workspace = page.getByTestId("v3-card-workspace");
  const chat = workspace.getByTestId("v3-card-session-chat");
  await expect(workspace).toBeVisible();
  // 담당 세션은 PAS 화면 카드 패널처럼 자동으로 오른쪽 칸에 열린다. 안내 문구가 남지 않는다.
  await expect(chat).toBeVisible();
  await expect(chat).not.toContainText("위임 관계에서 세션을 선택하세요");
  // 세션 행을 눌러도 같다.
  await workspace.getByRole("tab", { name: /^세션/ }).click();
  const reviewer = workspace.getByTestId("card-session-virtual").getByText("세라피엘").first();
  await reviewer.click();
  await expect(chat).not.toContainText("위임 관계에서 세션을 선택하세요");
  expect(popups, "새 탭이 열리지 않는다").toEqual([]);
  await shot(page, "w1440-light-card-panel-session");
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await expect(dialogOf(page)).toBeVisible();
  await expect(railRow(page, ID.review)).toHaveAttribute("aria-current", "true");
  expect(Math.abs((await scroll.evaluate(node => node.scrollTop)) - top)).toBeLessThanOrEqual(2);
  await expect(opener).toBeFocused();
  // 다시 열면 이전 선택이 남지 않고 담당 세션에서 시작한다.
  await opener.click();
  await expect(workspace.getByTestId("v3-card-session-chat")).not.toContainText("위임 관계에서 세션을 선택하세요");
  gate("15 Tab과 Esc", "통과", "카드 패널의 세션 열기는 오른쪽 칸에 열리고(새 탭 없음) Esc로 닫으면 같은 안건, 스크롤, 연 단추로 돌아온다");
});

test("카드 패널 안 팝업의 Esc는 팝업만 닫고 패널과 보고 창은 그대로다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  await dialogOf(page).getByTestId("pas-rt-open-card-panel").click();
  const workspace = page.getByTestId("v3-card-workspace");
  await expect(workspace).toBeVisible();
  const evidence = workspace.locator(".v3-card-check-item-evidence img").first();
  await evidence.scrollIntoViewIfNeeded();
  await evidence.click();
  await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(1);
  await expect(workspace).toBeVisible();
  await expect(dialogOf(page)).toBeVisible();
  // 팝업이 닫힌 뒤의 Esc는 패널을 닫는다.
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await expect(dialogOf(page)).toBeVisible();
  gate("15 Tab과 Esc", "통과", "카드 패널 안 증거 확대의 Esc는 확대만 닫고 패널과 보고 창은 그대로다");
});

test("마지막 안건을 처분해 판이 비어도 보고 창은 다시 마운트되지 않고 처리됨이 남는다", async ({ page }) => {
  const fixture = buildPasThreadFixture();
  fixture.entries = fixture.entries.filter(entry => entry.card_id === ID.blocked);
  const harness = await openScreen(page, 1440, "light", { fixture });
  await openWindow(page);
  const dialog = dialogOf(page);
  await expect(railRow(page, ID.blocked)).toHaveAttribute("aria-current", "true");
  await dialog.evaluate(node => { node.setAttribute("data-mounted-once", "yes"); });
  await button(decideOf(page), "확인했어").click();
  await expect.poll(() => harness.callsOf("DELETE", /persistent-sessions/).length).toBe(1);
  // 판이 비었는데도 같은 창 노드, 처리됨 목록, 활성 안건, 초점이 그대로다.
  await expect(dialog).toHaveAttribute("data-mounted-once", "yes");
  await expect(dialog.locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveAttribute("data-card-id", ID.blocked);
  await expect(railRow(page, ID.blocked)).toHaveAttribute("aria-current", "true");
  expect(await focusedInside(page)).toBe(true);
  await expect(page.getByTestId("report-deck")).toHaveCount(0);
});

test("완료 실패는 모달 뒤 알림이 아니라 결재 상자 안에 보이고, 안건과 단추는 그대로다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await page.route("**/api/cards/*/status", route => route.fulfill({ status: 500, json: { detail: { error: { code: "SERVER", message: "서버가 응답하지 않습니다" } } } }));
  const decide = decideOf(page);
  await button(decide, "완료").click();
  await expect(decide.getByRole("alert")).toContainText("카드를 완료하지 못했어.");
  await expect(railRow(page, ID.review)).toHaveAttribute("aria-current", "true");
  await expect(dialogOf(page).locator('section[aria-label="처리됨"]')).toHaveCount(0);
  await expect(button(decide, "완료")).toBeEnabled();
  await button(decide, "보류").click();
  await expect(decide.getByRole("alert")).toContainText("카드를 보류하지 못했어.");
  await shot(page, "w1440-light-complete-failed");
  void harness;
  gate("17 오류 상태", "통과", "완료와 보류가 실패하면 결재 상자에 알림이 서고 안건과 단추는 그대로다");
});

test("되돌리기가 실패하면 처리됨을 지우지 않고 안건으로 돌리지 않으며 결재 상자에 알린다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  let failing = false;
  await page.route("**/api/cards/*/status", route => failing
    ? route.fulfill({ status: 500, json: { detail: { error: { code: "SERVER", message: "서버가 응답하지 않습니다" } } } }) : route.fallback());
  const decide = decideOf(page);
  await button(decide, "완료").click();
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveAttribute("data-card-id", ID.review);
  await expect(railRow(page, ID.question)).toHaveAttribute("aria-current", "true");
  failing = true;
  await decide.locator(".pas-rt-undo").getByRole("button", { name: "되돌리기" }).click();
  await expect(decide.getByRole("alert")).toContainText("되돌리지 못했어.");
  await expect(dialogOf(page).locator('section[aria-label="처리됨"] .pas-rt-rail-item')).toHaveAttribute("data-card-id", ID.review);
  await expect(railRow(page, ID.question)).toHaveAttribute("aria-current", "true");
  expect(harness.callsOf("POST", /status$/).filter(call => (call.body as { status?: string }).status === "review")).toHaveLength(0);
  gate("17 오류 상태", "통과", "되돌리기가 실패하면 처리됨과 활성 안건을 그대로 두고 결재 상자에 알린다");
});

test("카드 목록을 못 읽으면 진행 중과 보류함이 0으로 조용히 보이지 않고 레일에 실패와 다시 시도가 선다", async ({ page }) => {
  let failList = true;
  await openScreen(page, 1440, "light", {
    beforeGoto: async target => { await target.route(url => url.pathname === "/api/cards", route => failList
      ? route.fulfill({ status: 503, json: { detail: { error: { code: "SERVER", message: "카드 목록을 읽지 못했습니다" } } } }) : route.fallback()); },
  });
  await openWindow(page);
  const rail = dialogOf(page).getByTestId("pas-rt-rail");
  await expect(rail.getByTestId("pas-rt-rail-error")).toContainText("카드 목록을 불러오지 못해");
  await expect(rail.locator(".pas-rt-hold-note")).toHaveCount(0);
  await expect(rail.locator('section[aria-label="진행 중"] .pas-rt-rail-count')).toHaveText("–");
  failList = false;
  await button(rail, "다시 시도").click();
  await expect(rail.getByTestId("pas-rt-rail-error")).toHaveCount(0);
  await expect(rail.locator(".pas-rt-hold-note")).toHaveText("보류함 3개");
  gate("17 오류 상태", "통과", "카드 목록 읽기가 실패하면 진행 중과 보류함 자리에 실패와 다시 시도가 서고 다시 시도로 복구된다");
});

test("미뤄 둔 진행 중과 검증 대기 안건에도 미루기 해제가 있다", async ({ page }) => {
  const fixture = buildPasThreadFixture();
  for (const id of [ID.running, ID.verifying]) fixture.cards[id].snoozedUntil = new Date(Date.now() + 3 * 3600_000).toISOString();
  const harness = await openScreen(page, 1440, "light", { fixture });
  await openWindow(page);
  for (const id of [ID.running, ID.verifying]) {
    await pick(page, id);
    await expect(button(decideOf(page), "미루기 해제")).toBeVisible();
    await expect(button(decideOf(page), "답변 미루기")).toHaveCount(0);
    await expect(button(decideOf(page), "지시 적기")).toBeVisible();
  }
  await button(decideOf(page), "미루기 해제").click();
  await expect.poll(() => harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/).length).toBe(1);
  expect(harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/)[0].body).toMatchObject({ snoozedUntil: null });
  await expect(dialogOf(page).locator(`section[aria-label="미뤄 둠"] .pas-rt-rail-item[data-card-id="${ID.verifying}"]`)).toHaveCount(0);
  // 누른 단추가 사라져도 초점은 body로 떨어지지 않고 남는 「지시 적기」에 선다.
  await expect(button(decideOf(page), "지시 적기")).toBeFocused();
});

test("항목 대상이 잡힌 채 다르게 답하기나 되묻기를 열면 알림줄과 보내는 곳이 어긋나지 않는다", async ({ page }) => {
  const harness = await openScreen(page, 1440, "light");
  await openWindow(page);
  await pick(page, ID.question);
  const decide = decideOf(page);
  const target = () => dialogOf(page).getByTestId("card-check-items").getByRole("button", { name: "고칠 점 남기기" }).first();
  // 항목 대상을 잡은 뒤 되묻기를 열면 대상은 풀리고 알림줄은 되묻기를 가리킨다. 글은 항목 머리글 없이 간다.
  await target().click();
  await expect(decide.locator(".v3-card-target-notice")).toContainText("1번 항목");
  await button(decide, "되묻기").click();
  await expect(decide.locator(".v3-card-target-notice")).toHaveText(/되묻기/);
  await expect(decide.locator(".v3-card-target-notice")).not.toContainText("항목");
  await decide.getByRole("textbox", { name: "물어볼 것" }).fill("이건 그냥 되묻는 말");
  await button(decide, "답 전송").click();
  await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(1);
  expect(harness.callsOf("POST", /comments$/)[0].body).toMatchObject({ body: "이건 그냥 되묻는 말", questionId: "pas-rt-question-1" });
  // 되묻기 입력창이 열려 있을 때 항목 대상을 잡으면 입력창은 항목 지시가 되고 알림줄도 그렇게 말한다.
  await button(decide, "되묻기").click();
  await target().click();
  await expect(decide.locator(".v3-card-target-notice")).toContainText("1번 항목");
  await decide.getByRole("textbox", { name: "커멘트" }).fill("이 항목 다시 봐 줘");
  await button(decide, "커멘트 전송").click();
  await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(2);
  expect(harness.callsOf("POST", /comments$/)[1].body).toMatchObject({ body: "1번 항목: 이 항목 다시 봐 줘", questionId: "pas-rt-question-1" });
  // 다르게 답하기도 같다: 대상은 풀리고 글 답으로 간다.
  await target().click();
  await button(decide, "다르게 답하기").click();
  await expect(decide.locator(".v3-card-target-notice")).not.toContainText("항목");
  await decide.getByRole("textbox", { name: "다르게 답하기" }).fill("표로 해줘");
  await button(decide, "답 전송").click();
  await expect.poll(() => harness.callsOf("POST", /answer$/).length).toBe(1);
  expect(harness.callsOf("POST", /answer$/)[0].body).toMatchObject({ mode: "text", answer: "표로 해줘" });
});

/* 세라피엘 2차 검수 반영(#1871): 결함 9~12와 담당 감수 사소 */

for (const width of [1440, 360] as const) for (const theme of ["light", "dark"] as const) {
  test(`결함 9 ${width} ${theme}: 읽기 전용 선택지의 막대가 바탕과 2:1 이상이고, 이름과 설명은 선택되며, 눌리는 요소는 없다`, async ({ page }) => {
    await openScreen(page, width, theme, { height: 900 });
    await openWindow(page);
    await pick(page, ID.question);
    const list = dialogOf(page).getByTestId("pas-rt-question-options");
    await list.scrollIntoViewIfNeeded();
    const items = list.locator("li");
    await expect(items).toHaveCount(2);
    // 막대(왼쪽 테두리 4px)가 바탕과 2:1 이상으로 보인다. 라이트에서 바탕과 같은 색이던 결함 9(가).
    expect(await items.first().evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe("4px");
    for (let index = 0; index < 2; index += 1) {
      const box = (await items.nth(index).boundingBox())!;
      const bar = await pixel(page, box.x + 2, box.y + box.height / 2);
      const ground = await pixel(page, box.x - 6, box.y + box.height / 2);
      expect(contrast(bar, ground), `${width} ${theme} 선택지 ${index + 1} 막대`).toBeGreaterThanOrEqual(2);
    }
    // 눌리는 요소가 없고, 마우스를 올려도 바탕이 바뀌지 않으며, 눌러도 답이 가지 않는다(결함 1 그대로).
    await expect(list.locator("button, [role=button], [tabindex], a, input")).toHaveCount(0);
    const before = await items.first().evaluate(node => getComputedStyle(node).backgroundColor);
    const first = (await items.first().boundingBox())!;
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    expect(await items.first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe(before);
    expect(await items.first().evaluate(node => getComputedStyle(node).cursor)).toBe("auto");
    // 이름과 설명 글은 선택되고 복사할 수 있다(결함 9 (나)).
    for (const node of [list, items.first().locator("*").first()]) expect(await node.evaluate(element => getComputedStyle(element).userSelect)).not.toBe("none");
    const name = list.getByText("카드 안에 줄로 보여 주기", { exact: true });
    await name.dblclick({ position: { x: 6, y: 6 } });
    expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? "")).toContain("카드");
    const description = list.getByText(/카드 행 아래에 기다리는 카드 번호를/);
    const box = (await description.boundingBox())!;
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(box.x + 1, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 200), box.y + 6, { steps: 6 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? "")).toContain("카드 행");
    if (theme === "light") await shot(page, `w${width}-light-question-options-selected`);
  });
}

for (const width of [1440, 360] as const) {
  test(`결함 10 ${width}: 카드 목록 실패의 레일 「다시 시도」는 스레드 실패의 「다시 시도」와 같은 14px, 32px이다`, async ({ page }) => {
    const harness = await openScreen(page, width, "light", {
      height: 900,
      beforeGoto: async target => { await target.route(url => url.pathname === "/api/cards", route => route.fulfill({ status: 503, json: { detail: { error: { code: "SERVER", message: "카드 목록을 읽지 못했습니다" } } } })); },
    });
    harness.failDetail(ID.review, true);
    await openCap(page).click();
    await expect(dialogOf(page)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const dialog = dialogOf(page);
    const threadRetry = button(dialog.getByTestId("pas-rt-thread-error"), "다시 시도");
    await expect(threadRetry).toBeVisible();
    if (width === 360) await dialog.getByTestId("pas-rt-rail-toggle").click();
    const railError = dialog.getByTestId("pas-rt-rail-error");
    await expect(railError).toBeVisible();
    const railRetry = button(railError, "다시 시도");
    const measure = (node: Locator) => node.evaluate(element => ({ size: getComputedStyle(element).fontSize, height: Math.round(element.getBoundingClientRect().height) }));
    // 같은 역할의 단추는 한 창 안에서 한 크기다. 넓은 폭의 기본 단추는 14px, 32px이다(좁은 폭은 기본 단추의 터치 크기를 따른다).
    expect(await measure(railRetry)).toEqual(await measure(threadRetry));
    if (width === 1440) expect(await measure(railRetry)).toEqual({ size: "14px", height: 32 });
    // 넘치거나 두 줄이 되지 않는다. 시작선은 구역 머리와 1px 안이다.
    const rail = dialog.getByTestId("pas-rt-rail");
    expect(await rail.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const retryBox = (await railRetry.boundingBox())!;
    const railBox = (await rail.boundingBox())!;
    expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(railBox.x + railBox.width);
    const headLeft = (await rail.locator(".pas-rt-rail-head h2").first().boundingBox())!.x;
    expect(Math.abs(retryBox.x - headLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs((await railError.locator("span").first().boundingBox())!.x - headLeft)).toBeLessThanOrEqual(1);
    await shot(page, `w${width}-light-rail-error-retry`);
  });
}

for (const width of [1440, 360] as const) {
  test(`결함 11 ${width}: 미뤄 둔 진행 중과 검증 대기에만 「미뤄 둠: 시각」이 다른 종류와 같은 자리, 같은 모양으로 있다`, async ({ page }) => {
    const fixture = buildPasThreadFixture();
    for (const id of [ID.running, ID.verifying]) fixture.cards[id].snoozedUntil = new Date(Date.now() + 3 * 3600_000).toISOString();
    const harness = await openScreen(page, width, "light", { fixture, height: 900 });
    await openWindow(page);
    const decide = decideOf(page);
    const hintStyle = (node: Locator) => node.evaluate(element => { const style = getComputedStyle(element); return { parent: element.parentElement!.className, size: style.fontSize, color: style.color, weight: style.fontWeight }; });
    await pick(page, ID.snoozed);
    const reference = await hintStyle(decide.locator(".pas-rt-hint"));
    expect(reference.parent).toContain("pas-rt-stamps-primary");
    for (const id of [ID.running, ID.verifying]) {
      await pick(page, id);
      await expect(decide.locator(".pas-rt-hint")).toHaveText(/^미뤄 둠: .+/);
      expect(await hintStyle(decide.locator(".pas-rt-hint"))).toEqual(reference);
      const hint = (await decide.locator(".pas-rt-hint").boundingBox())!;
      const box = (await decide.boundingBox())!;
      expect(hint.x + hint.width, `${id} 표시가 결재 상자 안`).toBeLessThanOrEqual(box.x + box.width);
      await noHorizontalOverflow(page);
    }
    await shot(page, `w${width}-light-snoozed-running-hint`);
    // 해제하면 표시와 해제 단추가 함께 사라지고 「지시 적기」만 남는다.
    await pick(page, ID.verifying);
    await button(decide, "미루기 해제").click();
    await expect.poll(() => harness.callsOf("PATCH", /\/api\/cards\/[^/]+$/).length).toBe(1);
    await expect(decide.locator(".pas-rt-hint")).toHaveCount(0);
    await expect(button(decide, "미루기 해제")).toHaveCount(0);
    await expect(decide.locator("button")).toHaveText(["지시 적기"]);
  });
}

test("결함 11: 미루지 않은 진행 중과 검증 대기 안건에는 「미뤄 둠」 표시가 없다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  for (const id of [ID.running, ID.verifying]) {
    await pick(page, id);
    await expect(decideOf(page).locator(".pas-rt-hint")).toHaveCount(0);
    await expect(button(decideOf(page), "미루기 해제")).toHaveCount(0);
  }
});

// 결함 12. 둘째 Esc가 삼켜진 것이 아니라, 사라지는 동안 창이 남아 있던 것이다. 둘째 Esc는 곧바로 창을 닫는 중으로 바꾸고,
// 움직임 줄이기에서는 그 틈이 없어야 한다. 6번 되풀이해 그 틈(Esc 뒤 창이 사라지기까지)이 600ms 안인지 본다.
const ESC_ROUNDS = 6;
async function pressEscAndExpectClosed(page: Page, label: string) {
  const dialog = dialogOf(page);
  const startedAt = Date.now();
  await page.keyboard.press("Escape");
  await expect(dialog, `${label}: 이 Esc로 보고 창이 닫힌다`).toHaveCount(0, { timeout: 600 });
  return Date.now() - startedAt;
}
test("결함 12: 「지시 적기」를 연 채 카드 패널을 Esc로 닫으면, 이어지는 Esc 한 번에 보고 창이 닫힌다(6번 되풀이)", async ({ page }) => {
  await openScreen(page, 1440, "light");
  const workspace = page.getByTestId("v3-card-workspace");
  for (let round = 1; round <= ESC_ROUNDS; round += 1) {
    await openWindow(page);
    await button(decideOf(page), "지시 적기").click();
    await dialogOf(page).getByTestId("pas-rt-open-card-panel").click();
    await expect(workspace).toBeVisible();
    await page.keyboard.press("Escape");
    // 첫 Esc는 패널만 닫는다. 창과 입력창은 그대로다.
    await expect(workspace).toHaveCount(0);
    await expect(dialogOf(page)).toBeVisible();
    await expect(decideOf(page).locator(".pas-rt-composer-drawer")).toHaveCount(1);
    await expect(dialogOf(page).getByTestId("pas-rt-open-card-panel")).toBeFocused();
    await pressEscAndExpectClosed(page, `${round}번째`);
    await expect(openCap(page)).toBeFocused();
  }
});
test("결함 12: 카드 패널 안 증거 확대를 더한 순서(Esc 셋)도 6번 모두 셋째 Esc에 보고 창이 닫힌다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  const workspace = page.getByTestId("v3-card-workspace");
  for (let round = 1; round <= ESC_ROUNDS; round += 1) {
    await openWindow(page);
    await button(decideOf(page), "지시 적기").click();
    await dialogOf(page).getByTestId("pas-rt-open-card-panel").click();
    await expect(workspace).toBeVisible();
    const evidence = workspace.locator(".v3-card-check-item-evidence img").first();
    await evidence.scrollIntoViewIfNeeded();
    await evidence.click();
    await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(1);
    await expect(workspace).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(workspace).toHaveCount(0);
    await expect(dialogOf(page)).toBeVisible();
    await pressEscAndExpectClosed(page, `${round}번째 셋째`);
  }
});
test("결함 12: 입력창 안에 초점이 있을 때 Esc는 입력창만 닫고 「지시 적기」로 돌아가며, 그 다음 Esc가 창을 닫는다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  await button(decideOf(page), "지시 적기").click();
  await expect(decideOf(page).getByRole("textbox", { name: "커멘트" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(decideOf(page).locator(".pas-rt-composer-drawer")).toHaveCount(0);
  await expect(button(decideOf(page), "지시 적기")).toBeFocused();
  await expect(dialogOf(page)).toBeVisible();
  await pressEscAndExpectClosed(page, "입력창을 닫은 뒤");
});

test("움직임 줄이기에서는 보고 창이 사라지는 동안 남지 않는다", async ({ page }) => {
  await openScreen(page, 1440, "light");
  await openWindow(page);
  expect(await dialogOf(page).evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
});

for (const width of [1440, 360] as const) {
  test(`카드 패널 청크를 못 받으면 패널 자리에 실패 안내와 닫기가 서고, 안내 동안 초점은 닫기에만 머문다 ${width}`, async ({ page }) => {
    const harness = await openScreen(page, width, "light", {
      height: 900,
      beforeGoto: async target => { await target.route(url => /PasCardPanel\.tsx/.test(url.pathname), route => route.abort()); },
    });
    await openWindow(page);
    await button(decideOf(page), "지시 적기").click();
    await decideOf(page).getByRole("textbox", { name: "커멘트" }).fill("쓰던 글");
    const opener = dialogOf(page).getByTestId("pas-rt-open-card-panel");
    await opener.click();
    const failure = dialogOf(page).getByTestId("pas-rt-panel-error");
    await expect(failure).toBeVisible();
    // 글은 실패 사실과 회복 길만 남는다(보고 창이 그대로라는 말은 화면이 이미 보여 준다).
    await expect(failure.locator("p")).toHaveText("카드 패널을 불러오지 못했습니다. 페이지를 새로 고치면 다시 받습니다.");
    expect(await failure.locator("p").evaluate(node => getComputedStyle(node).wordBreak)).toBe("keep-all");
    await shot(page, `w${width}-light-card-panel-chunk-failed`);
    const close = failure.getByTestId("pas-rt-panel-error-close");
    await expect(close).toBeFocused();
    // 안내 동안 보고 창의 나머지는 잠겨 초점이 가림막 뒤로 가지 않는다.
    await expect(dialogOf(page).locator(".pas-rt-head")).toHaveAttribute("inert", "");
    await expect(dialogOf(page).locator(".pas-rt-main")).toHaveAttribute("inert", "");
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press(index % 2 === 0 ? "Tab" : "Shift+Tab");
      await expect(close, `Tab ${index + 1}번째`).toBeFocused();
    }
    for (let index = 0; index < 3; index += 1) { await page.keyboard.press("Tab"); await expect(close).toBeFocused(); }
    for (let index = 0; index < 3; index += 1) { await page.keyboard.press("Shift+Tab"); await expect(close).toBeFocused(); }
    // 보고 창과 쓰던 글은 그대로다.
    await expect(decideOf(page).getByRole("textbox", { name: "커멘트" })).toHaveValue("쓰던 글");
    await close.click();
    await expect(failure).toHaveCount(0);
    // 닫으면 잠금이 풀리고 초점은 「카드 패널 열기」로 간다. 그 뒤 Tab은 창 안으로 이어진다.
    await expect(opener).toBeFocused();
    await expect(dialogOf(page).locator(".pas-rt-head")).not.toHaveAttribute("inert", /.*/);
    await expect(dialogOf(page).locator(".pas-rt-main")).not.toHaveAttribute("inert", /.*/);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".pas-rt-main")))).toBe(true);
    // 창은 그대로 쓸 수 있다: 쓰던 글을 보낸다.
    await button(decideOf(page), "커멘트 전송").click();
    await expect.poll(() => harness.callsOf("POST", /comments$/).length).toBe(1);
    expect(harness.callsOf("POST", /comments$/)[0].body).toMatchObject({ body: "쓰던 글" });
    if (width === 1440) dialogRows.push({ target: "카드 패널 실패 안내(청크를 못 받았을 때)", open: "「카드 패널 열기」", first: "닫기", enter: "닫기 단추 누름", esc: "안내만 닫는다. 보고 창과 쓰던 글 그대로", after: "「카드 패널 열기」(잠금을 먼저 풀고)" });
  });
}

test("카드 패널 안내를 Esc로 닫아도 잠금이 풀리고 초점은 「카드 패널 열기」로 간다", async ({ page }) => {
  await openScreen(page, 1440, "light", {
    beforeGoto: async target => { await target.route(url => /PasCardPanel\.tsx/.test(url.pathname), route => route.abort()); },
  });
  await openWindow(page);
  const opener = dialogOf(page).getByTestId("pas-rt-open-card-panel");
  await opener.click();
  await expect(dialogOf(page).getByTestId("pas-rt-panel-error")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogOf(page).getByTestId("pas-rt-panel-error")).toHaveCount(0);
  await expect(dialogOf(page)).toBeVisible();
  await expect(opener).toBeFocused();
  await expect(dialogOf(page).locator(".pas-rt-main")).not.toHaveAttribute("inert", /.*/);
});

test("카드 패널을 연 채 안건이 모두 사라지면 패널도 내려가고, 안건이 돌아와도 저절로 다시 뜨지 않는다", async ({ page }) => {
  const fixture = buildPasThreadFixture();
  // 진행 중 카드도 없는 판으로 만들어, 결재 대기 안건이 사라지면 활성 안건이 비게 한다.
  fixture.list = fixture.list.filter(card => card.status === "on_hold");
  const original = fixture.entries;
  const harness = await openScreen(page, 1440, "light", { fixture });
  await openWindow(page);
  await dialogOf(page).getByTestId("pas-rt-open-card-panel").click();
  await expect(page.getByTestId("v3-card-workspace")).toBeVisible();
  fixture.entries = original.filter(entry => !entry.card_id);
  await harness.publishEntries();
  await expect(dialogOf(page).getByTestId("pas-rt-empty")).toBeVisible();
  await expect(page.getByTestId("v3-card-workspace")).toHaveCount(0);
  // 초점은 body로 떨어지지 않고 빈 안내에 남는다.
  await expect(dialogOf(page).getByTestId("pas-rt-empty")).toBeFocused();
  fixture.entries = original;
  await harness.publishEntries();
  await expect(dialogOf(page).locator(".pas-rt-rail-item[data-active=true]")).toBeVisible();
  await expect(page.getByTestId("v3-card-workspace")).toHaveCount(0);
});
