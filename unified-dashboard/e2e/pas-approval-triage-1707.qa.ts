// 시안 C(홈 플래너 3단 트리아지 장부와 지켜보는 중 선반)의 조작 검수.
// 실행: npx tsx e2e/pas-approval-triage-1707.qa.ts
// 빌드: MOCKUP=pas-approval-1707-triage npx vite build --config vite.mockup.config.ts
//
// 세라피엘 1차 검수의 capture.py, interact_c.py, extra.py 시나리오와 측정을 이 파일로 옮겼다.
// 발행 검수 하네스의 고정 코멘트 단추는 로컬 묶음에 없으므로 같은 자리(오른쪽 16px, 아래 16px)에
// 112x64 상자를 세워 겹침과 실제 좌표 클릭을 잰다.
import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const MOCKUP = "pas-approval-1707-triage";
const OUT = path.resolve(`.local/${MOCKUP}`);
mkdirSync(OUT, { recursive: true });

const COMMENT_BOX = { width: 112, height: 64, right: 16, bottom: 16 };

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

async function open(
  browser: Browser,
  base: string,
  width: number,
  height: number,
  theme: "dark" | "light",
  extra = "",
): Promise<Opened> {
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
  await page.goto(`${base}/frame.html?theme=${theme}${extra}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="v3-ht-root"]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
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

async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const gap = Math.max(doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - document.body.clientWidth);
    const over: { tag: string; cls: string; left: number; right: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= doc.clientWidth + 1 && rect.left >= -1) continue;
      let parent = el.parentElement;
      let clipped = false;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
          const parentRect = parent.getBoundingClientRect();
          if (parentRect.right <= doc.clientWidth + 1 && parentRect.left >= -1) {
            clipped = true;
            break;
          }
        }
        parent = parent.parentElement;
      }
      if (!clipped) {
        over.push({
          tag: el.tagName,
          cls: String(typeof el.className === "string" ? el.className : "").slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        });
      }
    }
    return { gap, over: over.slice(0, 12) };
  });
  assert(result.gap <= 0, `${label}: 가로 넘침 ${result.gap}px`);
  assert(result.over.length === 0, `${label}: 화면 밖 요소 ${JSON.stringify(result.over)}`);
  pass(`${label}: 가로 넘침 0px, 화면 밖 요소 0`);
}

async function capture(page: Page, name: string): Promise<string> {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function installCommentButton(page: Page): Promise<void> {
  await page.evaluate(box => {
    document.querySelector('[data-testid="qa-comment-button"]')?.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-testid", "qa-comment-button");
    button.textContent = "코멘트 0";
    button.style.cssText = [
      "position:fixed",
      `right:${box.right}px`,
      `bottom:${box.bottom}px`,
      `width:${box.width}px`,
      `height:${box.height}px`,
      "z-index:2147483647",
      "border:0",
      "border-radius:10px",
      "background:#245dcc",
      "color:white",
      "font:15px/1.5 system-ui,sans-serif",
      "pointer-events:auto",
    ].join(";");
    (button as unknown as { __qaClicks: number }).__qaClicks = 0;
    button.addEventListener("click", () => {
      const target = button as unknown as { __qaClicks: number };
      target.__qaClicks += 1;
    });
    document.body.appendChild(button);
  }, COMMENT_BOX);
}

async function removeCommentButton(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('[data-testid="qa-comment-button"]')?.remove());
}

async function commentButtonClicks(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector('[data-testid="qa-comment-button"]') as unknown as { __qaClicks?: number } | null)?.__qaClicks ?? 0);
}

async function commentOverlap(page: Page, label: string): Promise<void> {
  await installCommentButton(page);
  const hits = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="qa-comment-button"]');
    if (!button) return [];
    const target = button.getBoundingClientRect();
    const found: { tag: string; text: string; rect: number[]; overlap: number[] }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a, input, textarea, [role=button], [role=tab], select")) {
      if (el === button || el.closest('[data-testid="qa-comment-button"]')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const raw = el.getBoundingClientRect();
      let left = raw.left;
      let right = raw.right;
      let top = raw.top;
      let bottom = raw.bottom;
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const parentStyle = getComputedStyle(parent);
        if (/(hidden|auto|scroll|clip)/.test(parentStyle.overflowX) || /(hidden|auto|scroll|clip)/.test(parentStyle.overflowY)) {
          const clip = parent.getBoundingClientRect();
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        parent = parent.parentElement;
      }
      if (right <= left || bottom <= top) continue;
      const ix = Math.min(right, target.right) - Math.max(left, target.left);
      const iy = Math.min(bottom, target.bottom) - Math.max(top, target.top);
      if (ix > 0 && iy > 0) {
        found.push({
          tag: el.tagName,
          text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
          rect: [Math.round(left), Math.round(top), Math.round(right - left), Math.round(bottom - top)],
          overlap: [Math.round(ix), Math.round(iy)],
        });
      }
    }
    return found;
  });
  await removeCommentButton(page);
  assert(hits.length === 0, `${label}: 고정 코멘트 단추와 겹치는 조작 요소 ${JSON.stringify(hits)}`);
  pass(`${label}: 고정 112x64 코멘트 단추와 겹침 0`);
}

async function boardCount(page: Page, status: string): Promise<number> {
  const column = page.locator(`.v3-card-board-column[data-board-column="${status}"]`);
  if (await column.count() === 0) return 0;
  const text = await column.locator(".v3-detail-section-head span").first().innerText();
  const match = text.match(/(\d+)/);
  assert(match, `보드 ${status} 개수를 읽지 못했습니다: ${text}`);
  return Number(match[1]);
}

async function boardHeaderCount(page: Page): Promise<number> {
  const text = await page.locator(".v3-folder-card-head span").first().innerText();
  const match = text.match(/(\d+)/);
  assert(match, `보드 전체 개수를 읽지 못했습니다: ${text}`);
  return Number(match[1]);
}

async function waitDialog(page: Page): Promise<void> {
  await page.waitForSelector('[data-slot="dialog-popup"]');
  await page.waitForTimeout(120);
}

async function dialogCenter(page: Page): Promise<{ dx: number; dy: number; width: number; height: number }> {
  return page.evaluate(() => {
    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
    if (!popup) throw new Error("대화상자가 없습니다");
    const rect = popup.getBoundingClientRect();
    return {
      dx: Math.round((rect.left + rect.right) / 2 - window.innerWidth / 2),
      dy: Math.round((rect.top + rect.bottom) / 2 - window.innerHeight / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

async function closeDialogByEscape(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-slot="dialog-popup"]'));
  await page.waitForTimeout(80);
}

async function chooseFirstChoice(page: Page, number: number): Promise<void> {
  await page.getByTestId(`v3-ht-row-${number}`).click();
  const choice = page.locator(`[data-testid^="v3-ht-choice-${number}-"]`).first();
  assert(await choice.count() === 1, `#${number} 질문 선택지가 없습니다`);
  await choice.click();
  await page.waitForTimeout(120);
}

async function completeByPrimary(page: Page, number: number): Promise<void> {
  await page.getByTestId(`v3-ht-row-${number}`).click();
  await page.getByTestId(`v3-ht-primary-${number}`).click();
  await page.waitForTimeout(120);
}

async function checkBoardAndPasLayout(browser: Browser, base: string, shots: string[]): Promise<void> {
  const failures: string[] = [];
  for (const [width, height] of [[1440, 900], [820, 1180]] as const) {
    const opened = await open(browser, base, width, height, "dark", "#board");
    const page = opened.page;
    const metrics = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".v3-ht-planner");
      const scroll = document.querySelector<HTMLElement>(".v3-ht-planner-scroll");
      const wrapper = document.querySelector<HTMLElement>(".v3-ht-board-scroll");
      const board = document.querySelector<HTMLElement>(".v3-ht-board-scroll .v3-card-board");
      const columns = document.querySelectorAll<HTMLElement>(".v3-ht-board-scroll .v3-card-board-column");
      if (!panel || !scroll || !wrapper || !board || !columns.length) throw new Error("보드 구성 요소가 없습니다");
      const measuredColumns: { status: string | undefined; bottom: number; height: number }[] = [];
      for (const column of columns) {
        const rect = column.getBoundingClientRect();
        measuredColumns.push({ status: column.dataset.boardColumn, bottom: rect.bottom, height: rect.height });
      }
      return {
        panelBottom: panel.getBoundingClientRect().bottom,
        contentBottom: scroll.getBoundingClientRect().bottom - parseFloat(getComputedStyle(scroll).paddingBottom),
        wrapperBottom: wrapper.getBoundingClientRect().bottom,
        boardBottom: board.getBoundingClientRect().bottom,
        columns: measuredColumns,
      };
    });
    console.log(`C12 ${width}x${height} ${JSON.stringify(metrics)}`);
    if (Math.abs(metrics.contentBottom - metrics.wrapperBottom) > 2) failures.push(`C12 ${width} 래퍼 하단 차이 ${metrics.contentBottom - metrics.wrapperBottom}px`);
    for (const column of metrics.columns) {
      if (Math.abs(metrics.contentBottom - column.bottom) > 8 || metrics.panelBottom - column.bottom > 36 || column.height < 500) {
        failures.push(`C12 ${width} ${column.status} 내용 하단 차이 ${metrics.contentBottom - column.bottom}px, 패널 하단 차이 ${metrics.panelBottom - column.bottom}px, 높이 ${column.height}px`);
      }
    }
    shots.push(await capture(page, `${width}-dark-board-fill`));
    if (width === 820) {
      await page.getByTestId("v3-ht-mobile-tab-session").click();
      await page.getByTestId("v3-ht-mobile-tab-triage").click();
      assert(await page.getByTestId("v3-ht-board").isVisible(), "820 탭 전환 뒤 보드가 보이지 않습니다");
    }
    await opened.close();
  }

  for (const [width, height] of [[1440, 900], [820, 1180], [390, 844], [360, 800]] as const) {
    const opened = await open(browser, base, width, height, "dark", "#pas");
    const page = opened.page;
    const metrics = await page.evaluate(box => {
      const messages = document.querySelector<HTMLElement>(".v3-ht-pas-messages");
      const composer = document.querySelector<HTMLElement>('.v3-ht-pas-chat .v3-ht-composer [data-slot="chat-input-composer"]');
      const input = document.querySelector<HTMLElement>(".v3-ht-pas-chat .v3-ht-composer textarea");
      const send = document.querySelector<HTMLElement>('.v3-ht-pas-chat .v3-ht-composer [data-testid="send-button"]');
      if (!messages || !composer || !input || !send) throw new Error("PAS 입력 구성 요소가 없습니다");
      const target = { left: window.innerWidth - box.right - box.width, right: window.innerWidth - box.right, top: window.innerHeight - box.bottom - box.height, bottom: window.innerHeight - box.bottom };
      const inputRect = input.getBoundingClientRect();
      const sendRect = send.getBoundingClientRect();
      return {
        messagesRight: messages.getBoundingClientRect().right - parseFloat(getComputedStyle(messages).paddingRight),
        composerRight: composer.getBoundingClientRect().right,
        target,
        input: { rect: [inputRect.left, inputRect.top, inputRect.right, inputRect.bottom], width: Math.max(0, Math.min(inputRect.right, target.right) - Math.max(inputRect.left, target.left)), height: Math.max(0, Math.min(inputRect.bottom, target.bottom) - Math.max(inputRect.top, target.top)) },
        send: { rect: [sendRect.left, sendRect.top, sendRect.right, sendRect.bottom], width: Math.max(0, Math.min(sendRect.right, target.right) - Math.max(sendRect.left, target.left)), height: Math.max(0, Math.min(sendRect.bottom, target.bottom) - Math.max(sendRect.top, target.top)) },
      };
    }, COMMENT_BOX);
    console.log(`C13 ${width}x${height} ${JSON.stringify(metrics)}`);
    if (width === 1440 && Math.abs(metrics.messagesRight - metrics.composerRight) > 2) failures.push(`C13 1440 오른쪽 끝 차이 ${metrics.messagesRight - metrics.composerRight}px`);
    if (width !== 1440) {
      for (const [name, rect] of [["input", metrics.input], ["send", metrics.send]] as const) {
        if (rect.width > 0 && rect.height > 0) failures.push(`C13 ${width} ${name} 코멘트 영역과 ${rect.width}x${rect.height}px 겹침`);
      }
      await installCommentButton(page);
      await page.locator(".v3-ht-pas-chat textarea").fill("확인했습니다");
      await page.locator('.v3-ht-pas-chat [data-testid="send-button"]').click();
      assert((await page.getByTestId("v3-ht-pas-transcript").innerText()).includes("확인했습니다"), `${width} PAS 메시지 전송 실패`);
      assert(await commentButtonClicks(page) === 0, `${width} 코멘트 단추가 전송 클릭을 가로챘습니다`);
      await removeCommentButton(page);
    }
    shots.push(await capture(page, `${width}-dark-pas-layout`));
    await opened.close();
  }
  assert(failures.length === 0, failures.join("; "));
  pass("C12/C13: 보드 패널 채움과 PAS 입력 끝선 및 코멘트 단추 회피");
}

