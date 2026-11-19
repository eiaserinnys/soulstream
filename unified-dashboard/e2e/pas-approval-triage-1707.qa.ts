// 시안 C(홈 플래너 3단 트리아지 장부와 지켜보는 중 선반)의 조작 검수.
// 실행: npx tsx e2e/pas-approval-triage-1707.qa.ts
// 빌드: MOCKUP=pas-approval-1707-triage npx vite build --config vite.mockup.config.ts
import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const MOCKUP = "pas-approval-1707-triage";
const OUT = path.resolve(`.local/${MOCKUP}`);
mkdirSync(OUT, { recursive: true });

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const pass = (message: string) => console.log(`PASS ${message}`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("빈 포트를 찾지 못했습니다")));
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* 아직 뜨지 않음 */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`정적 서버가 뜨지 않았습니다: ${url}`);
}

type Opened = { page: Page; close(): Promise<void>; failures: string[] };

async function open(browser: Browser, base: string, width: number, height: number, theme: "dark" | "light"): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
  });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("requestfailed", request => {
    if (/\/api\/|\/characters\//.test(request.url())) failures.push(`FAILED ${request.url()}`);
  });
  page.on("response", response => {
    if (/\/api\/|\/characters\//.test(response.url()) && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(`${base}/frame.html?theme=${theme}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="v3-ht-root"]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return { page, failures, close: () => context.close() };
}

async function unmocked(page: Page): Promise<string[]> {
  const entries = await page.evaluate(() => (window as unknown as { __mockupUnmocked?: string[] }).__mockupUnmocked ?? []);
  return entries.filter(entry => !entry.startsWith("STREAM"));
}

async function assertClean(page: Page, failures: string[], label: string): Promise<void> {
  const bad = await unmocked(page);
  assert(bad.length === 0, `${label}: 등록하지 않은 요청 ${bad.join(", ")}`);
  assert(failures.length === 0, `${label}: 실패한 요청 ${failures.join(", ")}`);
  pass(`${label}: 등록하지 않은 API/IMAGE 0`);
}

async function assertNoOverflow(page: Page, label: string): Promise<number> {
  const gap = await page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(root.scrollWidth - root.clientWidth, document.body.scrollWidth - document.body.clientWidth);
  });
  assert(gap <= 0, `${label}: 가로 넘침 ${gap}px`);
  pass(`${label}: 가로 넘침 0px`);
  return gap;
}

async function capture(page: Page, name: string): Promise<string> {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function boardCount(page: Page, status: string): Promise<number> {
  const text = await page.getByTestId(`v3-ht-board-count-${status}`).innerText();
  const match = text.match(/(\d+)/);
  assert(match, `보드 ${status} 개수를 읽지 못했습니다: ${text}`);
  return Number(match[1]);
}

async function main() {
  const port = await freePort();
  const server: ChildProcess = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", "dist-mockups"], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}/${MOCKUP}`;
  await waitForServer(`${base}/frame.html`);

  const browser = await chromium.launch({ headless: true });
  const shots: string[] = [];
  try {
    // A. 1440 다크: 기본 화면, 장부, 근거 대화상자, PAS 화면
    const dark = await open(browser, base, 1440, 900, "dark");
    const page = dark.page;
    await assertClean(page, dark.failures, "1440 dark");
    assert(await page.evaluate(() => window.location.hash) === "#triage", "첫 해시가 #triage 가 아닙니다");
    assert(await page.locator(".dashboard-toolbar-brand").innerText() === "Soulstream", "도구 막대 브랜드가 다릅니다");
    assert(await page.locator(".dashboard-toolbar-search").isDisabled(), "세션 검색 캡슐이 비활성이 아닙니다");
    assert(await page.locator('[data-testid^="v3-ht-row-"]').count() === 5, "확인할 것 5건이 아닙니다");
    pass("R2: 확인할 것 5건");
    assert(await page.getByTestId("v3-ht-row-1680").getAttribute("aria-expanded") === "true", "#1680 이 처음부터 펼쳐지지 않았습니다");
    assert((await page.getByTestId("v3-ht-session").innerText()).includes("로젤린"), "담당 세션이 로젤린이 아닙니다");
    const sessionPortrait = page.getByTestId("v3-ht-session").locator("img");
    assert(await sessionPortrait.count() === 1, "담당 세션 초상이 이미지가 아닙니다");
    assert((await sessionPortrait.getAttribute("src"))?.includes("system-portrait.png"), "담당 세션 초상이 묶음 초상으로 바뀌지 않았습니다");
    const pasPortrait = page.locator(".v3-ht-pas-entry img");
    assert(await pasPortrait.count() === 1, "PAS 진입 초상이 이미지가 아닙니다");
    assert((await pasPortrait.getAttribute("src"))?.includes("system-portrait.png"), "PAS 진입 초상이 묶음 초상으로 바뀌지 않았습니다");
    pass("R2: 담당 세션과 PAS 진입이 ProfileAvatar 초상을 쓴다");

    await page.getByTestId("v3-ht-row-1387").click();
    assert(await page.getByTestId("v3-ht-row-1387").getAttribute("aria-expanded") === "true", "#1387 이 펼쳐지지 않았습니다");
    assert((await page.getByTestId("v3-ht-session").innerText()).includes("아리에라"), "담당 세션이 아리에라로 바뀌지 않았습니다");
    assert(await page.locator("#v3-ht-detail-card-1387 .v3-ht-item").count() === 4, "확인 항목 4건이 아닙니다");
    pass("R2: 행을 누르면 그 자리에서 펼쳐지고 담당 세션이 바뀐다");

    await page.keyboard.press("ArrowDown");
    assert(await page.getByTestId("v3-ht-row-1408").getAttribute("aria-expanded") === "true", "ArrowDown 이 다음 안건으로 가지 않았습니다");
    await page.keyboard.press("k");
    assert(await page.getByTestId("v3-ht-row-1387").getAttribute("aria-expanded") === "true", "k 가 이전 안건으로 가지 않았습니다");
    await page.getByTestId("v3-ht-next").click();
    assert(await page.getByTestId("v3-ht-row-1408").getAttribute("aria-expanded") === "true", "다음 안건 단추가 움직이지 않았습니다");
    pass("R2: ArrowUp/ArrowDown, j/k, 다음 안건");

    await page.getByTestId("v3-ht-evidence-ev1408-a").click();
    await page.waitForSelector("dialog[open]");
    assert(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog"))), "대화상자 안에 초점이 없습니다");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    const returned = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert(returned === "v3-ht-evidence-ev1408-a", `닫은 뒤 초점이 근거 단추로 돌아오지 않았습니다: ${returned}`);
    pass("14: 근거 대화상자를 열면 초점이 안으로, Esc 로 닫으면 연 단추로 돌아온다");

    await page.getByTestId("v3-ht-evidence-ev1408-a").click();
    await page.waitForSelector("dialog[open]");
    const closeCap = page.getByTestId("v3-ht-dialog-close");
    assert(await closeCap.evaluate(element => element.classList.contains("dashboard-icon-cap")), "근거 닫기 단추가 DashboardIconCap 이 아닙니다");
    await closeCap.click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    const closeReturned = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert(closeReturned === "v3-ht-evidence-ev1408-a", `아이콘 닫기 뒤 초점이 근거 단추로 돌아오지 않았습니다: ${closeReturned}`);
    pass("14: DashboardIconCap 닫기 단추로 닫아도 초점이 연 단추로 돌아온다");

    await assertNoOverflow(page, "1440");
    shots.push(await capture(page, "1440-dark"));

    await page.getByTestId("pas-entry").click();
    assert(await page.evaluate(() => window.location.hash) === "#pas", "PAS 진입 해시가 #pas 가 아닙니다");
    const banner = await page.locator(".v3-ht-pas-banner p").innerText();
    assert(banner.includes("검수 3건"), `배너 문구가 다릅니다: ${banner}`);
    shots.push(await capture(page, "1440-dark-pas"));
    await page.getByTestId("v3-ht-pas-home").click();
    assert(await page.evaluate(() => window.location.hash) === "#triage", "홈 복귀 해시가 #triage 가 아닙니다");
    await assertClean(page, dark.failures, "1440 dark after PAS");
    pass("R1: 도구 막대 PAS 진입과 한 줄 배너, 홈 복귀");

    await page.getByTestId("pas-entry").click();
    assert(await page.evaluate(() => window.location.hash) === "#pas", "브랜드 복귀 시험 전 PAS 해시가 아닙니다");
    await page.getByTestId("brand-home").click();
    assert(await page.evaluate(() => window.location.hash) === "#triage", "브랜드 캡슐이 홈 해시로 돌아오지 않았습니다");
    assert(await page.locator(".v3-ht-panes").isVisible(), "브랜드 캡슐 뒤 홈 3단이 보이지 않습니다");
    pass("R1: PAS 화면에서 브랜드 캡슐을 누르면 홈 트리아지로 돌아온다");

    // R3. 지켜보는 중 선반
    await page.getByTestId("v3-ht-row-1387").click();
    await page.getByTestId("v3-ht-shelve-1387").click();
    assert(await page.locator('[data-testid^="v3-ht-row-"]').count() === 4, "선반으로 옮긴 뒤 4건이 아닙니다");
    assert((await page.getByTestId("v3-ht-shelf-count").innerText()) === "3건", "선반 개수가 3건이 아닙니다");
    assert(await page.getByTestId("v3-ht-row-1408").getAttribute("aria-expanded") === "true", "다음 행이 자동으로 펼쳐지지 않았습니다");
    await page.getByTestId("v3-ht-undo").getByRole("button", { name: "되돌리기" }).click();
    assert(await page.locator('[data-testid^="v3-ht-row-"]').count() === 5, "되돌리기 뒤 5건이 아닙니다");
    assert((await page.getByTestId("v3-ht-shelf-count").innerText()) === "2건", "되돌리기 뒤 선반이 2건이 아닙니다");
    assert(await page.getByTestId("v3-ht-row-1387").getAttribute("aria-expanded") === "true", "되돌린 카드가 펼쳐지지 않았습니다");
    pass("R3: 선반 이동, 개수 증가, 다음 행 자동 펼침, 되돌리기");

    await page.getByTestId("v3-ht-shelf-toggle").click();
    assert(await page.locator(".v3-ht-shelf-row").count() === 2, "선반 목록이 2건이 아닙니다");
    await page.getByTestId("v3-ht-shelf-complete-all").click();
    assert((await page.getByTestId("v3-ht-shelf-count").innerText()) === "0건", "일괄 완료 뒤 선반이 비지 않았습니다");
    pass("R3: 선반 펼침과 일괄 완료");
    await dark.close();

    // A2. 질문 안건의 인라인 선택지 결재와 세션 직접 답하기
    const choice = await open(browser, base, 1440, 900, "dark");
    const cp = choice.page;
    assert(await cp.locator('[data-testid^="v3-ht-choice-"]').count() === 3, "질문 선택지가 3개가 아닙니다");
    assert((await cp.getByTestId("v3-ht-choice-1680-7d").innerText()).includes("권함"), "권함 표시가 없습니다");
    await cp.getByTestId("v3-ht-choice-1680-7d").click();
    assert(await cp.locator('[data-testid^="v3-ht-row-"]').count() === 4, "선택지 결재 뒤 확인할 것이 4건이 아닙니다");
    assert(await cp.getByTestId("v3-ht-row-1512").getAttribute("aria-expanded") === "true", "선택지 결재 뒤 다음 안건이 펼쳐지지 않았습니다");
    assert((await cp.getByTestId("v3-ht-session").innerText()).includes("키키"), "선택지 결재 뒤 담당 세션이 키키가 아닙니다");
    await assertClean(cp, choice.failures, "질문 선택지 결재");
    pass("질문: 장부 안 선택지로 바로 결재하고 다음 안건으로 넘어간다");
    await choice.close();

    const direct = await open(browser, base, 1440, 900, "dark");
    const dp = direct.page;
    await dp.getByTestId("v3-ht-direct-1680").click();
    await dp.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    assert(await dp.evaluate(() => document.activeElement?.closest(".v3-ht-session") !== null), "초점이 담당 세션 패널 밖에 있습니다");
    pass("질문: 세션에 직접 답하기가 담당 세션 입력창으로 초점을 넘긴다");
    await direct.close();

    // B. 1440 다크 보드: 열 이름, 보류 18, 폴더 필터, 검수 승인
    const board = await open(browser, base, 1440, 900, "dark");
    const bp = board.page;
    await bp.getByTestId("v3-ht-tab-board").click();
    assert(await bp.evaluate(() => window.location.hash) === "#board", "보드 해시가 #board 가 아닙니다");
    for (const [status, label] of [["todo", "할 일"], ["queued", "대기"], ["blocked", "막힘"], ["running", "진행"], ["review", "검수"], ["on_hold", "보류"], ["done", "완료"]] as const) {
      const head = bp.locator(`[data-board-column="${status}"] .v3-detail-section-head h3`);
      assert((await head.innerText()) === label, `${status} 열 이름이 ${label} 이 아닙니다`);
    }
    assert(await boardCount(bp, "on_hold") === 18, "보류가 18이 아닙니다");
    assert(await boardCount(bp, "review") === 3, "검수가 3이 아닙니다");
    assert(await boardCount(bp, "done") === 12, "완료가 12가 아닙니다");
    shots.push(await capture(bp, "1440-dark-board"));
    pass("R4: 일곱 열, 보류 18, 검수 3, 완료 12");

    await bp.locator(".v3-ht-nav-row", { hasText: "kaleidoscope" }).first().click();
    assert(await boardCount(bp, "review") === 1, "폴더 필터 뒤 검수가 1이 아닙니다");
    assert(await boardCount(bp, "on_hold") === 0, "폴더 필터 뒤 보류가 0이 아닙니다");
    await bp.locator(".v3-ht-nav-row", { hasText: "전체 카드" }).click();
    assert(await boardCount(bp, "on_hold") === 18, "필터 해제 뒤 보류가 18이 아닙니다");
    pass("R4: 폴더를 누르면 그 폴더 카드만 남는다");

    await bp.getByTestId("v3-ht-tab-triage").click();
    await bp.getByTestId("v3-ht-row-1387").click();
    await bp.getByTestId("v3-ht-primary-1387").click();
    await bp.getByTestId("v3-ht-tab-board").click();
    assert(await boardCount(bp, "review") === 2, "검수 승인 뒤 검수가 2가 아닙니다");
    assert(await boardCount(bp, "done") === 13, "검수 승인 뒤 완료가 13이 아닙니다");
    assert(await boardCount(bp, "on_hold") === 18, "검수 승인 뒤 보류가 18이 아닙니다");
    pass("R4: 카드를 완료하면 검수에서 빠지고 보류는 18 그대로다");
    await board.close();

    // C. 1440 라이트
    const light = await open(browser, base, 1440, 900, "light");
    await assertNoOverflow(light.page, "1440 light");
    shots.push(await capture(light.page, "1440-light"));
    await light.close();

    // D. 820 태블릿: 하단 탭으로 전환
    const tablet = await open(browser, base, 820, 1080, "dark");
    const tp = tablet.page;
    assert(await tp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "820 에서 하단 탭이 보이지 않습니다");
    assert(!(await tp.locator('[data-slot-name="folders"]').isVisible()), "820 에서 폴더 패널이 숨겨지지 않았습니다");
    assert(await tp.getByTestId("v3-ht-row-1680").isVisible(), "820 에서 장부가 보이지 않습니다");
    await assertNoOverflow(tp, "820");
    shots.push(await capture(tp, "820-dark"));
    await tp.getByTestId("v3-ht-mobile-tab-session").click();
    assert(await tp.getByTestId("v3-ht-session").isVisible(), "담당 세션 탭이 패널을 보여 주지 않습니다");
    await tp.getByTestId("v3-ht-mobile-tab-folders").click();
    assert(await tp.locator(".v3-ht-nav").isVisible(), "폴더 탭이 내비게이션을 보여 주지 않습니다");
    pass("R5: 820 에서 하단 탭 세 개가 패널을 바꾼다");
    await tablet.close();

    // E. 390 휴대폰: 장부, 세션 로그 보기, 대화상자 초점, Tab 순서
    const phone = await open(browser, base, 390, 844, "dark");
    const pp = phone.page;
    assert(await pp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "390 에서 하단 탭이 보이지 않습니다");
    await assertNoOverflow(pp, "390");
    await pp.getByTestId("v3-ht-row-1408").click();
    await pp.getByRole("button", { name: "세션 로그 보기" }).click();
    assert(await pp.getByTestId("v3-ht-mobile-tab-session").getAttribute("aria-selected") === "true", "세션 로그 보기가 세션 탭으로 넘기지 않았습니다");
    assert(await pp.getByTestId("v3-ht-session").isVisible(), "세션 탭에서 담당 세션이 보이지 않습니다");
    shots.push(await capture(pp, "390-session"));
    await pp.getByTestId("v3-ht-mobile-tab-triage").click();
    shots.push(await capture(pp, "390-dark"));
    pass("R5: 390 에서 세션 로그 보기가 담당 세션 탭으로 넘긴다");

    for (let index = 0; index < 20; index += 1) {
      await pp.keyboard.press("Tab");
      const hidden = await pp.evaluate(() => {
        const slot = document.activeElement?.closest(".v3-ht-slot");
        return Boolean(slot && !slot.classList.contains("is-mobile-active"));
      });
      assert(!hidden, `Tab ${index + 1}번째에 숨은 패널로 초점이 들어갔습니다`);
    }
    pass("15: 390 에서 Tab 이 숨은 패널로 들어가지 않는다");

    await pp.getByTestId("v3-ht-row-1408").click();
    await pp.getByTestId("v3-ht-evidence-ev1408-a").click();
    await pp.waitForSelector("dialog[open]");
    for (let index = 0; index < 6; index += 1) {
      await pp.keyboard.press("Tab");
      assert(await pp.evaluate(() => Boolean(document.activeElement?.closest("dialog"))), "대화상자에서 Tab 이 빠져나갔습니다");
    }
    await assertNoOverflow(pp, "390 dialog");
    await pp.keyboard.press("Escape");
    await pp.waitForFunction(() => !document.querySelector("dialog[open]"));
    pass("15: 대화상자가 Tab 을 가두고 Esc 로 닫힌다");
    await phone.close();

    // F. 360 최소 폭: 긴 제목 줄임과 넘침
    const narrow = await open(browser, base, 360, 800, "dark");
    const np = narrow.page;
    await assertNoOverflow(np, "360");
    const titleBox = await np.getByTestId("v3-ht-row-1408").locator(".v3-ht-row-title").evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    assert(titleBox.scrollWidth > titleBox.clientWidth, "360 에서 긴 제목이 말줄임되지 않았습니다");
    assert(titleBox.right <= 360, `360 에서 제목이 화면을 넘습니다: ${titleBox.right}`);
    shots.push(await capture(np, "360-dark"));
    pass("16: 360 에서 긴 제목이 말줄임되고 가로 넘침이 없다");
    await narrow.close();

    // G. 18번: 창 크기 바꾸기
    const resize = await open(browser, base, 1440, 900, "dark");
    const rp = resize.page;
    await rp.getByTestId("v3-ht-row-1387").click();
    const composer = rp.locator(".v3-ht-session textarea");
    await composer.fill("이어서 확인 부탁드립니다");
    const scrollable = await rp.locator(".v3-ht-planner-scroll").evaluate(element => {
      element.scrollTop = 40;
      return { top: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    await rp.setViewportSize({ width: 820, height: 900 });
    await rp.waitForTimeout(250);
    assert(await rp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "820 으로 줄였을 때 하단 탭이 뜨지 않았습니다");
    await rp.setViewportSize({ width: 390, height: 844 });
    await rp.waitForTimeout(250);
    assert(await rp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "390 으로 줄였을 때 하단 탭이 뜨지 않았습니다");
    await rp.setViewportSize({ width: 1440, height: 900 });
    await rp.waitForTimeout(300);
    assert(await rp.locator(".v3-ht-nav").isVisible(), "넓혔을 때 폴더 패널이 돌아오지 않았습니다");
    assert(await rp.getByTestId("v3-ht-session").isVisible(), "넓혔을 때 담당 세션이 돌아오지 않았습니다");
    assert(await composer.inputValue() === "이어서 확인 부탁드립니다", "창을 바꾸는 동안 입력 중인 글이 사라졌습니다");
    const scrollNow = await rp.locator(".v3-ht-planner-scroll").evaluate(element => ({
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    }));
    const expected = Math.min(scrollable.top, Math.max(0, scrollNow.max));
    assert(Math.abs(scrollNow.top - expected) <= 8, `스크롤 위치가 ${expected} 에서 ${scrollNow.top} 로 바뀌었습니다`);
    pass(`18: 창을 1440, 820, 390 으로 바꿔도 배치와 입력 글이 유지된다 (스크롤 ${scrollable.top} -> ${scrollNow.top}, 상한 ${scrollNow.max})`);
    await resize.close();

    const summary = {
      mockup: MOCKUP,
      captures: shots,
      overflow: "0px at 1440, 1440 light, 820, 390, 360",
      mockupUnmocked: "API/IMAGE 0 (STREAM 제외)",
      uiDesignGate: { "14": "pass", "15": "pass", "16": "pass", "17": "해당 없음: 견본 데이터만 쓰고 네트워크 요청이 없다", "18": "pass" },
    };
    writeFileSync(path.join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`SUMMARY ${JSON.stringify(summary)}`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch(error => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
