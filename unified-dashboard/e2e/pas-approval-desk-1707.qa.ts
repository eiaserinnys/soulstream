import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

// 시안 A의 리포 시각 검수. dist-mockups의 정적 묶음을 띄우고 실제로 조작한다.
// 실행: npx tsx e2e/pas-approval-desk-1707.qa.ts
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(HERE, "..");
const DIST = path.join(DASHBOARD, "dist-mockups", "pas-approval-1707-desk");
const OUT = path.join(DASHBOARD, ".local", "artifacts", "pas-approval-1707-desk");
mkdirSync(OUT, { recursive: true });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let relative = decodeURIComponent(url.pathname);
    if (relative.endsWith("/")) relative += "index.html";
    const file = path.join(DIST, relative);
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
assert(address && typeof address === "object");
const BASE = `http://127.0.0.1:${address.port}`;

process.env.PLAYWRIGHT_MODULE ??=
  "/home/eias/.local/lib/python3.13/site-packages/playwright/driver/package/index.mjs";

type Page = any;
type Browser = any;
type Theme = "light" | "dark";

const logs: string[] = [];
const checks: Record<string, unknown> = {};
const captures: string[] = [];

async function makePage(browser: Browser, width: number, height: number, theme: Theme = "dark") {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => logs.push(`pageerror ${error.message}`));
  page.on("requestfailed", (request: any) =>
    logs.push(`requestfailed ${request.method()} ${new URL(request.url()).pathname}`));
  page.on("response", (response: any) => {
    if (response.status() >= 400) logs.push(`http ${response.status()} ${new URL(response.url()).pathname}`);
  });
  return { context, page };
}