async function main() {
  const port = await freePort();
  const server: ChildProcess = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", "dist-mockups"], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}/${MOCKUP}`;
  await waitForServer(`${base}/frame.html`);

  const browser = await chromium.launch({ headless: true });
  const shots: string[] = [];
  try {
    await checkBoardAndPasLayout(browser, base, shots);
    // A. 1440 다크: 기본 장부, 키보드, 질문 카드, 대비, 근거 대화상자
    const home = await open(browser, base, 1440, 900, "dark");
    const page = home.page;
    await assertClean(page, home.failures, "1440 dark");
    assert(await page.evaluate(() => window.location.hash) === "#triage", "첫 해시가 #triage 가 아닙니다");
    assert(await page.locator('[data-testid="v3-global-toolbar"]').count() === 1, "정본 V3GlobalToolbar 가 없습니다");
    assert((await page.getByTestId("brand-home").innerText()).includes("Soulstream"), "도구 막대 브랜드가 다릅니다");
    assert(await page.locator('[data-testid^="v3-ht-row-"]').count() === 5, "확인할 것 5건이 아닙니다");
    assert(await page.getByTestId("v3-ht-row-1680").getAttribute("aria-expanded") === "true", "#1680 이 처음부터 펼쳐지지 않았습니다");
    pass("R2: 정본 도구 막대, 확인할 것 5건, #1680 첫 펼침");

    const header = await page.locator(".v3-ht-session-head").innerText();
    assert(header.includes("로젤린"), `담당 세션 머리에 로젤린이 없습니다: ${header}`);
    assert(header.includes("실행 중"), `담당 세션 머리에 상태가 없습니다: ${header}`);
    assert(!header.includes("deepseek"), `담당 세션 머리에 모델 프리셋이 남았습니다: ${header}`);
    assert(!header.includes("eiaserinnys"), `담당 세션 머리에 노드가 남았습니다: ${header}`);
    assert(await page.locator('[data-testid="v3-ht-session-transcript"] [data-slot="chat-message-row"]').count() >= 3, "세션 기록이 정본 ChatMessageItem 이 아닙니다");
    assert(await page.locator('[data-testid="v3-ht-session"] [data-slot="chat-input-composer"]').count() === 1, "담당 세션 입력창이 정본 ChatInputComposer 가 아닙니다");
    pass("C7/C11: 세션 머리는 이름과 상태만, 기록과 입력창은 정본 채팅 컴포넌트");

    const portraits: string[] = [];
    for (const [number, file] of [[1680, "roselin"], [1512, "kiki"], [1387, "ariella"], [1408, "selaphiel"]] as const) {
      await page.getByTestId(`v3-ht-row-${number}`).click();
      const src = await page.locator(".v3-ht-session-head img").first().getAttribute("src");
      assert(typeof src === "string" && src.includes(`mockup-portraits/${file}.png`), `#${number} 담당 초상이 ${file} 이 아닙니다: ${src}`);
      portraits.push(src);
    }
    await page.getByTestId("v3-ht-row-1680").click();
    const pasPortrait = await page.locator('[data-testid="pas-entry"] img').first().getAttribute("src");
    assert(typeof pasPortrait === "string" && pasPortrait.includes("characters/seosoyoung/still.png"), `PAS 진입 초상이 서소영이 아닙니다: ${pasPortrait}`);
    portraits.push(pasPortrait);
    assert(portraits.every(src => !src.includes("system-portrait.png")), `기본 초상이 섞였습니다: ${portraits.join(", ")}`);
    assert(new Set(portraits.map(src => src.split("?")[0])).size === 5, `에이전트별 초상이 구분되지 않습니다: ${portraits.join(", ")}`);
    pass("초상: 로젤린, 키키, 아리엘라, 세라피엘, 서소영이 서로 다른 그림을 쓴다");

    assert(await page.locator(".v3-ht-question").count() === 1, "질문 카드에 질문 영역이 없습니다");
    assert(await page.locator('[data-testid^="v3-ht-choice-1680-"]').count() === 3, "질문 선택지가 3개가 아닙니다");
    assert(await page.locator("#v3-ht-detail-card-1680 .v3-ht-request").count() === 0, "질문 카드에 중복 요청 줄이 있습니다");
    assert(await page.locator("#v3-ht-detail-card-1680 .v3-ht-item").count() === 0, "질문 카드에 중복 확인 항목이 있습니다");
    const direct = page.getByTestId("v3-ht-direct-1680");
    const next = page.getByTestId("v3-ht-next");
    const directClass = await direct.getAttribute("class") ?? "";
    const nextClass = await next.getAttribute("class") ?? "";
    assert(directClass.includes("bg-popover") && nextClass.includes("bg-popover"), `세션 직접 답하기와 다음 안건이 같은 outline 이 아닙니다: ${directClass} / ${nextClass}`);
    const directBox = await direct.boundingBox();
    const nextBox = await next.boundingBox();
    assert(directBox && nextBox && Math.abs(directBox.height - nextBox.height) <= 1, "세션 직접 답하기와 다음 안건 높이가 다릅니다");
    pass("C6/C10: 질문 카드는 배경 한 줄과 선택지 3개만, 직접 답하기와 다음 안건은 같은 outline");

    await page.getByTestId("v3-ht-row-1408").click();
    assert((await page.getByTestId("v3-ht-session").innerText()).includes("세라피엘"), "담당 세션이 세라피엘로 바뀌지 않았습니다");
    const thumb = page.locator("#v3-ht-detail-card-1408 .v3-ht-thumb").first();
    const thumbBox = await thumb.boundingBox();
    assert(thumbBox && thumbBox.width >= 280, `근거 그림이 넉넉하지 않습니다: ${thumbBox?.width}`);
    const captionFont = await page.locator("#v3-ht-detail-card-1408 .v3-ht-thumb-label").first().evaluate(el => getComputedStyle(el).fontSize);
    assert(captionFont === "12px", `근거 설명 글자가 12px 이 아닙니다: ${captionFont}`);
    const diagramFont = await thumb.evaluate(el => getComputedStyle(el.querySelector(".v3-ht-diagram") ?? el).fontSize);
    assert(diagramFont === "14px", `근거 도식 글자가 14px 이 아닙니다: ${diagramFont}`);
    assert(await page.locator("#v3-ht-detail-card-1408 .v3-ht-request").count() === 1, "검수 카드 요청 줄이 없습니다");
    assert(await page.locator("#v3-ht-detail-card-1408 .v3-ht-scope").count() === 0, "검수 카드에 중복 범위 줄이 있습니다");
    pass("C7: 근거 미리보기는 280px 이상, 설명 12px, 도식 14px, 검수 카드 중복 범위 없음");

    await page.getByTestId("v3-ht-evidence-ev1408-a").click();
    await waitDialog(page);
    const center = await dialogCenter(page);
    assert(Math.abs(center.dx) <= 2 && Math.abs(center.dy) <= 2, `근거 대화상자가 가운데가 아닙니다: ${JSON.stringify(center)}`);
    assert(center.width <= 720, `근거 대화상자가 720px 를 넘습니다: ${center.width}`);
    assert(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="dialog-popup"]'))), "대화상자 안에 초점이 없습니다");
    const closeCap = page.getByTestId("v3-ht-dialog-close");
    assert(await closeCap.evaluate(el => el.classList.contains("dashboard-icon-cap")), "근거 닫기 단추가 DashboardIconCap 이 아닙니다");
    await closeDialogByEscape(page);
    const returned = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert(returned === "v3-ht-evidence-ev1408-a", `Esc 뒤 초점이 근거 단추로 돌아오지 않았습니다: ${returned}`);
    await page.getByTestId("v3-ht-evidence-ev1408-a").click();
    await waitDialog(page);
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      assert(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="dialog-popup"]'))), "대화상자에서 Tab 이 빠져나갔습니다");
    }
    await page.getByTestId("v3-ht-dialog-close").click();
    await page.waitForFunction(() => !document.querySelector('[data-slot="dialog-popup"]'));
    await page.waitForTimeout(80);
    const capReturned = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert(capReturned === "v3-ht-evidence-ev1408-a", `아이콘 닫기 뒤 초점이 근거 단추로 돌아오지 않았습니다: ${capReturned}`);
    pass("C2/14: 근거 대화상자는 가운데, DashboardIconCap 과 Esc 로 닫히고, 초점이 돌아오며 Tab 을 가둔다");

    const selected = await page.locator(".v3-ht-switch-button").nth(1).evaluate(el => {
      window.getSelection()?.removeAllRanges();
      return getComputedStyle(el).userSelect;
    });
    assert(selected === "none", `보기 전환 글자가 선택됩니다: ${selected}`);
    pass("interact: 보기 전환 단추 글자는 선택되지 않는다");

    await assertNoOverflow(page, "1440");
    await commentOverlap(page, "1440");
    shots.push(await capture(page, "1440-dark"));
    await home.close();

    // B. 되돌리기: 질문 선택지, 검수 승인, 선반 이동, 일괄 완료
    const undo = await open(browser, base, 1440, 900, "dark");
    const up = undo.page;
    await chooseFirstChoice(up, 1680);
    assert(await up.locator('[data-testid^="v3-ht-row-"]').count() === 4, "선택지 결재 뒤 확인할 것이 4건이 아닙니다");
    assert((await up.getByTestId("v3-ht-undo").innerText()).includes("질문에 답하고"), "질문 결재 뒤 되돌리기 안내가 없습니다");
    assert(await up.getByTestId("v3-ht-row-1512").getAttribute("aria-expanded") === "true", "선택지 결재 뒤 다음 안건이 펼쳐지지 않았습니다");
    await up.getByTestId("v3-ht-undo").getByRole("button", { name: "되돌리기" }).click();
    assert(await up.locator('[data-testid^="v3-ht-row-"]').count() === 5, "질문 되돌리기 뒤 5건이 아닙니다");
    assert(await up.getByTestId("v3-ht-row-1680").getAttribute("aria-expanded") === "true", "질문 되돌리기 뒤 #1680 이 펼쳐지지 않았습니다");
    pass("C3: 질문 선택지 처분을 되돌리면 이전 처분으로 돌아온다");

    await completeByPrimary(up, 1387);
    assert(await up.locator('[data-testid^="v3-ht-row-"]').count() === 4, "검수 승인 뒤 확인할 것이 4건이 아닙니다");
    assert((await up.getByTestId("v3-ht-undo").innerText()).includes("완료로 옮겼습니다"), "검수 승인 뒤 되돌리기 안내가 없습니다");
    await up.getByTestId("v3-ht-undo").getByRole("button", { name: "되돌리기" }).click();
    assert(await up.locator('[data-testid^="v3-ht-row-"]').count() === 5, "검수 되돌리기 뒤 5건이 아닙니다");
    assert(await up.getByTestId("v3-ht-row-1387").getAttribute("aria-expanded") === "true", "검수 되돌리기 뒤 #1387 이 펼쳐지지 않았습니다");
    pass("C3: 검수 승인을 되돌리면 검수 대기로 돌아온다");

    await up.getByTestId("v3-ht-row-1387").click();
    await up.getByTestId("v3-ht-shelve-1387").click();
    assert(await up.locator('[data-testid^="v3-ht-row-"]').count() === 4, "선반으로 옮긴 뒤 4건이 아닙니다");
    assert((await up.getByTestId("v3-ht-shelf-count").innerText()) === "3건", "선반 개수가 3건이 아닙니다");
    assert((await up.getByTestId("v3-ht-undo").innerText()).includes("지켜보는 중 선반으로"), "선반 이동 뒤 되돌리기 안내가 없습니다");
    await up.getByTestId("v3-ht-undo").getByRole("button", { name: "되돌리기" }).click();
    assert(await up.locator('[data-testid^="v3-ht-row-"]').count() === 5, "선반 되돌리기 뒤 5건이 아닙니다");
    assert((await up.getByTestId("v3-ht-shelf-count").innerText()) === "2건", "선반 되돌리기 뒤 2건이 아닙니다");
    pass("R3: 선반 이동과 되돌리기");

    await up.getByTestId("v3-ht-shelf-toggle").click();
    assert(await up.locator(".v3-ht-shelf-row").count() === 2, "선반 목록이 2건이 아닙니다");
    await up.getByTestId("v3-ht-shelf-complete-all").click();
    assert((await up.getByTestId("v3-ht-shelf-count").innerText()) === "0건", "일괄 완료 뒤 선반이 비지 않았습니다");
    assert((await up.getByTestId("v3-ht-undo").innerText()).includes("지켜보는 카드 2건"), "일괄 완료 뒤 되돌리기 안내가 없습니다");
    await up.getByTestId("v3-ht-undo").getByRole("button", { name: "되돌리기" }).click();
    assert((await up.getByTestId("v3-ht-shelf-count").innerText()) === "2건", "일괄 완료 되돌리기 뒤 선반이 2건이 아닙니다");
    pass("R3: 선반 펼침, 일괄 완료, 일괄 완료 되돌리기");
    await undo.close();

    // C. 보드와 격자: 일곱 열, 개수, 담당 이름, 배경 카드 열기, 폴더 필터
    const board = await open(browser, base, 1440, 900, "dark");
    const bp = board.page;
    await bp.getByTestId("v3-ht-tab-board").click();
    assert(await bp.evaluate(() => window.location.hash) === "#board", "보드 해시가 #board 가 아닙니다");
    for (const [status, label] of [["todo", "드래프트"], ["queued", "대기"], ["blocked", "막힘"], ["running", "실행 중"], ["review", "검수 대기"], ["on_hold", "보류"], ["done", "완료"]] as const) {
      const head = bp.locator(`[data-board-column="${status}"] .v3-detail-section-head h3`);
      assert((await head.innerText()) === label, `${status} 열 이름이 ${label} 이 아닙니다`);
    }
    assert(await boardHeaderCount(bp) === 45, "보드 전체 카드가 45개가 아닙니다");
    assert(await boardCount(bp, "on_hold") === 18, "보류가 18이 아닙니다");
    assert(await boardCount(bp, "review") === 3, "검수 대기가 3이 아닙니다");
    assert(await boardCount(bp, "done") === 12, "완료가 12가 아닙니다");
    pass("R4: 일곱 열, 전체 45개, 보류 18, 검수 대기 3, 완료 12");

    const assignees = await bp.locator(".v3-postit-assignee > span:last-child").allInnerTexts();
    assert(assignees.length === 45, `보드 담당 이름이 45개가 아닙니다: ${assignees.length}`);
    for (const name of assignees) {
      assert(["로젤린", "키키", "아리엘라", "세라피엘"].includes(name), `보드 담당 이름이 실제 에이전트가 아닙니다: ${name}`);
      assert(!/[\u{1F300}-\u{1FAFF}]/u.test(name), `보드 담당 이름에 이모지가 있습니다: ${name}`);
    }
    const fontSizes = await bp.locator(".v3-postit-open").evaluateAll(elements => [...new Set(elements.map(el => getComputedStyle(el).fontSize))]);
    assert(fontSizes.length === 1, `보드 카드 글자 크기가 제각각입니다: ${fontSizes.join(", ")}`);
    pass(`C4: 담당은 실제 에이전트 이름뿐, 이모지 0, 카드 글자 크기 ${fontSizes[0]} 하나`);

    await bp.getByRole("button", { name: /카드 #1690 보드 확대 초점 링 다듬기 열기/ }).click();
    await bp.waitForSelector('[data-testid="v3-card-workspace"]');
    assert(await bp.locator('[data-testid="v3-card-workspace"]').isVisible(), "보드 배경 카드가 CardWorkspace 를 열지 않았습니다");
    assert((await bp.locator('[data-testid="v3-card-workspace"]').innerText()).includes("보드 확대 초점 링 다듬기"), "CardWorkspace 에 #1690 제목이 없습니다");
    await bp.getByRole("button", { name: "카드 닫기" }).click();
    await bp.waitForFunction(() => !document.querySelector('[data-testid="v3-card-workspace"]'));
    await bp.waitForTimeout(120);
    const focusCard = await bp.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert(focusCard?.includes("카드 #1690"), `CardWorkspace 를 닫은 뒤 초점이 카드로 돌아오지 않았습니다: ${focusCard}`);
    pass("C4: 보드 배경 카드 #1690 이 정본 CardWorkspace 를 열고 닫으면 초점이 카드로 돌아온다");

    await bp.getByTestId("v3-ht-tab-grid").click();
    await bp.getByRole("button", { name: /카드 #1690 보드 확대 초점 링 다듬기 열기/ }).click();
    await bp.waitForSelector('[data-testid="v3-card-workspace"]');
    assert((await bp.locator('[data-testid="v3-card-workspace"]').innerText()).includes("보드 확대 초점 링 다듬기"), "격자 배경 카드가 CardWorkspace 를 열지 않았습니다");
    await bp.getByRole("button", { name: "카드 닫기" }).click();
    await bp.waitForFunction(() => !document.querySelector('[data-testid="v3-card-workspace"]'));
    pass("C4: 격자 배경 카드 #1690 도 정본 CardWorkspace 를 연다");

    await bp.getByTestId("v3-ht-tab-board").click();
    await bp.locator('[data-testid="v3-project-row-kaleidoscope"] .v3-project-nav-link').click();
    assert(await boardHeaderCount(bp) === 2, "kaleidoscope 필터 뒤 전체 카드가 2개가 아닙니다");
    assert(await boardCount(bp, "review") === 1, "폴더 필터 뒤 검수가 1이 아닙니다");
    assert(await boardCount(bp, "on_hold") === 0, "폴더 필터 뒤 보류가 0이 아닙니다");
    assert(await bp.locator('[data-board-column="on_hold"]').count() === 0, "빈 보류 열이 남았습니다");
    await bp.getByTestId("v3-ht-all-cards").click();
    assert(await boardHeaderCount(bp) === 45, "필터 해제 뒤 전체 카드가 45개가 아닙니다");
    assert(await boardCount(bp, "on_hold") === 18, "필터 해제 뒤 보류가 18이 아닙니다");
    pass("R4: 폴더를 누르면 그 폴더 카드만 남고 빈 열은 숨는다");

    await bp.getByTestId("v3-ht-tab-triage").click();
    await completeByPrimary(bp, 1387);
    await bp.getByTestId("v3-ht-tab-board").click();
    assert(await boardCount(bp, "review") === 2, "검수 승인 뒤 검수가 2가 아닙니다");
    assert(await boardCount(bp, "done") === 13, "검수 승인 뒤 완료가 13이 아닙니다");
    assert(await boardCount(bp, "on_hold") === 18, "검수 승인 뒤 보류가 18이 아닙니다");
    pass("R4: 카드를 완료하면 검수에서 빠지고 보류는 18 그대로다");
    await assertClean(bp, board.failures, "보드와 CardWorkspace");
    await assertNoOverflow(bp, "1440 board");
    shots.push(await capture(bp, "1440-dark-board"));
    await board.close();

    // D. PAS: 배너 개수 동적 일치, 첫 메시지 다섯 건, 홈 복귀
    const pas = await open(browser, base, 1440, 900, "dark");
    const pp = pas.page;
    await pp.getByTestId("pas-entry").click();
    assert(await pp.evaluate(() => window.location.hash) === "#pas", "PAS 진입 해시가 #pas 가 아닙니다");
    const banner = await pp.locator(".v3-ht-pas-banner p").innerText();
    assert(banner.includes("확인하실 안건 5건"), `배너 개수가 5건이 아닙니다: ${banner}`);
    const pasFirst = await pp.locator('[data-testid="v3-ht-pas-transcript"] [data-slot="chat-message-row"]').first().innerText();
    assert(pasFirst.includes("다섯 건"), `PAS 첫 메시지가 다섯 건이 아닙니다: ${pasFirst}`);
    assert(await pp.locator('[data-testid="v3-ht-pas"] [data-slot="chat-input-composer"]').count() === 1, "PAS 입력창이 정본 ChatInputComposer 가 아닙니다");
    assert(await pp.locator('[data-testid="v3-ht-pas"] canvas').count() === 0, "PAS 대화 영역에 캔버스가 겹칩니다");
    pass("C5/C11: PAS 배너 5건과 첫 메시지 다섯 건이 맞고, 기록과 입력창은 정본 채팅 컴포넌트");
    shots.push(await capture(pp, "1440-dark-pas"));

    await pp.getByTestId("v3-ht-pas-home").click();
    assert(await pp.evaluate(() => window.location.hash) === "#triage", "홈 복귀 해시가 #triage 가 아닙니다");
    await completeByPrimary(pp, 1512);
    await pp.getByTestId("pas-entry").click();
    const bannerAfter = await pp.locator(".v3-ht-pas-banner p").innerText();
    assert(bannerAfter.includes("확인하실 안건 4건"), `처분 뒤 배너 개수가 4건이 아닙니다: ${bannerAfter}`);
    await pp.getByTestId("brand-home").click();
    assert(await pp.evaluate(() => window.location.hash) === "#triage", "브랜드 캡슐이 홈 해시로 돌아오지 않았습니다");
    pass("C5: 안건을 하나 처리하면 PAS 배너가 4건으로 줄고, 브랜드 캡슐로 홈에 돌아온다");
    await pas.close();

    // E. 빈 상태 두 갈래: 전체 처리, 폴더 선택
    const empty = await open(browser, base, 1440, 900, "dark");
    const ep = empty.page;
    for (const number of [1680, 1512, 1387, 1408, 1112]) {
      if (number === 1680) await chooseFirstChoice(ep, number);
      else await completeByPrimary(ep, number);
    }
    assert(await ep.locator('[data-testid^="v3-ht-row-"]').count() === 0, "모두 처리한 뒤 행이 남았습니다");
    const emptyText = await ep.getByTestId("v3-ht-empty").innerText();
    assert(emptyText.includes("확인할 안건을 모두 처리했습니다."), `전체 처리 빈 상태 문구가 다릅니다: ${emptyText}`);
    await ep.locator('[data-testid="v3-project-row-dashboard"] .v3-project-nav-link').click();
    const folderEmpty = await ep.getByTestId("v3-ht-empty").innerText();
    assert(folderEmpty.includes("이 폴더에 확인할 것이 없습니다."), `폴더 빈 상태 문구가 다릅니다: ${folderEmpty}`);
    pass("C9: 전체 처리와 폴더 선택의 빈 상태 문구가 갈린다");
    await empty.close();

    // F. 390 다크: 코멘트 단추와 실제 좌표 탭 클릭, 패널 전환, 대화상자, 넘침
    const phone = await open(browser, base, 390, 844, "dark");
    const mp = phone.page;
    await assertNoOverflow(mp, "390");
    await commentOverlap(mp, "390");
    await installCommentButton(mp);
    const tabBox = await mp.getByTestId("v3-ht-mobile-tab-session").boundingBox();
    assert(tabBox, "담당 세션 탭 좌표를 읽지 못했습니다");
    await mp.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await mp.waitForTimeout(150);
    assert(await mp.getByTestId("v3-ht-root").getAttribute("data-mobile-tab") === "session", "실제 좌표 클릭이 담당 세션 탭으로 넘기지 않았습니다");
    assert(await mp.getByTestId("v3-ht-session").isVisible(), "담당 세션 패널이 보이지 않습니다");
    assert(await commentButtonClicks(mp) === 0, "고정 코멘트 단추가 탭 클릭을 가로챘습니다");
    await removeCommentButton(mp);
    pass("C1: 390 에서 고정 코멘트 단추를 세워 두어도 담당 세션 탭을 실제 좌표로 누를 수 있다");
    shots.push(await capture(mp, "390-session"));

    await mp.getByTestId("v3-ht-mobile-tab-triage").click();
    await mp.getByTestId("v3-ht-row-1408").click();
    await mp.getByTestId("v3-ht-evidence-ev1408-a").click();
    await waitDialog(mp);
    const mobileCenter = await dialogCenter(mp);
    assert(Math.abs(mobileCenter.dx) <= 2, `390 대화상자가 가로 가운데가 아닙니다: ${mobileCenter.dx}`);
    for (let index = 0; index < 6; index += 1) {
      await mp.keyboard.press("Tab");
      assert(await mp.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="dialog-popup"]'))), "390 대화상자에서 Tab 이 빠져나갔습니다");
    }
    await closeDialogByEscape(mp);
    await assertNoOverflow(mp, "390 dialog");
    shots.push(await capture(mp, "390-dark"));
    pass("C2/R5: 390 대화상자는 가운데에 서고 Tab 을 가두며 Esc 로 닫힌다");
    await phone.close();

    // G. 360 최소 폭: 코멘트 단추, 넘침, 긴 제목 줄임
    const narrow = await open(browser, base, 360, 800, "dark");
    const np = narrow.page;
    await assertNoOverflow(np, "360");
    await commentOverlap(np, "360");
    const titleBox = await np.getByTestId("v3-ht-row-1408").locator(".v3-ht-row-title").evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { right: rect.right, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
    });
    assert(titleBox.scrollWidth > titleBox.clientWidth, "360 에서 긴 제목이 말줄임되지 않았습니다");
    assert(titleBox.right <= 360, `360 에서 제목이 화면을 넘습니다: ${titleBox.right}`);
    shots.push(await capture(np, "360-dark"));
    pass("16: 360 에서 긴 제목이 말줄임되고 가로 넘침이 없다");
    await narrow.close();

    // H. 820 태블릿: 코멘트 단추, 하단 탭, 패널 전환
    const tablet = await open(browser, base, 820, 1180, "dark");
    const tp = tablet.page;
    await assertNoOverflow(tp, "820");
    await commentOverlap(tp, "820");
    assert(await tp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "820 에서 하단 탭이 보이지 않습니다");
    assert(!(await tp.locator('[data-slot-name="folders"]').isVisible()), "820 에서 폴더 패널이 숨겨지지 않았습니다");
    await tp.getByTestId("v3-ht-mobile-tab-session").click();
    assert(await tp.getByTestId("v3-ht-session").isVisible(), "820 담당 세션 탭이 패널을 보여 주지 않습니다");
    await tp.getByTestId("v3-ht-mobile-tab-folders").click();
    assert(await tp.locator(".v3-navigation").isVisible(), "820 폴더 탭이 정본 내비게이션을 보여 주지 않습니다");
    await tp.getByTestId("v3-ht-mobile-tab-triage").click();
    shots.push(await capture(tp, "820-dark"));
    pass("R5: 820 에서 하단 탭 세 개가 패널을 바꾼다");
    await tablet.close();

    // I. 라이트: 도구 막대 유리, 390 탭 대비, 넘침
    const light = await open(browser, base, 1440, 900, "light");
    const lp = light.page;
    const surface = await lp.evaluate(() => {
      const brand = document.querySelector<HTMLElement>(".dashboard-toolbar-brand");
      if (!brand) throw new Error("도구 막대 브랜드가 없습니다");
      const style = getComputedStyle(brand);
      return {
        token: style.getPropertyValue("--glass-chrome-surface-strong").trim(),
        background: style.backgroundColor,
        color: style.color,
      };
    });
    assert(!surface.token.includes("16%"), `라이트 도구 막대가 16% 틴트를 상속했습니다: ${surface.token}`);
    const alpha = surface.background.match(/\/\s*([0-9.]+)/)?.[1];
    assert(alpha === undefined || Number(alpha) >= 0.35, `라이트 도구 막대 표면이 너무 투명합니다: ${surface.background}`);
    assert(!surface.color.includes("255, 255, 255"), `라이트 도구 막대 글자가 흰색입니다: ${surface.color}`);
    await assertNoOverflow(lp, "1440 light");
    shots.push(await capture(lp, "1440-light"));
    pass(`C8: 라이트 도구 막대는 16% 틴트가 아닌 진한 유리 위에 어두운 글자를 쓴다 (${surface.token}, ${surface.background})`);
    await light.close();

    const lightPhone = await open(browser, base, 390, 844, "light");
    const lpp = lightPhone.page;
    const contrast = await lpp.evaluate(() => {
      const active = document.querySelector<HTMLElement>('[data-testid="v3-ht-mobile-tab-triage"]');
      const inactive = document.querySelector<HTMLElement>('[data-testid="v3-ht-mobile-tab-folders"]');
      if (!active || !inactive) throw new Error("모바일 탭이 없습니다");
      const activeStyle = getComputedStyle(active);
      const inactiveStyle = getComputedStyle(inactive);
      return {
        activeColor: activeStyle.color,
        inactiveColor: inactiveStyle.color,
        activeBackground: activeStyle.backgroundColor,
        activeShadow: activeStyle.boxShadow,
        inactiveShadow: inactiveStyle.boxShadow,
        activeSelected: active.getAttribute("aria-selected"),
        inactiveSelected: inactive.getAttribute("aria-selected"),
      };
    });
    const alphaOf = (color: string): number => {
      const slash = color.match(/\/\s*([0-9.]+)\s*\)/);
      if (slash) return Number(slash[1]);
      const rgba = color.match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/);
      if (rgba) return Number(rgba[1]);
      return 1;
    };
    assert(contrast.activeSelected === "true" && contrast.inactiveSelected === "false", "390 탭 선택 상태가 다릅니다");
    assert(contrast.activeColor !== contrast.inactiveColor, `활성 탭과 비활성 탭 글자가 같습니다: ${contrast.activeColor}`);
    assert(alphaOf(contrast.activeColor) === 1, `활성 탭 글자가 불투명 foreground 가 아닙니다: ${contrast.activeColor}`);
    assert(Math.abs(alphaOf(contrast.inactiveColor) - 0.72) <= 0.02, `비활성 탭 글자가 text-secondary(72%) 가 아닙니다: ${contrast.inactiveColor}`);
    assert(Math.abs(alphaOf(contrast.activeBackground) - 0.14) <= 0.02, `활성 탭 배경이 primary 14% 가 아닙니다: ${contrast.activeBackground}`);
    assert(contrast.activeShadow.includes("inset") && !contrast.inactiveShadow.includes("inset"), `활성 탭 위쪽 강조선이 없습니다: ${contrast.activeShadow}`);
    await assertNoOverflow(lpp, "390 light");
    await commentOverlap(lpp, "390 light");
    shots.push(await capture(lpp, "390-light"));
    pass("C8: 390 라이트 탭은 활성 foreground 와 primary 14% 알약, 위쪽 강조선, 비활성 text-secondary");
    await lightPhone.close();

    // J. 창 크기 바꾸기: 배치와 입력 글, 스크롤 유지
    const resize = await open(browser, base, 1440, 900, "dark");
    const rp = resize.page;
    await rp.getByTestId("v3-ht-row-1387").click();
    const composer = rp.locator(".v3-ht-session textarea");
    await composer.fill("이어서 확인 부탁드립니다");
    const scrollable = await rp.locator(".v3-ht-planner-scroll").evaluate(el => {
      el.scrollTop = 40;
      return { top: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    await rp.setViewportSize({ width: 820, height: 900 });
    await rp.waitForTimeout(250);
    assert(await rp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "820 으로 줄였을 때 하단 탭이 뜨지 않았습니다");
    await rp.setViewportSize({ width: 390, height: 844 });
    await rp.waitForTimeout(250);
    assert(await rp.getByTestId("v3-ht-mobile-tab-triage").isVisible(), "390 으로 줄였을 때 하단 탭이 뜨지 않았습니다");
    await rp.setViewportSize({ width: 1440, height: 900 });
    await rp.waitForTimeout(300);
    assert(await rp.locator(".v3-navigation").isVisible(), "넓혔을 때 폴더 패널이 돌아오지 않았습니다");
    assert(await rp.getByTestId("v3-ht-session").isVisible(), "넓혔을 때 담당 세션이 돌아오지 않았습니다");
    assert(await composer.inputValue() === "이어서 확인 부탁드립니다", "창을 바꾸는 동안 입력 중인 글이 사라졌습니다");
    const scrollNow = await rp.locator(".v3-ht-planner-scroll").evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    const expected = Math.min(scrollable.top, Math.max(0, scrollNow.max));
    assert(Math.abs(scrollNow.top - expected) <= 8, `스크롤 위치가 ${expected} 에서 ${scrollNow.top} 로 바뀌었습니다`);
    pass(`18: 창을 1440, 820, 390 으로 바꿔도 배치와 입력 글이 유지된다 (스크롤 ${scrollable.top} -> ${scrollNow.top}, 상한 ${scrollNow.max})`);
    await resize.close();

    const summary = {
      mockup: MOCKUP,
      captures: shots,
      commentButton: "112x64 at right 16px, bottom 16px, overlap 0 at 1440, 820, 390, 360 dark and 390 light",
      overflow: "0px at 1440 dark/light, 820, 390 dark/light, 360",
      mockupUnmocked: "API/IMAGE 0 (STREAM 제외)",
      checks: {
        C1: "pass",
        C2: "pass",
        C3: "pass",
        C4: "pass",
        C5: "pass",
        C6: "pass",
        C7: "pass",
        C8: "pass",
        C9: "pass",
        C10: "pass",
        C11: "pass",
        C12: "pass",
        C13: "pass",
        portraits: "pass",
        board: "7 columns, on_hold 18, review 3, done 12, total 45",
        workspace: "background #1690 opens CardWorkspace from grid and board",
        uiDesignGate: { "14": "pass", "15": "pass", "16": "pass", "17": "해당 없음: 견본 데이터만 쓰고 네트워크 요청이 없다", "18": "pass" },
      },
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
