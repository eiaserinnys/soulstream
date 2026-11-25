import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPasThreadFixture, PAS_THREAD_IDS as ID, type PasThreadFixture } from "../client/v3/pas-report-thread/pas-report-thread-fixtures";
import { chatUiSession, installThreadScreen, type Harness } from "./pas-report-thread-harness";

/**
 * 결재형 보고 창(#1871) 화면 시험. 시안 QA(pas-report-1707-thread.qa.mjs) 가운데 실제 화면에 해당하는 검사를
 * 운영 형태 표본으로 옮겼다. 캡처와 조작 결과(operations.md)는 PAS_REPORT_THREAD_SHOTS에 쓴다.
 */
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
    "시험 파일은 `unified-dashboard/e2e/pas-report-thread.e2e.ts`, 가짜 서버는 `pas-report-thread-harness.ts`다.", "",
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
const atBottom = (scroll: Locator) => scroll.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const focusedInside = (page: Page) => page.evaluate(() => {
  const active = document.activeElement;
  return Boolean(active && active !== document.body && active.closest('[data-testid="pas-report-thread-dialog"]'));
});

async function openScreen(page: Page, width: number, theme: Theme, options: { height?: number; fixture?: PasThreadFixture } = {}) {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  const harness = await installThreadScreen(page, { theme, fixture: options.fixture });
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
    await expect(button(decide, "지시 적기")).toBeVisible();
    await expect(button(decide, "답변 미루기")).toBeVisible();
    // 질문: 선택지, 다르게 답하기, 되묻기, 답변 미루기. 질문이 열려 있으면 일반 지시 적기는 없다.
    await pick(page, ID.question);
    await expect(dialog.getByTestId("pas-rt-timeline")).toContainText("의존 관계 표시");
    for (const name of ["카드 안에 줄로 보여 주기", "별도 그래프로 보여 주기"]) await expect(decide.locator(".pas-rt-choice").filter({ hasText: name })).toBeVisible();
    await expect(decide.locator(".pas-rt-choice").first()).toContainText("권함");
    for (const name of ["다르게 답하기", "되묻기", "답변 미루기"]) await expect(button(decide, name)).toBeVisible();
    await expect(button(decide, "지시 적기")).toHaveCount(0);
    await expect.poll(() => atBottom(scrollOf(page))).toBe(true);
    await shot(page, `w1440-${theme}-question`);
    // 부탁: 했어, 되묻기, 답변 미루기.
    await pick(page, ID.request);
    for (const name of ["했어", "되묻기", "답변 미루기"]) await expect(button(decide, name)).toBeVisible();
    await expect(button(decide, "다르게 답하기")).toHaveCount(0);
    await expect(button(decide, "지시 적기")).toHaveCount(0);
    // 막힘: 확인했어, 지시 적기, 답변 미루기.
    await pick(page, ID.blocked);
    for (const name of ["확인했어", "지시 적기", "답변 미루기"]) await expect(button(decide, name)).toBeVisible();
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
  await expect(jump).toHaveText("새 경과 ↓");
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