async function open(page: Page, hash: string, theme: Theme = "dark") {
  await page.goto(`${BASE}/frame.html?theme=${theme}&glass=css#${hash}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".ad1707-screen", { state: "visible" });
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, name), animations: "disabled" });
  captures.push(name);
}

async function readLayout(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main.v3-components-main");
    const screen = document.querySelector<HTMLElement>(".ad1707-screen");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : null,
      screenOverflow: screen ? screen.scrollWidth - screen.clientWidth : null,
      dark: document.documentElement.classList.contains("dark"),
    };
  });
}

async function readOverlaps(page: Page) {
  return page.evaluate(() => {
    const selector = [
      ".ad1707-toolbar button",
      ".ad1707-filmstrip-item",
      ".ad1707-evidence",
      ".ad1707-link-card",
      ".ad1707-stamp-bar button",
      ".ad1707-home-actions button",
      ".ad1707-nav .v3-nav-list button",
      ".ad1707-briefing-capsule button",
      ".ad1707-manuscript-composer button",
    ].join(",");
    const elements = [...document.querySelectorAll<HTMLElement>(selector)].filter(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    // 스크롤 상자와 화면 밖으로 잘린 부분은 겹침으로 세지 않는다. 보이는 사각형만 비교한다.
    const visible: { element: HTMLElement; rect: { left: number; top: number; right: number; bottom: number } }[] = [];
    for (const element of elements) {
      const base = element.getBoundingClientRect();
      let left = base.left;
      let top = base.top;
      let right = base.right;
      let bottom = base.bottom;
      let ancestor = element.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          const box = ancestor.getBoundingClientRect();
          left = Math.max(left, box.left);
          top = Math.max(top, box.top);
          right = Math.min(right, box.right);
          bottom = Math.min(bottom, box.bottom);
        }
        ancestor = ancestor.parentElement;
      }
      left = Math.max(left, 0);
      top = Math.max(top, 0);
      right = Math.min(right, window.innerWidth);
      bottom = Math.min(bottom, window.innerHeight);
      if (right - left > 1 && bottom - top > 1) visible.push({ element, rect: { left, top, right, bottom } });
    }
    const overlaps: string[] = [];
    for (let left = 0; left < visible.length; left += 1) {
      for (let right = left + 1; right < visible.length; right += 1) {
        const a = visible[left]!;
        const b = visible[right]!;
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1) {
          const aText = (a.element.textContent ?? "").trim().slice(0, 18);
          const bText = (b.element.textContent ?? "").trim().slice(0, 18);
          const aClass = String(a.element.className).split(/\s+/).slice(0, 2).join(".");
          const bClass = String(b.element.className).split(/\s+/).slice(0, 2).join(".");
          overlaps.push(`${a.element.tagName.toLowerCase()}.${aClass}[${aText}] <> ${b.element.tagName.toLowerCase()}.${bClass}[${bText}] ${Math.round(width)}x${Math.round(height)}`);
        }
      }
    }
    return overlaps;
  });
}

async function readClipped(page: Page) {
  return page.evaluate(() => {
    const selectors = [
      ".ad1707-doc-title",
      ".ad1707-request p",
      ".ad1707-check-result",
      ".ad1707-home-head h1",
      ".ad1707-manuscript-message p",
      ".ad1707-briefing-capsule > span",
      ".ad1707-dialog-head h2",
    ];
    const clipped: { selector: string; text: string; overflow: number }[] = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || element.getBoundingClientRect().width === 0) continue;
        const overflow = element.scrollWidth - element.clientWidth;
        if (overflow > 1 && style.textOverflow !== "ellipsis") {
          clipped.push({ selector, text: (element.textContent ?? "").trim().slice(0, 30), overflow });
        }
      }
    }
    return clipped;
  });
}

async function assertClean(page: Page, label: string) {
  const layout = await readLayout(page);
  const overlaps = await readOverlaps(page);
  const clipped = await readClipped(page);
  assert(layout.documentOverflow <= 0, `${label}: document 가로 넘침 ${layout.documentOverflow}`);
  assert(layout.bodyOverflow <= 0, `${label}: body 가로 넘침 ${layout.bodyOverflow}`);
  assert(layout.mainOverflow === null || layout.mainOverflow <= 0, `${label}: main 가로 넘침 ${layout.mainOverflow}`);
  assert(layout.screenOverflow === null || layout.screenOverflow <= 0, `${label}: screen 가로 넘침 ${layout.screenOverflow}`);
  assert.deepEqual(overlaps, [], `${label}: 요소 겹침 ${overlaps.join(", ")}`);
  assert.deepEqual(clipped, [], `${label}: 글 잘림 ${JSON.stringify(clipped)}`);
  return { layout, overlaps, clipped };
}

async function assertNoUnmocked(page: Page, label: string) {
  const unmocked = await page.evaluate(() => (window as unknown as { __mockupUnmocked?: string[] }).__mockupUnmocked ?? []);
  const relevant = unmocked.filter((entry: string) => !entry.startsWith("STREAM "));
  assert.deepEqual(relevant, [], `${label}: 응답 없는 호출 ${relevant.join(", ")}`);
  return { all: unmocked, relevant };
}

async function active(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return {
      tag: element?.tagName ?? null,
      className: element?.className ?? null,
      label: element?.getAttribute("aria-label"),
      text: (element?.textContent ?? "").trim().slice(0, 40),
    };
  });
}

async function gridColumnCount(page: Page, selector: string) {
  return page.locator(selector).evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
}

await runPlaywrightLifecycle({
  lockName: "pas-approval-desk-1707",
  timeoutMs: 300_000,
  launchOptions: { headless: true },
}, async ({ browser }: { browser: Browser }) => {
  // 1. 넓은 화면, 두 테마, 두 서류.
  const main = await makePage(browser, 1440, 900, "dark");
  const page = main.page;
  await open(page, "desk", "dark");
  checks.unmockedDesk = await assertNoUnmocked(page, "desk 1440 dark");
  checks.layoutDesk1440 = await assertClean(page, "desk 1440 dark");
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  await shot(page, "desk-1440-dark-1680.png");

  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /턴 안 상호작용/);
  await shot(page, "desk-1440-dark-1387.png");

  const light = await makePage(browser, 1440, 900, "light");
  await open(light.page, "desk", "light");
  assert.equal((await readLayout(light.page)).dark, false, "light 테마에 dark 클래스가 붙었다");
  await shot(light.page, "desk-1440-light-1680.png");
  await light.page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await light.page.waitForTimeout(200);
  await shot(light.page, "desk-1440-light-1387.png");
  checks.layoutDesk1440Light = await assertClean(light.page, "desk 1440 light");

  // 2. PAS 한 줄 브리핑과 원고지 대화.
  await page.locator(".ad1707-nav-button", { hasText: "PAS 서소영" }).click();
  await page.waitForSelector(".ad1707-screen[data-screen='pas']", { state: "visible" });
  await page.waitForTimeout(400);
  assert.match(await page.locator(".ad1707-briefing-capsule").innerText(), /결재 서류 5건 대기 중/);
  assert.equal(await page.locator(".ad1707-pas-character iframe, .ad1707-pas-character img").count(), 1);
  await page.locator("#ad1707-pas-draft").fill("입력 중인 글");
  checks.layoutPas1440 = await assertClean(page, "pas 1440 dark");
  await shot(page, "pas-1440-dark.png");

  // 3. 다시 보기 팝오버: 첫 항목 초점, Esc 닫기, 초점 복귀, 실제 미루기와 되돌리기.
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForSelector(".ad1707-screen[data-screen='desk']", { state: "visible" });
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "다시 보기" }).click();
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("menu", { name: "다시 보기 시각" }).isVisible(), true);
  const snoozeFocus = await active(page);
  assert.equal(snoozeFocus.label, null);
  assert.match(snoozeFocus.text, /내일 오전 9시/);
  await shot(page, "snooze-popover-1440-dark.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("menu", { name: "다시 보기 시각" }).count(), 0);
  assert.match((await active(page)).text, /다시 보기/);

  await page.getByRole("button", { name: "다시 보기" }).click();
  await page.getByRole("menuitem", { name: "내일 오전 9시" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-undo").innerText(), /다시 보기로 미뤘습니다/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /슬라이드 편집 화면/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  assert.match(await page.locator(".ad1707-nav-badge").innerText(), /4/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /턴 안 상호작용/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  assert.equal(await page.locator(".ad1707-undo").count(), 0);
  checks.snooze = "팝오버 Esc와 초점 복귀, 미루기와 되돌리기 통과";

  // 4. 증거 확대 창: 첫 동작 초점, Esc 닫기, 연 자리로 초점 복귀, Tab 가둠.
  const evidenceTrigger = page.locator(".ad1707-evidence").first();
  await evidenceTrigger.click();
  await page.waitForTimeout(250);
  const evidenceDialog = page.locator("dialog.ad1707-evidence-dialog");
  assert.equal(await evidenceDialog.evaluate((element: HTMLDialogElement) => element.open), true);
  const evidenceFocus = await active(page);
  assert.match(String(evidenceFocus.label), /증거 닫기/);
  const tabStops: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    await page.keyboard.press("Tab");
    tabStops.push(String((await active(page)).label ?? (await active(page)).text));
    const tabState = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        insideDialog: !!element?.closest("dialog[open]"),
        tag: element?.tagName ?? null,
        backgroundControl: !!element?.closest(".ad1707-screen") && !element?.closest("dialog[open]"),
      };
    });
    assert.equal(tabState.backgroundControl, false, "증거 창에서 Tab이 배경 조작 요소로 나갔다");
  }
  await shot(page, "evidence-dialog-1440-dark.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await evidenceDialog.evaluate((element: HTMLDialogElement) => element.open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ad1707-evidence")), true);
  checks.evidenceDialog = { focus: evidenceFocus, tabStops, returned: true };

  // 5. 카드와 세션 두 열 창.
  await page.getByRole("button", { name: "전체 카드와 세션 열기" }).click();
  await page.waitForTimeout(250);
  const cardDialog = page.locator("dialog.ad1707-card-dialog");
  assert.equal(await cardDialog.evaluate((element: HTMLDialogElement) => element.open), true);
  assert.equal(await gridColumnCount(page, ".ad1707-card-dialog-grid"), 2);
  await shot(page, "overlay-1440-dark.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await cardDialog.evaluate((element: HTMLDialogElement) => element.open), false);
  assert.equal(await page.evaluate(() =>
    document.activeElement?.textContent?.includes("전체 카드와 세션 열기") ?? false), true);
  checks.cardOverlay = "두 열, Esc 닫기, 연 단추로 초점 복귀 통과";

  // 6. 네 가지 처분: 선택지 답, 다르게 답하기, 했어, 지적과 보완 지시.
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForTimeout(200);
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1680" }).click();
  await page.getByRole("button", { name: /최근 7일/ }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-undo").innerText(), /승인 완료로 넘겼습니다: 최근 7일/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /kaleidoscope 앱스토어/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);

  await page.getByRole("button", { name: "다르게 답하기" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-undo").innerText(), /보완 지시로 넘겼습니다: 다르게 답하기/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);

  await page.locator(".ad1707-filmstrip-item", { hasText: "#1512" }).click();
  await page.getByRole("button", { name: "했어" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-undo").innerText(), /승인 완료로 넘겼습니다/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /턴 안 상호작용/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);

  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(150);
  await page.locator(".ad1707-check").first().getByRole("button", { name: "지적" }).click();
  await page.locator(".ad1707-inline-fix textarea").fill("경로 조사에 실행 큐 잠금 지점을 더 적어 주세요.");
  await page.getByRole("button", { name: "보완 지시 보내기" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-undo").innerText(), /경로 조사에 실행 큐 잠금 지점을 더 적어 주세요/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);

  await page.getByRole("button", { name: "보완 지시" }).click();
  await page.waitForTimeout(200);
  await page.locator(".ad1707-nav-button", { hasText: "홈 플래너" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("[data-card-group='running'] .ad1707-card-seat").count(), 4);
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  checks.dispositions = "선택지 답, 다르게 답하기, 했어, 지적 보완 지시, 보완 지시와 홈 진행 중 반영, 되돌리기 통과";

  // 7. 참고 갈무리: 되돌리기, 다시 갈무리, 홈 참고 서재, 보드 보류 18 유지.
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "참고 갈무리" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-undo").innerText(), /참고 서재로 갈무리했습니다/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /슬라이드 편집 화면/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /턴 안 상호작용/);
  await page.getByRole("button", { name: "참고 갈무리" }).click();
  await page.waitForTimeout(250);

  await page.locator(".ad1707-nav-button", { hasText: "홈 플래너" }).click();
  await page.waitForSelector(".ad1707-screen[data-screen='home']", { state: "visible" });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("[data-card-group='attention']").count(), 1);
  assert.equal(await page.locator("[data-card-group='running']").count(), 1);
  assert.equal(await page.locator("[data-card-group='queued']").count(), 1);
  await shot(page, "home-1440-dark.png");

  await page.getByRole("button", { name: /참고 서재/ }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".ad1707-reference").count(), 1);
  assert.match(await page.locator(".ad1707-reference").innerText(), /#1387/);
  await shot(page, "home-reference-1440-dark.png");

  await page.getByRole("button", { name: "보드 보기" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("[data-board-column='on_hold'] .v3-detail-section-head span").innerText(), "18개");
  assert.equal(await page.locator("[data-board-column='done'] .v3-detail-section-head span").innerText(), "13개");
  assert.equal(await page.locator("[data-board-column='review'] .v3-detail-section-head span").innerText(), "4개");
  await shot(page, "board-1440-dark.png");
  await page.locator(".ad1707-board").evaluate((element: HTMLElement) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(200);
  await shot(page, "board-hold-1440-dark.png");
  checks.reference = "참고 서재에 #1387 표시, 보드 보류 18개 유지, 완료 13개, 검수 대기 4개";

  // 8. 좁은 폭 세 가지, 세 화면.
  for (const [width, height] of [[820, 1080], [390, 844], [360, 800]] as const) {
    const narrow = await makePage(browser, width, height, "dark");
    await open(narrow.page, "desk", "dark");
    checks[`layoutDesk${width}`] = await assertClean(narrow.page, `desk ${width}`);
    await shot(narrow.page, `desk-${width}.png`);

    await open(narrow.page, "home", "dark");
    checks[`layoutHome${width}`] = await assertClean(narrow.page, `home ${width}`);
    await shot(narrow.page, `home-${width}.png`);

    await open(narrow.page, "pas", "dark");
    checks[`layoutPas${width}`] = await assertClean(narrow.page, `pas ${width}`);
    await shot(narrow.page, `pas-${width}.png`);

    if (width <= 390) {
      await open(narrow.page, "desk", "dark");
      await narrow.page.locator(".ad1707-evidence").first().click();
      await narrow.page.waitForTimeout(200);
      const dialogRect = await narrow.page.locator("dialog.ad1707-evidence-dialog").evaluate((element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      assert(dialogRect.left >= 0 && dialogRect.right <= width, `${width}: 증거 창이 화면을 넘었다`);
      await shot(narrow.page, `evidence-dialog-${width}.png`);
      await narrow.page.keyboard.press("Escape");
      await narrow.page.waitForTimeout(150);
      await assertClean(narrow.page, `desk ${width} after dialog`);
    }
    await narrow.context.close();
  }

  // 9. 360px에서 가장 긴 제목.
  const narrowLong = await makePage(browser, 360, 800, "dark");
  await open(narrowLong.page, "desk", "dark");
  await narrowLong.page.locator(".ad1707-filmstrip-item", { hasText: "#1512" }).click();
  await narrowLong.page.waitForTimeout(200);
  assert.match(await narrowLong.page.locator(".ad1707-doc-title").innerText(), /kaleidoscope 앱스토어/);
  checks.layoutDesk360LongTitle = await assertClean(narrowLong.page, "desk 360 long title");
  await shot(narrowLong.page, "desk-360-long-title.png");

  // 10. 창 크기 바꾸기: 입력 글 유지, 두 열과 한 열 복귀, 팝오버 자리.
  const resized = await makePage(browser, 1440, 900, "dark");
  await open(resized.page, "pas", "dark");
  await resized.page.locator("#ad1707-pas-draft").fill("입력 중인 글");
  assert.equal(await gridColumnCount(resized.page, ".ad1707-pas-stage"), 2);
  await resized.page.setViewportSize({ width: 390, height: 844 });
  await resized.page.waitForTimeout(300);
  assert.equal(await gridColumnCount(resized.page, ".ad1707-pas-stage"), 1);
  assert.equal(await resized.page.locator("#ad1707-pas-draft").inputValue(), "입력 중인 글");
  checks.layoutPasResized390 = await assertClean(resized.page, "pas resize 390");
  await resized.page.setViewportSize({ width: 1440, height: 900 });
  await resized.page.waitForTimeout(300);
  assert.equal(await gridColumnCount(resized.page, ".ad1707-pas-stage"), 2);
  assert.equal(await resized.page.locator("#ad1707-pas-draft").inputValue(), "입력 중인 글");
  checks.layoutPasResized1440 = await assertClean(resized.page, "pas resize 1440");

  await resized.page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await resized.page.waitForTimeout(200);
  await resized.page.getByRole("button", { name: "다시 보기" }).click();
  await resized.page.waitForTimeout(150);
  await resized.page.setViewportSize({ width: 390, height: 844 });
  await resized.page.waitForTimeout(300);
  const menuRect = await resized.page.getByRole("menu", { name: "다시 보기 시각" }).evaluate((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
  assert(menuRect.left >= 0 && menuRect.right <= 390, "다시 보기 팝오버가 좁은 화면을 넘었다");
  assert(menuRect.top >= 0 && menuRect.bottom <= 844, "다시 보기 팝오버가 세로로 화면을 넘었다");
  await resized.page.keyboard.press("Escape");
  checks.resize = { menuRect, input: "입력 중인 글", columns: "2 -> 1 -> 2" };

  // 11. 호스트 자체: 테마와 폭 전환, 360px 가로 넘침 없음.
  const host = await makePage(browser, 360, 800, "dark");
  await host.page.goto(`${BASE}/index.html?theme=dark&w=fit&glass=css`, { waitUntil: "networkidle" });
  await host.page.waitForSelector(".mockup-host-frame");
  await host.page.waitForTimeout(300);
  const hostLayout = await host.page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    buttons: [...document.querySelectorAll<HTMLElement>(".mockup-host-header button")].map(button => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
    frameWidth: document.querySelector<HTMLIFrameElement>(".mockup-host-frame")?.getBoundingClientRect().width ?? 0,
  }));
  assert(hostLayout.overflow <= 0, "호스트 360px 가로 넘침");
  assert(hostLayout.buttons.every(rect => rect.left >= 0 && rect.right <= 360), "호스트 단추가 화면을 넘었다");
  assert(hostLayout.frameWidth > 0 && hostLayout.frameWidth <= 360, "호스트 프레임 폭이 360을 넘었다");
  await host.page.getByRole("group", { name: "테마" }).getByRole("button", { name: "밝게" }).click();
  await host.page.getByRole("group", { name: "화면 폭" }).getByRole("button", { name: "휴대폰" }).click();
  await host.page.waitForTimeout(400);
  const hostFrame = host.page.frameLocator(".mockup-host-frame");
  assert.equal(await hostFrame.locator(".ad1707-screen").count(), 1);
  const hostInner = await hostFrame.locator(".ad1707-screen").evaluate((element: HTMLElement) => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    screenOverflow: element.scrollWidth - element.clientWidth,
  }));
  assert(hostInner.overflow <= 0 && hostInner.screenOverflow <= 0, "호스트 프레임 안 가로 넘침");
  await shot(host.page, "host-360-phone-light.png");
  checks.host = { ...hostLayout, inner: hostInner };

  // 12. 15번: 닫힌 창 안으로 Tab이 들어가지 않는다.
  await open(page, "desk", "dark");
  const focusOrder: string[] = [];
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press("Tab");
    const info = await active(page);
    focusOrder.push(String(info.label ?? info.text));
    const hidden = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return true;
      if (element.closest("dialog:not([open])")) return true;
      const style = getComputedStyle(element);
      return style.display === "none" || style.visibility === "hidden";
    });
    assert.equal(hidden, false, `Tab ${step}이 보이지 않는 요소에 닿았다`);
  }
  checks.tabOrder = focusOrder;

  // 13. OG 미리보기: 1200x630 홈 플래너.
  const og = await makePage(browser, 1200, 630, "dark");
  await open(og.page, "home", "dark");
  await og.page.waitForTimeout(400);
  await og.page.screenshot({
    path: path.join(DASHBOARD, "mockups", "pas-approval-1707-desk", "og.png"),
    animations: "disabled",
  });
  await og.context.close();
  checks.og = "1200x630";

  checks.errorState = {
    status: "해당 없음",
    reason: "정적 시안이라 데이터 요청과 실패 경로가 없다. 모든 값은 픽스처다.",
  };
  checks.logs = [...new Set(logs)];
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ checks, captures }, null, 2));

  await main.context.close();
  await light.context.close();
  await narrowLong.context.close();
  await resized.context.close();
  await host.context.close();
});

server.close();
console.log(JSON.stringify({ out: OUT, captures, checks }, null, 2));
