#!/usr/bin/env node
/**
 * 시안 B, PAS 카드 전 요소 3열 조감판 검수.
 *
 * 빌드된 정적 묶음(dist-mockups/pas-report-1707-overview)을 그 자리에서 서빙하고
 * 실제 Chromium으로 R1~R5를 조작해 확인한다. 1440에서 3열 상단 정렬과 처분 전후
 * 제목과 주 단추의 Y 좌표 고정, 820의 2열, 390과 360의 한 열과 구역 바로가기,
 * 그리고 발행 페이지의 오른쪽 아래 댓글 단추 자리와의 겹침을 잰다.
 *
 * 실행:
 *   MOCKUP=pas-report-1707-overview pnpm --dir unified-dashboard exec vite build --config vite.mockup.config.ts
 *   node e2e/pas-report-1707-overview.qa.mjs
 *
 * 캡처는 기본으로 /home/eias/workspace/.local/artifacts/pas-report-1707-overview 에 쓴다.
 * PAS_OVERVIEW_OUTPUT 으로 바꿀 수 있다.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = resolve(here, "..");
const distDir = resolve(dashboardDir, "dist-mockups", "pas-report-1707-overview");
const output = process.env.PAS_OVERVIEW_OUTPUT
  ?? "/home/eias/workspace/.local/artifacts/pas-report-1707-overview";
if (!existsSync(join(distDir, "frame.html"))) {
  throw new Error(`묶음이 없습니다: ${distDir}\nMOCKUP=pas-report-1707-overview vite build --config vite.mockup.config.ts 를 먼저 실행하세요.`);
}
mkdirSync(output, { recursive: true });

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
]);

const require = createRequire(import.meta.url);
const playwrightPackage = require.resolve("@playwright/test/package.json");
const requireFromTest = createRequire(playwrightPackage);
const { chromium } = requireFromTest("playwright");
const executablePath = chromiumExecutablePath();

function chromiumExecutablePath() {
  const chrome = chromium.executablePath();
  const headless = chrome.replace(
    /chromium-(\d+)[/\\]chrome-linux(?:64)?[/\\]chrome$/,
    "chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell",
  );
  return headless !== chrome && existsSync(headless) ? headless : chrome;
}

function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      const file = normalize(join(distDir, pathname === "/" ? "index.html" : pathname));
      if (file !== distDir && !file.startsWith(distDir + "/")) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": MIME.get(extname(file).toLowerCase()) ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise(resolveClose => server.close(() => resolveClose()));
}

const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
const results = [];
const captures = [];
const unmockedReports = {};
const geometryNotes = {};

async function step(id, callback) {
  const started = Date.now();
  try {
    const detail = await callback();
    results.push({ id, pass: true, detail: detail ?? null, ms: Date.now() - started });
    console.log(`PASS  ${id}  ${Date.now() - started}ms${detail ? `  ${detail}` : ""}`);
  } catch (error) {
    results.push({ id, pass: false, error: error.message, ms: Date.now() - started });
    console.log(`FAIL  ${id}  ${Date.now() - started}ms  ${error.message}`);
  }
}

async function openMain(page, { width, height, theme, query = "", hash = "#pas", glass = "css" }) {
  await page.setViewportSize({ width, height });
  const suffix = glass === "css" ? "&glass=css" : "";
  await page.goto(`${base}/frame.html?theme=${theme}${suffix}${query}${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-report-overview-screen"]', { state: "visible" });
  await page.waitForSelector('[data-testid="chat-view"]', { state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await pause(350);
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  assert.equal(dark, theme === "dark", `테마 클래스가 ${theme}와 다릅니다`);
}

async function openSheet(page) {
  if (await page.locator('[data-testid="overview-sheet"]').count() === 0) {
    await page.getByRole("button", { name: "보고 창 열기", exact: true }).click({ force: true });
  }
  await page.waitForSelector('[data-testid="overview-sheet"]', { state: "visible" });
  await page.waitForSelector('[data-testid="overview-col-1"]', { state: "visible" });
  await pause(120);
}

async function closeSheet(page) {
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="overview-sheet"]').waitFor({ state: "hidden" });
  await pause(120);
}

async function capture(page, name) {
  const path = join(output, name);
  await page.screenshot({ path, animations: "disabled" });
  captures.push(path);
}

async function sheetTitle(page) {
  return (await page.locator('[data-testid="overview-title"]').innerText()).replace(/\s+/g, " ").trim();
}

async function titleRowText(page) {
  return (await page.locator(".pas-ro1707-sheet-title-row").innerText()).replace(/\s+/g, " ").trim();
}

async function bubbleCount(page) {
  const node = page.locator('[data-testid="report-bubble-count"]');
  return await node.count() === 0 ? null : (await node.innerText()).replace(/\s+/g, " ").trim();
}

async function openChip(page, number) {
  await page.locator(".pas-ro1707-chip", { hasText: `#${number}` }).click({ force: true });
  await page.waitForFunction(value => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes(`#${value}`), number);
  await pause(80);
}

async function active(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    return {
      tag: element.tagName,
      label: element.getAttribute("aria-label"),
      testid: element.getAttribute("data-testid"),
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      className: typeof element.className === "string" ? element.className : "",
    };
  });
}

async function topOf(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector}가 없습니다`);
  return Math.round(box.y * 10) / 10;
}

async function installPublishRegion(page) {
  await page.evaluate(() => {
    document.getElementById("pas-overview-publish")?.remove();
    const host = document.createElement("div");
    host.id = "pas-overview-publish";
    host.style.cssText = "position:fixed;right:0;bottom:0;width:120px;height:72px;z-index:2147483647;pointer-events:none;";
    const marker = document.createElement("div");
    marker.style.cssText = "position:absolute;inset:0;background:#000;opacity:0.002;pointer-events:auto;";
    host.append(marker);
    document.body.append(host);
  });
  await pause(40);
}

async function publishRegionHits(page) {
  return page.evaluate(() => {
    const host = document.getElementById("pas-overview-publish");
    if (!host) return { error: "no-region", hits: [] };
    const rect = host.getBoundingClientRect();
    const selector = "button, a, input, textarea, [role=button], [role=tab], select";
    const candidates = [];
    for (const element of document.querySelectorAll(selector)) {
      if (host.contains(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const x = Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
      const y = Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top);
      if (x <= 0 || y <= 0) continue;
      candidates.push({
        element,
        left: Math.max(box.left, rect.left),
        right: Math.min(box.right, rect.right),
        top: Math.max(box.top, rect.top),
        bottom: Math.min(box.bottom, rect.bottom),
      });
    }
    host.style.visibility = "hidden";
    const hits = [];
    for (const candidate of candidates) {
      const points = [
        [(candidate.left + candidate.right) / 2, (candidate.top + candidate.bottom) / 2],
        [candidate.left + 1, candidate.top + 1],
        [candidate.right - 1, candidate.top + 1],
        [candidate.left + 1, candidate.bottom - 1],
        [candidate.right - 1, candidate.bottom - 1],
      ];
      const visible = points.some(([x, y]) => document.elementsFromPoint(x, y)
        .some(element => element === candidate.element || candidate.element.contains(element)));
      if (!visible) continue;
      const box = candidate.element.getBoundingClientRect();
      hits.push({
        tag: candidate.element.tagName,
        label: (candidate.element.getAttribute("aria-label") || candidate.element.textContent || "").trim().slice(0, 40),
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      });
    }
    host.style.visibility = "";
    return { region: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)], hits };
  });
}

async function assertNoPublishHit(page, label) {
  await installPublishRegion(page);
  const report = await publishRegionHits(page);
  assert.ok(!report.error, `${label} 발행 단추 자리 확인 실패`);
  assert.deepEqual(report.hits, [], `${label} 발행 단추 자리 겹침: ${JSON.stringify(report.hits)}`);
  return `${label} 겹침 없음`;
}

async function overflowReport(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const screen = document.querySelector('[data-testid="pas-report-overview-screen"]');
    const panel = document.querySelector(".pas-ro1707-sheet-panel");
    const clippedByScroller = element => {
      let node = element.parentElement;
      while (node && node !== body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
        node = node.parentElement;
      }
      return false;
    };
    const offenders = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (element.closest(".wallpaper-layer")) continue;
      if (rect.right <= window.innerWidth + 1 && rect.left >= -1) continue;
      if (clippedByScroller(element)) continue;
      offenders.push({
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className.slice(0, 80) : "",
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
      if (offenders.length >= 8) break;
    }
    return {
      viewport: window.innerWidth,
      documentScroll: root.scrollWidth,
      documentClient: root.clientWidth,
      bodyScroll: body.scrollWidth,
      bodyClient: body.clientWidth,
      screenScroll: screen?.scrollWidth ?? 0,
      screenClient: screen?.clientWidth ?? 0,
      panelScroll: panel?.scrollWidth ?? 0,
      panelClient: panel?.clientWidth ?? 0,
      offenders,
    };
  });
}

async function assertNoOverflow(page, label) {
  const report = await overflowReport(page);
  assert.ok(
    report.documentScroll <= report.documentClient + 1
      && report.bodyScroll <= report.bodyClient + 1
      && report.screenScroll <= report.screenClient + 1
      && (!report.panelClient || report.panelScroll <= report.panelClient + 1)
      && report.offenders.length === 0,
    `${label} 가로 넘침: ${JSON.stringify(report)}`,
  );
  return `${label} 넘침 없음 (${report.viewport}px)`;
}

async function unmocked(page) {
  return page.evaluate(() => (window.__mockupUnmocked ?? []).filter(item => !item.startsWith("STREAM ")));
}

async function imageReport(page) {
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  return page.evaluate(() => {
    const broken = [...document.images]
      .filter(image => image.complete && image.naturalWidth === 0)
      .map(image => image.getAttribute("src"));
    const sources = [...new Set([...document.images]
      .map(image => image.getAttribute("src"))
      .filter(Boolean))];
    return { broken, sources, count: document.images.length };
  });
}

async function openTaskDrawer(page) {
  await page.getByRole("button", { name: "작업 목록", exact: true }).click({ force: true });
  await page.waitForSelector(".persistent-session-tasks", { state: "visible" });
  await pause(80);
}

async function closeTaskDrawer(page) {
  await page.getByRole("button", { name: "작업 목록 닫기" }).click({ force: true });
  await page.locator(".persistent-session-tasks").waitFor({ state: "hidden" });
  await pause(80);
}

async function drawerText(page) {
  return (await page.locator(".persistent-session-tasks").innerText()).replace(/\s+/g, " ").trim();
}

function scanForbidden(text, label) {
  const hits = [];
  const rules = [
    ["가운뎃점", /·/],
    ["엠 대시", /—/],
    ["수평선 대시", /―/],
    ["세 하이픈 수평선", /(^|\n)---(\n|$)/],
    ["박다 계열", /박(다|았|아|은|을|는|혀|히|자|고|지|게|음|기|인|여|였)/],
  ];
  for (const [name, pattern] of rules) {
    if (pattern.test(text)) hits.push(`${label}: ${name}`);
  }
  return hits;
}

const { server, base } = await startStaticServer();
console.log(`묶음 ${distDir}`);
console.log(`서빙 ${base}`);
console.log(`캡처 ${output}`);

try {
  await runPlaywrightLifecycle({
    lockName: "pas-report-1707-overview",
    timeoutMs: 585_000,
    launchBrowser: (options) => chromium.launch({ ...options, executablePath }),
  }, async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await step("R1 PAS 기본 화면과 보고 말풍선", async () => {
      await openMain(page, { width: 1440, height: 900, theme: "dark" });
      assert.equal(new URL(page.url()).hash, "#pas", "첫 진입 해시가 #pas가 아닙니다");
      assert.equal(await page.locator('[data-testid="overview-sheet"]').count(), 0, "첫 진입에 조감 시트가 열렸습니다");
      const bubble = page.locator('[data-testid="report-bubble"]');
      await bubble.waitFor({ state: "visible" });
      const text = (await bubble.innerText()).replace(/\s+/g, " ").trim();
      assert.ok(text.includes("#1680"), "말풍선에 카드 번호가 없습니다");
      assert.ok(text.includes("답변 대기"), "말풍선에 상태 칩이 없습니다");
      assert.ok(text.includes("완료 목록 기간 칩의 기본 범위"), "말풍선에 제목이 없습니다");
      assert.ok(text.includes("어떤 범위를 기본으로"), "말풍선에 핵심 요청이 없습니다");
      assert.equal(await bubbleCount(page), "1 / 5", "말풍선 장 표시가 1 / 5가 아닙니다");
      assert.equal(await page.getByRole("button", { name: "보고 창 열기", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "보고 창 크게 열기", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "작업 목록", exact: true }).count(), 1);
      const screenText = (await page.locator('[data-testid="pas-report-overview-screen"]').innerText()).replace(/\s+/g, " ");
      assert.ok(!screenText.includes("세션 중단"), "메인 화면에 세션 중단이 있습니다");
      const composer = await page.locator('[data-testid="chat-input"]').boundingBox();
      assert.ok(composer, "메인 입력창이 없습니다");
      assert.ok(900 - (composer.y + composer.height) >= 24, `메인 입력창 아래 여백이 부족합니다: ${JSON.stringify(composer)}`);
      await capture(page, "01-1440-dark-pas-bubble.png");
      return `말풍선 #1680, 상태 칩, 1 / 5, 열기와 크게 열기 단추, 메인 입력창 아래 ${Math.round(900 - (composer.y + composer.height))}px`;
    });

    await step("R2 보고 창 열기, 해시, 탭 없음, 3열 상단 정렬", async () => {
      await openSheet(page);
      const openedFocus = await active(page);
      assert.equal(openedFocus?.className.includes("pas-ro1707-sheet-panel"), true,
        `시트를 연 뒤 초점이 패널이 아닙니다: ${JSON.stringify(openedFocus)}`);
      const tabWrap = await page.evaluate(() => {
        const panel = document.querySelector(".pas-ro1707-sheet-panel");
        const focusables = Array.from(panel.querySelectorAll(
          "button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        )).filter(element => element.offsetParent !== null || element === document.activeElement);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        last.focus();
        return {
          first: first.getAttribute("aria-label") ?? first.textContent.replace(/\s+/g, " ").trim().slice(0, 30),
          last: last.getAttribute("aria-label") ?? last.textContent.replace(/\s+/g, " ").trim().slice(0, 30),
        };
      });
      await page.keyboard.press("Tab");
      const wrappedFocus = await active(page);
      assert.equal(wrappedFocus?.label ?? wrappedFocus?.text, tabWrap.first,
        `Tab이 첫 요소로 돌아오지 않았습니다: ${JSON.stringify(tabWrap)} -> ${JSON.stringify(wrappedFocus)}`);
      geometryNotes.tabWrap = tabWrap;
      assert.equal(new URL(page.url()).hash, "#report", "시트를 연 뒤 해시가 #report가 아닙니다");
      assert.equal(await page.locator('[data-testid="overview-sheet"] [role="tab"]').count(), 0, "조감 시트에 탭이 있습니다");
      assert.equal(await page.locator('[data-testid="overview-col-1"]').count(), 1);
      assert.equal(await page.locator('[data-testid="overview-col-2"]').count(), 1);
      assert.equal(await page.locator('[data-testid="overview-col-3"]').count(), 1);
      const tracks = await page.locator(".pas-ro1707-cols").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length);
      assert.equal(tracks, 3, `1440에서 3열이 아닙니다: ${tracks}`);
      const tops = await page.evaluate(() => ["1", "2", "3"].map(number => {
        const element = document.querySelector(`[data-testid="overview-col-${number}"]`);
        return Math.round(element.getBoundingClientRect().top * 10) / 10;
      }));
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `3열 상단이 어긋납니다: ${JSON.stringify(tops)}`);
      geometryNotes.columnTops1440 = tops;
      const col1 = (await page.locator('[data-testid="overview-col-1"]').innerText()).replace(/\s+/g, " ");
      const col2 = (await page.locator('[data-testid="overview-col-2"]').innerText()).replace(/\s+/g, " ");
      const col3 = (await page.locator('[data-testid="overview-col-3"]').innerText()).replace(/\s+/g, " ");
      assert.ok(col1.includes("원 요청") && col1.includes("확인 항목") && col1.includes("대표 시각 증거"));
      assert.ok(col1.includes("최근 7일") && col1.includes("최근 14일") && col1.includes("전체 기간") && col1.includes("권함"));
      assert.equal(await page.locator('[data-testid="overview-comment"]').count(), 2, "1680 커멘트가 2건이 아닙니다");
      assert.equal(await page.locator('[data-testid="overview-turn"]').count(), 3, "1680 세션 대화가 3턴이 아닙니다");
      assert.ok(col3.includes("완료 목록 기간 집계 세션"), "담당 세션 이름이 없습니다");
      assert.ok(col3.includes("담당 세션에 지시"), "담당 세션 지시 단추가 없습니다");
      assert.ok(!col3.includes("세션 선택") && !col3.includes("세션 고르기"), "세션 고르기가 남았습니다");
      assert.equal(await page.locator(".pas-ro1707-col select").count(), 0, "세션 고르기 select가 있습니다");
      const sheetText = (await page.locator('[data-testid="overview-sheet"]').innerText()).replace(/\s+/g, " ");
      assert.ok(!sheetText.includes("세션 중단"), "조감 시트에 세션 중단이 있습니다");
      const mainPad = await page.locator('[data-testid="chat-input"] textarea').evaluate(element => {
        const style = getComputedStyle(element);
        return { top: style.paddingTop, bottom: style.paddingBottom };
      });
      assert.equal(mainPad.top, mainPad.bottom, `메인 입력 안쪽 여백 비대칭: ${JSON.stringify(mainPad)}`);
      const dockPad = await page.locator(".pas-ro1707-field textarea").evaluate(element => {
        const style = getComputedStyle(element);
        return { top: style.paddingTop, bottom: style.paddingBottom };
      });
      assert.equal(dockPad.top, dockPad.bottom, `도크 입력 안쪽 여백 비대칭: ${JSON.stringify(dockPad)}`);
      geometryNotes.inputPadding = { main: mainPad, dock: dockPad };
      await assertNoOverflow(page, "1440 조감 시트");
      await capture(page, "02-1440-dark-3col.png");
      return `상단 ${JSON.stringify(tops)}, 3열, 탭 0, 커멘트 2, 세션 3턴, 입력 여백 ${JSON.stringify(dockPad)}`;
    });

    await step("R5 초상 4종과 응답 없는 호출 0", async () => {
      const images = await imageReport(page);
      assert.deepEqual(images.broken, [], `깨진 그림: ${JSON.stringify(images.broken)}`);
      const expected = ["roselin.png", "keke.png", "selaphiel.png", "characters/seosoyoung/still.png"];
      for (const file of expected) {
        assert.ok(images.sources.some(source => source.includes(file)), `${file} 초상이 없습니다: ${JSON.stringify(images.sources)}`);
      }
      assert.ok(images.sources.filter(source => source.includes("mockup-portraits/") || source.includes("characters/seosoyoung/still.png")).length >= 4);
      const unmockedNow = await unmocked(page);
      unmockedReports.sheet = unmockedNow;
      assert.deepEqual(unmockedNow, []);
      return `그림 ${images.count}개 정상, 초상 4종, 응답 없는 호출 0`;
    });

    await step("R2 1680 선택지 처분, 되돌리기, 말풍선 수", async () => {
      const beforeTitleTop = await topOf(page, '[data-testid="overview-title"]');
      await page.locator(".v3-card-question-choices button", { hasText: "최근 7일" }).click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1512"));
      await pause(80);
      assert.match(await sheetTitle(page), /^#1512 /);
      assert.equal(await bubbleCount(page), "1 / 4", "처분 뒤 말풍선 수가 1 / 4가 아닙니다");
      assert.ok((await page.locator('[data-testid="overview-undo-slot"]').innerText()).includes("되돌리기"));
      const chatAfterOption = await page.locator(".pas-ro1707-chat-scroll").innerText();
      assert.ok(chatAfterOption.includes("#1680 완료 목록 기간 칩의 기본 범위를 완료했습니다."),
        `처분이 원고지 대화에 반영되지 않았습니다: ${chatAfterOption.slice(-120)}`);
      await capture(page, "03-1440-dark-after-option.png");
      await page.locator('[data-testid="overview-undo"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1680"));
      await pause(80);
      assert.equal(await bubbleCount(page), "1 / 5", "되돌리기 뒤 말풍선 수가 1 / 5가 아닙니다");
      const chatAfterUndo = await page.locator(".pas-ro1707-chat-scroll").innerText();
      assert.ok(!chatAfterUndo.includes("#1680 완료 목록 기간 칩의 기본 범위를 완료했습니다."),
        "되돌리기 뒤 원고지 대화가 남았습니다");
      assert.match(await titleRowText(page), /질문/);
      const options = page.locator(".v3-card-question-choices button");
      assert.equal(await options.count(), 3, "되돌리기 뒤 선택지가 3개가 아닙니다");
      for (let index = 0; index < 3; index += 1) {
        assert.equal(await options.nth(index).isDisabled(), false, "되돌리기 뒤 선택지가 잠겨 있습니다");
      }
      const afterTitleTop = await topOf(page, '[data-testid="overview-title"]');
      assert.ok(Math.abs(afterTitleTop - beforeTitleTop) <= 1, `제목 Y가 흔들렸습니다: ${beforeTitleTop} → ${afterTitleTop}`);
      await pause(450);
      await page.locator(".v3-card-question-choices button", { hasText: "최근 7일" }).click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1512"));
      await pause(80);
      return `선택지 3개, 처분 뒤 1 / 4, 되돌리기 뒤 1 / 5와 제목 Y ${beforeTitleTop}px 고정`;
    });

    await step("R2 1512 처분과 제목, 주 단추 Y 0px", async () => {
      const titleBefore = await topOf(page, '[data-testid="overview-title"]');
      const primaryBefore = await topOf(page, '[data-testid="overview-primary"]');
      assert.ok((await page.locator(".pas-ro1707-stamps").innerText()).includes("했어"));
      assert.ok((await page.locator(".pas-ro1707-stamps").innerText()).includes("저녁에 다시 보기"));
      await page.locator('[data-testid="overview-primary"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1387"));
      await pause(80);
      assert.match(await sheetTitle(page), /^#1387 /);
      assert.equal(await bubbleCount(page), "1 / 3", "1512 처분 뒤 말풍선 수가 1 / 3이 아닙니다");
      assert.equal(await page.locator(".pas-ro1707-chip").count(), 5, "처분 뒤 스트립이 다섯 장이 아닙니다");
      assert.ok((await page.locator(".pas-ro1707-stamps").innerText()).includes("폴더 문서로 남기고 완료"));
      const titleAfter = await topOf(page, '[data-testid="overview-title"]');
      const primaryAfter = await topOf(page, '[data-testid="overview-primary"]');
      assert.ok(Math.abs(titleAfter - titleBefore) <= 1, `처분 뒤 제목 Y가 흔들렸습니다: ${titleBefore} → ${titleAfter}`);
      assert.ok(Math.abs(primaryAfter - primaryBefore) <= 1, `처분 뒤 주 단추 Y가 흔들렸습니다: ${primaryBefore} → ${primaryAfter}`);
      geometryNotes.dispositionY = { titleBefore, titleAfter, primaryBefore, primaryAfter };
      await page.locator('[data-testid="overview-undo"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1512"));
      await pause(80);
      const titleRestored = await topOf(page, '[data-testid="overview-title"]');
      const primaryRestored = await topOf(page, '[data-testid="overview-primary"]');
      assert.ok(Math.abs(titleRestored - titleBefore) <= 1, `되돌리기 뒤 제목 Y가 흔들렸습니다: ${titleBefore} → ${titleRestored}`);
      assert.ok(Math.abs(primaryRestored - primaryBefore) <= 1, `되돌리기 뒤 주 단추 Y가 흔들렸습니다: ${primaryBefore} → ${primaryRestored}`);
      assert.match(await titleRowText(page), /검수 대기/);
      await pause(450);
      await page.locator('[data-testid="overview-primary"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1387"));
      await pause(80);
      await capture(page, "04-1440-dark-1387.png");
      return `제목 ${titleBefore} → ${titleAfter} → ${titleRestored}, 주 단추 ${primaryBefore} → ${primaryAfter} → ${primaryRestored}`;
    });

    await step("R2 1387 문서 읽기, 승격, 문서 열기, 되돌리기", async () => {
      const readerButton = page.getByRole("button", { name: "설계 문서 전문 읽기" });
      await readerButton.click({ force: true });
      const reader = page.locator('[data-testid="internal-document-dialog"]');
      await reader.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector('[data-testid="internal-document-dialog"]')?.textContent?.includes("접수"));
      const readerText = (await reader.innerText()).replace(/\s+/g, " ");
      for (const word of ["접수", "분류", "실행", "검수 대기 시간"]) {
        assert.ok(readerText.includes(word), `설계 문서에 ${word}가 없습니다`);
      }
      await capture(page, "05-1440-dark-design-document.png");
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "hidden" });
      await pause(100);
      const readerFocus = await active(page);
      assert.ok((readerFocus?.text ?? "").includes("설계 문서 전문 읽기"), `문서를 닫은 뒤 초점이 돌아오지 않았습니다: ${JSON.stringify(readerFocus)}`);

      await page.locator('[data-testid="overview-primary"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1408"));
      await pause(80);
      assert.equal(await bubbleCount(page), "1 / 2", "승격 뒤 말풍선 수가 1 / 2가 아닙니다");
      const openDocument = page.getByRole("button", { name: "문서 열기", exact: true });
      assert.equal(await openDocument.count(), 1, "승격 뒤 문서 열기 단추가 없습니다");
      await openDocument.click({ force: true });
      await reader.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector('[data-testid="internal-document-dialog"]')?.textContent?.includes("접수"));
      const promotedText = (await reader.innerText()).replace(/\s+/g, " ");
      assert.ok(promotedText.includes("턴 안 상호작용 3단계 도입 설계안"), "승격 문서 제목이 없습니다");
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "hidden" });
      await pause(100);
      const promotedFocus = await active(page);
      assert.ok((promotedFocus?.text ?? "").includes("문서 열기"), `승격 문서를 닫은 뒤 초점이 다릅니다: ${JSON.stringify(promotedFocus)}`);

      await page.locator('[data-testid="overview-undo"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1387"));
      await pause(80);
      assert.match(await titleRowText(page), /검수 대기/);
      assert.equal(await page.getByRole("button", { name: "문서 열기", exact: true }).count(), 0, "되돌리기 뒤 문서 열기 단추가 남았습니다");
      assert.equal(await bubbleCount(page), "1 / 3", "되돌리기 뒤 말풍선 수가 1 / 3이 아닙니다");
      await pause(450);
      await page.locator('[data-testid="overview-primary"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1408"));
      await pause(80);
      return "문서 전문 읽기와 초점 복귀, 승격 뒤 문서 열기, 되돌리기에서 문서 단추 제거";
    });

    await step("R2 1408 커멘트 4건 전량, 항목 지시, 실행 중, 되돌리기", async () => {
      assert.deepEqual(geometryNotes.columnTops1440, await page.evaluate(() => ["1", "2", "3"].map(number => {
        const element = document.querySelector(`[data-testid="overview-col-${number}"]`);
        return Math.round(element.getBoundingClientRect().top * 10) / 10;
      })));
      assert.equal(await page.locator('[data-testid="overview-comment"]').count(), 4, "1408 커멘트가 4건이 아닙니다");
      const comments = (await page.locator('[data-testid="overview-comments"]').innerText()).replace(/\s+/g, " ");
      for (const text of ["1차 구현을 올렸습니다", "2번 항목에서 순서를 바꾼 뒤", "저장 시점에 순서 배열을", "좁은 폭에서 도구 줄이 겹치는 건"]) {
        assert.ok(comments.includes(text), `커멘트가 잘렸습니다: ${text}`);
      }
      assert.equal(await page.locator('[data-testid="overview-comment"] .pas-ro1707-badge').count(), 3, "대상 항목 배지가 3개가 아닙니다");
      assert.equal(await page.locator('[data-testid="overview-turn"]').count(), 4, "1408 세션 대화가 4턴이 아닙니다");
      assert.ok((await page.locator('[data-testid="overview-col-3"]').innerText()).includes("슬라이드 편집 검수 세션"));
      const targetButton = page.locator(".v3-card-check-item-target", { hasText: "고칠 점 남기기" }).nth(1);
      await targetButton.click({ force: true });
      await page.waitForSelector('[data-testid="overview-target"]', { state: "visible" });
      assert.ok((await page.locator('[data-testid="overview-target"]').innerText()).includes("대상: 2번 항목"));
      const textarea = page.locator(".pas-ro1707-field textarea");
      await textarea.fill("2번 항목을 다시 확인해 주세요");
      await textarea.press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1112"));
      await pause(80);
      assert.equal(await bubbleCount(page), "1 / 1", "항목 지시 뒤 말풍선 수가 1 / 1이 아닙니다");
      assert.equal(await page.locator(".pas-ro1707-undo-slot").innerText().then(text => text.includes("되돌리기")), true);
      await capture(page, "06-1440-dark-item-instruction.png");

      await closeSheet(page);
      await openTaskDrawer(page);
      const running = await drawerText(page);
      assert.ok(running.includes("#1408"), `작업 목록 실행 중에 #1408이 없습니다: ${running.slice(0, 200)}`);
      assert.ok(running.includes("실행 중"), "작업 목록에 실행 중 표시가 없습니다");
      assert.ok(running.includes("보류함 18개 (변동 없음)"), "보류함 18개 표시가 없습니다");
      await capture(page, "07-1440-dark-drawer-running.png");
      await closeTaskDrawer(page);
      await openSheet(page);
      await page.locator('[data-testid="overview-undo"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1408"));
      await pause(80);
      assert.match(await titleRowText(page), /검수 대기/);
      assert.equal(await page.locator('[data-testid="overview-comment"]').count(), 4, "되돌리기 뒤 커멘트가 4건이 아닙니다");
      await pause(450);
      await page.locator('[data-testid="overview-primary"]').click({ force: true });
      await page.waitForFunction(() => document.querySelector('[data-testid="overview-title"]')?.textContent?.includes("#1112"));
      await pause(80);
      return "커멘트 4건과 배지 3개, 4턴, 대상 칩과 실행 중 이동, 작업 목록 반영, 되돌리기 뒤 4건";
    });

    await step("R3 1112 사흘 뒤 재확인, 검증 대기, 보류함 18", async () => {
      assert.match(await sheetTitle(page), /^#1112 /);
      assert.ok((await page.locator('[data-testid="overview-evidence"]').innerText()).includes("11월 17일"));
      assert.equal(await page.locator('[data-testid="overview-turn"]').count(), 3, "1112 세션 대화가 3턴이 아닙니다");
      assert.equal(await page.locator('[data-testid="overview-comment"]').count(), 2, "1112 커멘트가 2건이 아닙니다");
      assert.ok((await page.locator('[data-testid="overview-col-1"]').innerText()).includes("사흘 아침 알림 기록"));
      await page.locator('[data-testid="overview-primary"]').click({ force: true });
      await pause(120);
      assert.match(await titleRowText(page), /검증 대기/);
      assert.equal(await page.locator('[data-testid="report-bubble"]').count(), 0, "미결 0에서 말풍선이 남았습니다");
      assert.ok((await page.locator('[data-testid="overview-undo-slot"]').innerText()).includes("되돌리기"));
      await capture(page, "08-1440-dark-awaiting.png");
      await closeSheet(page);
      await openTaskDrawer(page);
      const drawer = await drawerText(page);
      assert.ok(drawer.includes("#1112"), `작업 목록에 #1112가 없습니다: ${drawer.slice(0, 200)}`);
      assert.ok(drawer.includes("검증 대기"), "작업 목록에 검증 대기 표시가 없습니다");
      assert.ok(drawer.includes("보류함 18개 (변동 없음)"), "보류함 18개가 유지되지 않았습니다");
      await capture(page, "09-1440-dark-drawer-awaiting.png");
      await closeTaskDrawer(page);
      const focus = await active(page);
      assert.equal(focus?.label, "작업 목록", `작업 목록을 닫은 뒤 초점이 다릅니다: ${JSON.stringify(focus)}`);
      return "검증 대기 전환, 말풍선 0, 작업 목록 #1112와 보류함 18개";
    });

    await step("R2 #report 직접 진입과 ?view=report", async () => {
      await page.goto(`${base}/frame.html?theme=dark&glass=css`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="pas-report-overview-screen"]', { state: "visible" });
      await pause(200);
      await page.goto(`${base}/frame.html?theme=dark&glass=css#report`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="overview-sheet"]', { state: "visible" });
      assert.match(await sheetTitle(page), /^#1680 /);
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="overview-sheet"]').waitFor({ state: "hidden" });
      await pause(120);
      const closeFocus = await active(page);
      assert.equal(closeFocus?.text, "보고 창 열기",
        `조감판을 닫은 뒤 초점이 말풍선 단추가 아닙니다: ${JSON.stringify(closeFocus)}`);
      await page.goto(`${base}/frame.html?theme=dark&glass=css&view=report`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="overview-sheet"]', { state: "visible" });
      const query = await page.evaluate(() => ({ search: location.search, hash: location.hash }));
      assert.ok(query.search.includes("view=report"), "view=report 질의가 사라졌습니다");
      assert.equal(query.hash, "#report", "view=report에서 해시가 #report가 아닙니다");
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="overview-sheet"]').waitFor({ state: "hidden" });
      assert.equal(new URL(page.url()).hash, "#pas", "닫은 뒤 해시가 #pas가 아닙니다");
      return "해시 #report와 질의 view=report 두 진입, 닫으면 #pas";
    });

    await context.close();

    const responsiveContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const responsive = await responsiveContext.newPage();

    await step("R4 1440, 820, 390, 360 반응형과 겹침 없음", async () => {
      const notes = [];
      for (const [width, height] of [[1440, 900], [820, 1180], [390, 844], [360, 780]]) {
        for (const theme of ["dark", "light"]) {
          await openMain(responsive, { width, height, theme });
          notes.push(await assertNoPublishHit(responsive, `${width} 메인 ${theme}`));
          await openSheet(responsive);
          notes.push(await assertNoPublishHit(responsive, `${width} 시트 ${theme}`));
          notes.push(await assertNoOverflow(responsive, `${width} 시트 ${theme}`));
          const tracks = await responsive.locator(".pas-ro1707-cols").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length);
          const displayed = await responsive.locator(".pas-ro1707-cols").evaluate(element => getComputedStyle(element).display);
          if (width >= 1180) {
            assert.equal(tracks, 3, `${width}에서 3열이 아닙니다: ${tracks}`);
          } else if (width >= 768) {
            assert.equal(tracks, 2, `${width}에서 2열이 아닙니다: ${tracks}`);
            const tops = await responsive.evaluate(() => {
              const one = document.querySelector('[data-testid="overview-col-1"]').getBoundingClientRect();
              const three = document.querySelector('[data-testid="overview-col-3"]').getBoundingClientRect();
              return { oneBottom: one.bottom, threeTop: three.top };
            });
            assert.ok(tops.threeTop >= tops.oneBottom - 1, `${width}에서 세션 열이 아래가 아닙니다: ${JSON.stringify(tops)}`);
          } else {
            assert.equal(displayed, "block", `${width}에서 한 열이 아닙니다: ${displayed}`);
            assert.equal(await responsive.locator(".pas-ro1707-jump").isVisible(), true, `${width}에서 구역 바로가기가 없습니다`);
            const order = await responsive.evaluate(() => {
              const one = document.querySelector('[data-testid="overview-col-1"]').getBoundingClientRect();
              const two = document.querySelector('[data-testid="overview-col-2"]').getBoundingClientRect();
              const three = document.querySelector('[data-testid="overview-col-3"]').getBoundingClientRect();
              return { oneBottom: one.bottom, twoTop: two.top, twoBottom: two.bottom, threeTop: three.top };
            });
            assert.ok(order.twoTop >= order.oneBottom - 1 && order.threeTop >= order.twoBottom - 1, `${width}에서 열이 세로로 쌓이지 않았습니다: ${JSON.stringify(order)}`);
            const bubbleInline = await responsive.locator(".pas-ro1707-inline-bubble [data-testid='report-bubble']").count();
            assert.equal(bubbleInline, 1, `${width}에서 인라인 말풍선이 없습니다`);
            const composer = await responsive.locator('[data-testid="chat-input"]').boundingBox();
            assert.ok(composer && height - (composer.y + composer.height) >= 60, `${width} 메인 입력창 아래 여백이 부족합니다: ${JSON.stringify(composer)}`);
          }
          if ((width === 1440 && theme === "dark") || (width === 820 && theme === "dark")
            || (width === 390 && theme === "light") || (width === 360 && theme === "light")) {
            await capture(responsive, `10-${width}-${theme}-sheet.png`);
          }
          await closeSheet(responsive);
        }
      }
      return `${notes.length}회 확인, ${notes.slice(0, 4).join(", ")} ...`;
    });

    await step("R4 1440 3열 좌표 기록과 820 2열", async () => {
      await openMain(responsive, { width: 1440, height: 900, theme: "dark" });
      await openSheet(responsive);
      geometryNotes.columnTops1440Final = await responsive.evaluate(() => ["1", "2", "3"].map(number => {
        const element = document.querySelector(`[data-testid="overview-col-${number}"]`);
        return Math.round(element.getBoundingClientRect().top * 10) / 10;
      }));
      const sheetBox = await responsive.locator(".pas-ro1707-sheet-panel").boundingBox();
      geometryNotes.sheet1440 = sheetBox;
      await closeSheet(responsive);
      await openMain(responsive, { width: 820, height: 1180, theme: "dark" });
      await openSheet(responsive);
      geometryNotes.sheet820 = await responsive.locator(".pas-ro1707-sheet-panel").boundingBox();
      await closeSheet(responsive);
      await openMain(responsive, { width: 390, height: 844, theme: "dark" });
      await openSheet(responsive);
      geometryNotes.sheet390 = await responsive.locator(".pas-ro1707-sheet-panel").boundingBox();
      await closeSheet(responsive);
      const panelBottom = geometryNotes.sheet390.y + geometryNotes.sheet390.height;
      assert.ok(panelBottom <= 844 - 76 + 1, `390 시트 아래 여백이 76px 미만입니다: ${panelBottom}`);
      return `3열 ${JSON.stringify(geometryNotes.columnTops1440Final)}, 1440 시트 ${JSON.stringify(sheetBox)}, 390 시트 ${JSON.stringify(geometryNotes.sheet390)}`;
    });

    await step("R4 창 크기 바꾸기에서 입력과 스크롤 유지", async () => {
      await openMain(responsive, { width: 1440, height: 900, theme: "dark" });
      await openSheet(responsive);
      await responsive.locator(".pas-ro1707-field textarea").fill("창 크기 확인");
      const scrollBefore = await responsive.locator('[data-testid="overview-col-1"] .pas-ro1707-col-scroll')
        .evaluate(element => { element.scrollTop = 120; return element.scrollTop; });
      assert.ok(scrollBefore > 0, `첫 열이 스크롤되지 않습니다: ${scrollBefore}`);
      await responsive.setViewportSize({ width: 820, height: 1180 });
      await pause(220);
      const at820 = await responsive.evaluate(() => ({
        value: document.querySelector(".pas-ro1707-field textarea")?.value,
        tracks: getComputedStyle(document.querySelector(".pas-ro1707-cols")).gridTemplateColumns.split(" ").filter(Boolean).length,
        scroll: document.querySelector('[data-testid="overview-col-1"] .pas-ro1707-col-scroll')?.scrollTop,
      }));
      assert.equal(at820.value, "창 크기 확인", `창 크기를 바꾸면 입력이 사라집니다: ${JSON.stringify(at820)}`);
      assert.equal(at820.tracks, 2, `820으로 바꾸면 2열이 아닙니다: ${JSON.stringify(at820)}`);
      assert.equal(at820.scroll, scrollBefore, `첫 열 스크롤이 유지되지 않습니다: ${scrollBefore} -> ${at820.scroll}`);
      await responsive.setViewportSize({ width: 1440, height: 900 });
      await pause(220);
      const back = await responsive.evaluate(() => ({
        value: document.querySelector(".pas-ro1707-field textarea")?.value,
        tracks: getComputedStyle(document.querySelector(".pas-ro1707-cols")).gridTemplateColumns.split(" ").filter(Boolean).length,
        scroll: document.querySelector('[data-testid="overview-col-1"] .pas-ro1707-col-scroll')?.scrollTop,
      }));
      assert.equal(back.value, "창 크기 확인");
      assert.equal(back.tracks, 3, `1440으로 되돌리면 3열이 아닙니다: ${JSON.stringify(back)}`);
      assert.equal(back.scroll, scrollBefore, `첫 열 스크롤이 되돌릴 때 유지되지 않습니다: ${scrollBefore} -> ${back.scroll}`);
      await closeSheet(responsive);
      geometryNotes.resize = { scrollBefore, at820, back };
      return `입력 유지, 첫 열 스크롤 ${scrollBefore} -> ${at820.scroll} -> ${back.scroll}`;
    });

    await step("R5 금지 문장부호와 박다 계열 0", async () => {
      await openMain(responsive, { width: 1440, height: 900, theme: "dark" });
      await openSheet(responsive);
      await openChip(responsive, 1408);
      const pageScan = await responsive.evaluate(() => ({ title: document.title, text: document.body.innerText }));
      const hits = scanForbidden(`${pageScan.title}\n${pageScan.text}`, "화면");
      const files = [
        "client/v3/pas-report-overview-1707/pas-report-overview-1707-data.ts",
        "client/v3/pas-report-overview-1707/PasReportOverviewScreen.tsx",
        "client/v3/pas-report-overview-1707/OverviewSheet.tsx",
        "client/v3/pas-report-overview-1707/OverviewEvidenceArt.tsx",
        "client/v3/pas-report-overview-1707/PasReportOverviewMockup.tsx",
        "client/v3/pas-report-overview-1707/use-pas-report-overview-1707.ts",
        "client/v3/pas-report-overview-1707/v3-pas-report-overview-1707.css",
        "mockups/pas-report-1707-overview/index.html",
        "mockups/pas-report-1707-overview/frame.html",
        "mockups/pas-report-1707-overview/frame.tsx",
      ];
      for (const file of files) {
        const text = readFileSync(resolve(dashboardDir, file), "utf8");
        hits.push(...scanForbidden(text, file));
      }
      assert.deepEqual(hits, [], `금지 표현: ${JSON.stringify(hits)}`);
      return `화면과 원본 ${files.length}개에서 0건`;
    });

    await responsiveContext.close();

    const allErrors = [...pageErrors];
    if (allErrors.length > 0) {
      results.push({ id: "pageerror", pass: allErrors.length === 0, detail: allErrors });
      console.log(`WARN  pageerror ${allErrors.length}건: ${allErrors.slice(0, 3).join(" | ")}`);
    }
  });
} finally {
  await closeServer(server);
}

const failed = results.filter(result => !result.pass);
const summary = {
  base,
  distDir,
  output,
  results,
  captures,
  unmocked: unmockedReports,
  geometry: geometryNotes,
};
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log("");
for (const result of failed) console.log(`FAIL  ${result.id}  ${result.error}`);
console.log(`pas-report-1707-overview: ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(`summary ${join(output, "summary.json")}`);
if (failed.length > 0) process.exitCode = 1;
