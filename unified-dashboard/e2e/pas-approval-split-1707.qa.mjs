#!/usr/bin/env node
/**
 * 시안 B, PAS 지휘실 2단 스플릿 시각 검수.
 *
 * 빌드된 정적 묶음(dist-mockups/pas-approval-1707-split)을 그 자리에서 서빙하고
 * 실제 Chromium으로 R1~R5와 ui-design 0절 14~18번을 조작해 확인한다.
 * 세라피엘 1차 검수의 측정 방식(검수 토글 112 곱하기 64 겹침, 어절 중간 줄바꿈,
 * 탭 내용 변화, 폴더 거르기, 카드 작업대 열기, 초상 구분)을 그대로 옮겼다.
 * 헤드리스 소프트웨어 렌더링에서 WebGL 유리는 프레임마다 몇 초를 잡아먹으므로
 * 레이아웃과 겹침은 시안이 제공하는 ?glass=css 모드로 재고, WebGL 캔버스 경로는
 * B6 단계에서 한 번만 확인한다.
 *
 * 실행:
 *   MOCKUP=pas-approval-1707-split ./node_modules/.bin/vite build --config vite.mockup.config.ts
 *   node e2e/pas-approval-split-1707.qa.mjs
 *
 * 캡처는 기본으로 /home/eias/workspace/.local/artifacts/pas-approval-1707-split 에 쓴다.
 * PAS_SPLIT_OUTPUT 으로 바꿀 수 있다.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = resolve(here, "..");
const distDir = resolve(dashboardDir, "dist-mockups", "pas-approval-1707-split");
const output = process.env.PAS_SPLIT_OUTPUT
  ?? "/home/eias/workspace/.local/artifacts/pas-approval-1707-split";
if (!existsSync(join(distDir, "frame.html"))) {
  throw new Error(`묶음이 없습니다: ${distDir}\nMOCKUP=pas-approval-1707-split vite build --config vite.mockup.config.ts 를 먼저 실행하세요.`);
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
      resolveServer({
        server,
        base: `http://127.0.0.1:${address.port}`,
      });
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

// 헤드리스 소프트웨어 렌더링에서 WebGL 유리는 프레임마다 몇 초를 잡아먹는다.
// 시안이 제공하는 CSS 유리 모드로 레이아웃과 겹침을 재고, WebGL 캔버스는 따로 한 번만 확인한다.
const glassQuery = glass => glass === "css" ? "&glass=css" : "";

async function open(page, { width, height, theme, glass = "css" }) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/frame.html?theme=${theme}${glassQuery(glass)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-split-app"]', { state: "visible" });
  await page.waitForSelector("#pas-sheet-title", { state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await pause(200);
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  assert.equal(dark, theme === "dark", `테마 클래스가 ${theme}와 다릅니다`);
}

async function openRoute(page, { width, height, theme, hash, glass = "css" }) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/frame.html?theme=${theme}${glassQuery(glass)}#${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-split-app"]', { state: "visible" });
  await page.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await pause(200);
}

async function openQuiet(page, { width, height, theme, glass = "css" }) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/frame.html?theme=${theme}${glassQuery(glass)}#pas-chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-split-app"]', { state: "visible" });
  await page.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await pause(200);
}

async function capture(page, name) {
  const path = join(output, name);
  await page.screenshot({ path, animations: "disabled" });
  captures.push(path);
}

async function active(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    return {
      tag: element.tagName,
      label: element.getAttribute("aria-label"),
      testid: element.getAttribute("data-testid"),
      documentId: element.getAttribute("data-document-id"),
      className: typeof element.className === "string" ? element.className : "",
    };
  });
}

async function sheetTitle(page) {
  return (await page.locator("#pas-sheet-title").innerText()).replace(/\s+/g, " ").trim();
}

async function tab(page, number) {
  await page.locator(".pas-clipboard-tab", { hasText: `#${number}` }).click({ force: true });
  await page.waitForFunction(value => {
    const element = document.querySelector("#pas-sheet-title");
    return element?.textContent?.includes(`#${value}`);
  }, number);
}

async function primary(page, label) {
  await page.locator(".pas-sheet-actions").getByRole("button", { name: label }).click({ force: true });
  await pause(80);
}

async function pendingCount(page) {
  const text = await page.locator(".pas-split-viewswitch button").first().innerText();
  return Number(text.match(/\((\d+)\)/)?.[1] ?? -1);
}

async function overflowReport(page) {
  return page.evaluate(() => {
    const app = document.querySelector('[data-testid="pas-split-app"]');
    const root = document.documentElement;
    const offenders = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (element.closest(".wallpaper-layer")) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        offenders.push({
          tag: element.tagName,
          className: typeof element.className === "string" ? element.className.slice(0, 80) : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        });
        if (offenders.length >= 8) break;
      }
    }
    return {
      viewport: window.innerWidth,
      documentScroll: root.scrollWidth,
      documentClient: root.clientWidth,
      bodyScroll: document.body.scrollWidth,
      bodyClient: document.body.clientWidth,
      appScroll: app?.scrollWidth ?? 0,
      appClient: app?.clientWidth ?? 0,
      offenders,
    };
  });
}

async function assertNoOverflow(page, label) {
  const report = await overflowReport(page);
  assert.ok(
    report.documentScroll <= report.documentClient + 1
      && report.bodyScroll <= report.bodyClient + 1
      && report.appScroll <= report.appClient + 1
      && report.offenders.length === 0,
    `${label} 가로 넘침: ${JSON.stringify(report)}`,
  );
  return `${label} 넘침 없음 (${report.viewport}px)`;
}

async function unmocked(page) {
  return page.evaluate(() => (window.__mockupUnmocked ?? []).filter(item => !item.startsWith("STREAM ")));
}

async function openTaskDrawer(page) {
  await page.getByRole("button", { name: "작업 목록", exact: true }).click({ force: true });
  await page.waitForSelector('[data-testid="pas-task-drawer"]', { state: "visible" });
}

async function groupText(page, id) {
  return (await page.locator(`[data-task-group="${id}"]`).innerText()).replace(/\s+/g, " ").trim();
}

async function closeWithEscape(page, selector) {
  await page.keyboard.press("Escape");
  await page.locator(selector).waitFor({ state: "hidden" });
  await pause(120);
}

async function installReviewToggle(page) {
  await page.evaluate(() => {
    document.getElementById("pages-review")?.remove();
    const host = document.createElement("div");
    host.id = "pages-review";
    host.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const toggle = document.createElement("button");
    toggle.id = "toggle";
    toggle.type = "button";
    toggle.textContent = "검토";
    toggle.style.cssText = [
      "position:fixed", "right:12px", "bottom:12px", "width:112px", "height:64px",
      "border:0", "border-radius:16px", "background:#111", "color:#fff",
      "font-size:14px", "font-weight:700", "z-index:2147483647",
    ].join(";");
    root.append(toggle);
    document.body.append(host);
  });
  await pause(40);
}

async function toggleHits(page) {
  return page.evaluate(() => {
    const host = document.getElementById("pages-review");
    const toggle = host?.shadowRoot?.querySelector("#toggle");
    if (!toggle) return { error: "no-toggle", hits: [] };
    const rect = toggle.getBoundingClientRect();
    const hits = new Map();
    const selector = "button, a, input, textarea, [role=button], [role=tab], select";
    const describe = element => {
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 40),
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      };
    };
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
    // 토글을 잠시 숨기고 실제로 그 자리에서 집히는 요소를 본다. 스크롤 컨테이너 밖으로
    // 잘린 카드처럼 보이지 않는 요소를 겹침으로 잘못 세지 않기 위해서다.
    toggle.style.visibility = "hidden";
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
      if (!hits.has(candidate.element)) hits.set(candidate.element, describe(candidate.element));
    }
    toggle.style.visibility = "";
    return { toggle: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)], hits: [...hits.values()] };
  });
}

async function assertNoToggleHits(page, label) {
  await installReviewToggle(page);
  const report = await toggleHits(page);
  assert.ok(!report.error, `${label} 검수 토글 없음`);
  assert.equal(report.hits.length, 0, `${label} 검수 토글 겹침: ${JSON.stringify(report.hits)}`);
  return `${label} 겹침 없음`;
}

async function brokenWords(page, selector) {
  return page.evaluate(sel => {
    const element = document.querySelector(sel);
    if (!element) return { missing: true, broken: [], style: null };
    const style = getComputedStyle(element);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const broken = [];
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue ?? "";
      const words = text.matchAll(/[^\s]+/g);
      for (const word of words) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        if (rects.length > 1) broken.push(word[0]);
      }
      node = walker.nextNode();
    }
    return {
      missing: false,
      broken,
      style: {
        wordBreak: style.wordBreak,
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
        fontSize: style.fontSize,
        color: style.color,
      },
    };
  }, selector);
}

const { server, base } = await startStaticServer();
console.log(`묶음 ${distDir}`);
console.log(`서빙 ${base}`);
console.log(`캡처 ${output}`);

try {
  await runPlaywrightLifecycle({
    lockName: "pas-approval-split-1707",
    timeoutMs: 585_000,
    launchBrowser: (options) => chromium.launch({ ...options, executablePath }),
  }, async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await step("R1 기본 화면과 해시 이동", async () => {
      await open(page, { width: 1440, height: 900, theme: "dark" });
      assert.equal(await page.locator('[data-testid="pas-split-app"]').getAttribute("data-route"), "pas");
      assert.equal(await pendingCount(page), 5);
      assert.match(await sheetTitle(page), /^#1680 /);
      await capture(page, "01-1440-dark-board.png");

      const nav = page.locator(".pas-split-nav");
      assert.equal(await nav.getByRole("button").count(), 2, "헤더 탭이 두 개가 아닙니다");
      assert.equal(await nav.getByRole("button", { name: "홈", exact: true }).count(), 1,
        "헤더에 홈 탭이 중복됩니다");
      assert.equal(await page.locator('.pas-split-header [aria-label="홈"]').count(), 0,
        "헤더에 집 아이콘이 남았습니다");

      await nav.getByRole("button", { name: "홈", exact: true }).click({ force: true });
      await page.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#home");
      await page.getByRole("tab", { name: "폴더 문서" }).click({ force: true });
      await pause(120);
      assert.equal(new URL(page.url()).hash, "#folder-docs");
      assert.equal(await page.locator('[data-testid="pas-home"]').getAttribute("data-focus"), "docs");

      await nav.getByRole("button", { name: "PAS 지휘실" }).click({ force: true });
      await page.waitForSelector(".pas-split-body", { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#pas");
      await page.locator(".pas-split-viewswitch button").nth(1).click({ force: true });
      await page.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#pas-chat");
      await page.locator(".pas-split-viewswitch button").first().click({ force: true });
      await page.waitForSelector('.pas-split-body[data-mode="board"]', { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#pas");
      return "PAS 지휘실 기본, 헤더 탭 두 개, 홈/폴더 문서/PAS 대화 해시 왕복";
    });

    await step("R2 색인, 화살표, 증거 확대와 초점 복귀", async () => {
      assert.equal(await page.locator(".pas-clipboard-tab").count(), 5);
      const tabs = await page.locator(".pas-clipboard-tab").allInnerTexts();
      for (const expected of ["#1680", "#1512", "#1387", "#1408", "#1112"]) {
        assert.ok(tabs.some(text => text.includes(expected)), `${expected} 색인 탭이 없습니다`);
      }

      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector("#pas-sheet-title")?.textContent?.includes("#1512"));
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => document.querySelector("#pas-sheet-title")?.textContent?.includes("#1680"));

      await tab(page, 1408);
      await page.locator(".pas-evidence-trigger").click({ force: true });
      await page.locator(".pas-split-evidence-dialog").waitFor({ state: "visible" });
      await capture(page, "02-1440-dark-evidence.png");
      for (let index = 0; index < 5; index += 1) {
        await page.keyboard.press("Tab");
        const trapped = await page.evaluate(() => Boolean(document.activeElement?.closest(".pas-split-evidence-dialog")));
        assert.ok(trapped, "증거 대화상자 안에서 Tab이 밖으로 나갔습니다");
      }
      await closeWithEscape(page, ".pas-split-evidence-dialog");
      const focused = await active(page);
      assert.ok(focused?.className.includes("pas-evidence-trigger"), `증거를 닫은 뒤 초점이 돌아오지 않았습니다: ${JSON.stringify(focused)}`);
      return "탭 5개, ArrowLeft/Right, 증거 대화상자 Esc 닫기와 초점 복귀";
    });

    await step("R2 확인 항목, 정규 체크 항목, 구두 지시 칩", async () => {
      await tab(page, 1408);
      const firstCheck = page.locator(".pas-check-row").first();
      const checkbox = firstCheck.locator('[data-slot="checkbox"]');
      assert.equal(await checkbox.count(), 1, "정규 Checkbox가 하나가 아닙니다");
      assert.equal(await checkbox.getAttribute("data-variant"), "card-item",
        "정규 Checkbox card-item 변형이 아닙니다");
      const formInputs = await firstCheck.locator('input[type="checkbox"]').evaluateAll(nodes => nodes.map(node => ({
        ariaHidden: node.getAttribute("aria-hidden"),
        tabIndex: node.tabIndex,
        cssHidden: getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden",
      })));
      for (const input of formInputs) {
        assert.ok(input.ariaHidden === "true" || input.tabIndex < 0 || input.cssHidden,
          "정규 Checkbox의 숨은 입력이 조작 가능한 상태입니다");
      }
      await checkbox.click({ force: true });
      assert.equal(await firstCheck.getAttribute("data-done"), "true");
      await checkbox.click({ force: true });
      assert.equal(await firstCheck.getAttribute("data-done"), null);

      await page.locator(".pas-check-row").nth(1).getByRole("button", { name: "구두 지시" }).click({ force: true });
      await page.waitForSelector('[data-testid="pas-instruction-target"]', { state: "visible" });
      const targetText = (await page.locator('[data-testid="pas-instruction-target"]').innerText()).replace(/\s+/g, " ").trim();
      assert.ok(targetText.includes("전달 대상: #1408 2번 항목 보완 지시"), `칩 글자가 다릅니다: ${targetText}`);
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "PAS 메시지");
      await page.getByRole("button", { name: "전달 대상 해제" }).click({ force: true });
      await page.waitForSelector('[data-testid="pas-instruction-target"]', { state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "PAS 메시지");
      return "정규 Checkbox card-item 토글, 칩 표시와 해제, 입력창 초점";
    });

    await step("R2 IME 조합 Enter와 지시 전송", async () => {
      await tab(page, 1408);
      await page.locator(".pas-check-row").nth(1).getByRole("button", { name: "구두 지시" }).click({ force: true });
      const textarea = page.locator('textarea[aria-label="PAS 메시지"]');
      await textarea.fill("2번 항목을 다시 확인해 주세요");
      const before = await page.locator(".pas-split-message").count();
      await textarea.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: true,
        }));
      });
      await pause(120);
      assert.equal(await page.locator(".pas-split-message").count(), before, "조합 중 Enter가 전송했습니다");
      assert.equal(await textarea.inputValue(), "2번 항목을 다시 확인해 주세요");
      await textarea.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
      await textarea.press("Enter");
      await page.waitForFunction(count => document.querySelectorAll(".pas-split-message").length >= count, before + 2);
      assert.equal(await page.locator('[data-testid="pas-instruction-target"]').count(), 0, "전송 뒤 칩이 남았습니다");
      assert.equal(await pendingCount(page), 4);
      assert.match(await sheetTitle(page), /^#1112 /);
      const messages = await page.locator(".pas-split-message").allInnerTexts();
      assert.ok(messages.some(text => text.includes("2번 항목을 다시 확인해 주세요")));
      assert.ok(messages.some(text => text.includes("#1408 2번 항목 보완 지시를 보냈습니다")));

      await openTaskDrawer(page);
      assert.ok((await groupText(page, "running")).includes("#1408"), "작업 목록 진행 중에 #1408이 없습니다");
      assert.ok((await groupText(page, "review")).includes("4개"), "검수 그룹 수가 4가 아닙니다");
      assert.ok((await groupText(page, "hold")).includes("18개"), "보류 18건이 유지되지 않았습니다");
      await capture(page, "03-1440-dark-drawer.png");
      await closeWithEscape(page, '[data-testid="pas-task-drawer"]');
      const focused = await active(page);
      assert.equal(focused?.label, "작업 목록", `작업 목록을 닫은 뒤 초점이 다릅니다: ${JSON.stringify(focused)}`);
      return "조합 Enter 무시, 전송 뒤 칩 해제와 다음 서류 이동, 작업 목록 실시간 반영과 Esc";
    });

    const cleanUnmocked = await unmocked(page);
    unmockedReports.desktop = cleanUnmocked;
    await step("응답 없는 호출 0", async () => {
      assert.deepEqual(cleanUnmocked, []);
      return "STREAM 제외 0건";
    });

    await step("R2 대화만 보기와 SwayCharacter, 대화 초상", async () => {
      await page.locator(".pas-split-viewswitch button").nth(1).click({ force: true });
      await page.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      const character = page.locator(".pas-quiet-character :is(img, iframe)").first();
      await character.waitFor({ state: "visible" });
      const box = await character.boundingBox();
      assert.ok(box && box.height > 200, `캐릭터가 서 있지 않습니다: ${JSON.stringify(box)}`);
      const portrait = await page.locator(".pas-chat-portrait").getAttribute("src");
      assert.ok(portrait?.includes("characters/seosoyoung/still.png"), `대화 초상이 서소영 전용이 아닙니다: ${portrait}`);
      await capture(page, "04-1440-dark-quiet.png");
      return `SwayCharacter 높이 ${Math.round(box.height)}px, 대화 초상 분리`;
    });

    await context.close();

    const lightContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const lightPage = await lightContext.newPage();
    await step("라이트 테마 1440과 배경 유리", async () => {
      await open(lightPage, { width: 1440, height: 900, theme: "light" });
      const surface = await lightPage.evaluate(() => {
        const app = document.querySelector('[data-testid="pas-split-app"]');
        const main = document.querySelector(".v3-mockup-bare");
        return {
          appBackground: app ? getComputedStyle(app).backgroundColor : null,
          bareExists: Boolean(main),
          componentsMain: document.querySelectorAll(".v3-components-main").length,
          canvases: document.querySelectorAll("canvas").length,
          clipboardGlass: document.querySelector(".pas-split-clipboard")?.className ?? "",
          chatBackground: getComputedStyle(document.querySelector(".pas-split-chat")).backgroundColor,
        };
      });
      assert.ok(surface.bareExists, "bare main이 없습니다");
      assert.equal(surface.componentsMain, 0, "components-main이 남아 있습니다");
      assert.match(surface.appBackground, /rgba\(0, 0, 0, 0\)|transparent/,
        `시안 바탕이 투명하지 않습니다: ${surface.appBackground}`);
      assert.ok(surface.clipboardGlass.includes("glass-strong"), "클립보드 바깥이 유리가 아닙니다");
      await capture(lightPage, "05-1440-light-board.png");
      await lightPage.locator(".pas-split-viewswitch button").nth(1).click({ force: true });
      await lightPage.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      await capture(lightPage, "06-1440-light-quiet.png");
      return `bare main, 투명 바탕, CSS 유리, 클립보드 유리`;
    });
    await lightContext.close();

    const webglContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const webglPage = await webglContext.newPage();
    await step("B6 WebGL 유리 캔버스", async () => {
      await open(webglPage, { width: 1440, height: 900, theme: "dark", glass: "webgl" });
      const surface = await webglPage.evaluate(() => ({
        canvases: document.querySelectorAll("canvas").length,
        wallpaper: Boolean(document.querySelector(".wallpaper-layer")),
        appBackground: getComputedStyle(document.querySelector('[data-testid="pas-split-app"]')).backgroundColor,
      }));
      assert.ok(surface.canvases > 0, "WebGL 유리 캔버스가 없습니다");
      assert.ok(surface.wallpaper, "배경지 층이 없습니다");
      assert.match(surface.appBackground, /rgba\(0, 0, 0, 0\)|transparent/,
        `WebGL 바탕이 투명하지 않습니다: ${surface.appBackground}`);
      await capture(webglPage, "06b-1440-dark-webgl.png");
      return `캔버스 ${surface.canvases}개, 투명 바탕`;
    });
    await webglContext.close();

    const flowContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const flowPage = await flowContext.newPage();
    const flowErrors = [];
    flowPage.on("pageerror", error => flowErrors.push(error.message));

    await step("B2 질문 선택지 즉시 처분, 추천 강조, 되돌리기", async () => {
      await open(flowPage, { width: 1440, height: 900, theme: "dark" });
      assert.match(await sheetTitle(flowPage), /^#1680 /);
      const options = flowPage.locator(".pas-question-options button");
      assert.equal(await options.count(), 3);
      const optionTexts = (await options.allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
      assert.ok(optionTexts.includes("7일 유지 (권함)"), `추천 선택지 글자가 다릅니다: ${optionTexts.join(" | ")}`);
      const recommendedClass = await flowPage.locator('[data-question-option="7일 유지"]').getAttribute("class");
      assert.match(recommendedClass ?? "", /from-accent-blue/, "추천 선택지가 주 단추 강조가 아닙니다");
      const anotherClass = await flowPage.locator('[data-question-option="14일로 변경"]').getAttribute("class");
      assert.doesNotMatch(anotherClass ?? "", /from-accent-blue/, "다른 선택지가 주 단추 강조입니다");

      await flowPage.locator('[data-question-option="7일 유지"]').click({ force: true });
      await flowPage.waitForFunction(() => document.querySelector("#pas-sheet-title")?.textContent?.includes("#1512"));
      assert.equal(await pendingCount(flowPage), 4);
      const toast = flowPage.locator('[data-testid="pas-split-toast"]');
      await toast.waitFor({ state: "visible" });
      assert.ok((await toast.innerText()).includes("7일 유지"), "처분 영수증에 선택지가 없습니다");
      const toastPosition = await toast.evaluate(element => getComputedStyle(element).position);
      assert.ok(!["absolute", "fixed"].includes(toastPosition), `영수증이 고정 오버레이입니다: ${toastPosition}`);
      await capture(flowPage, "07-1440-dark-question-answer.png");

      await flowPage.getByRole("button", { name: "되돌리기" }).click({ force: true });
      await flowPage.waitForFunction(() => document.querySelector("#pas-sheet-title")?.textContent?.includes("#1680"));
      assert.equal(await pendingCount(flowPage), 5);

      await flowPage.getByRole("button", { name: "되묻기" }).click({ force: true });
      await flowPage.waitForSelector('[data-testid="pas-instruction-target"]', { state: "visible" });
      assert.ok((await flowPage.locator('[data-testid="pas-instruction-target"]').innerText()).includes("#1680 되묻기"));
      await flowPage.getByRole("button", { name: "전달 대상 해제" }).click({ force: true });

      await flowPage.getByRole("button", { name: "자유 응답" }).click({ force: true });
      await flowPage.waitForSelector('[data-testid="pas-instruction-target"]', { state: "visible" });
      await flowPage.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "PAS 메시지");
      const textarea = flowPage.locator('textarea[aria-label="PAS 메시지"]');
      await textarea.fill("7일 유지를 기본으로 두겠습니다");
      await textarea.press("Enter");
      await flowPage.waitForFunction(() => document.querySelector("#pas-sheet-title")?.textContent?.includes("#1512"));
      assert.equal(await pendingCount(flowPage), 4);
      return "추천 선택지 주 강조, 선택 즉시 처분과 되돌리기, 되묻기와 자유 응답 칩";
    });

    await step("B9 영수증은 흐름 안, 주 단추와 겹치지 않음", async () => {
      await primary(flowPage, "저녁에 재확인");
      assert.equal(await pendingCount(flowPage), 3);
      assert.match(await sheetTitle(flowPage), /^#1387 /);
      await primary(flowPage, "폴더 문서로 남기고 완료");
      assert.equal(await pendingCount(flowPage), 2);
      assert.match(await sheetTitle(flowPage), /^#1408 /);
      const toast = flowPage.locator('[data-testid="pas-split-toast"]');
      await toast.waitFor({ state: "visible" });
      assert.match(await toast.innerText(), /#1387 폴더 문서로 남기고 완료했습니다/);
      const boxes = await flowPage.evaluate(() => {
        const toastElement = document.querySelector('[data-testid="pas-split-toast"]');
        const action = document.querySelector(".pas-sheet-actions button");
        const toastRect = toastElement.getBoundingClientRect();
        const actionRect = action.getBoundingClientRect();
        return {
          position: getComputedStyle(toastElement).position,
          toast: [toastRect.x, toastRect.y, toastRect.width, toastRect.height],
          action: [actionRect.x, actionRect.y, actionRect.width, actionRect.height],
          overlap: Math.min(toastRect.right, actionRect.right) - Math.max(toastRect.left, actionRect.left)
            > 0 && Math.min(toastRect.bottom, actionRect.bottom) - Math.max(toastRect.top, actionRect.top) > 0,
        };
      });
      assert.ok(!["absolute", "fixed"].includes(boxes.position), `영수증이 고정 오버레이입니다: ${boxes.position}`);
      assert.equal(boxes.overlap, false, `영수증이 주 단추를 가립니다: ${JSON.stringify(boxes)}`);
      await capture(flowPage, "08-1440-dark-inline-undo.png");
      return `영수증 ${JSON.stringify(boxes.toast)}, 주 단추 ${JSON.stringify(boxes.action)}, 겹침 없음`;
    });

    await step("R3 처분, 되돌리기, 폴더 문서 승격", async () => {
      await flowPage.getByRole("button", { name: "되돌리기" }).click({ force: true });
      await pause(100);
      assert.equal(await pendingCount(flowPage), 3);
      assert.match(await sheetTitle(flowPage), /^#1387 /);

      await primary(flowPage, "폴더 문서로 남기고 완료");
      assert.equal(await pendingCount(flowPage), 2);

      await primary(flowPage, "승인 완료");
      assert.equal(await pendingCount(flowPage), 1);
      assert.match(await sheetTitle(flowPage), /^#1112 /);

      await primary(flowPage, "3일 뒤 재확인");
      await flowPage.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      assert.equal(await pendingCount(flowPage), 0);
      assert.equal(await flowPage.locator(".pas-split-viewswitch button").first().isDisabled(), true);
      const character = flowPage.locator(".pas-quiet-character :is(img, iframe)").first();
      await character.waitFor({ state: "visible" });
      return "질문 응답, 부탁 검증 대기, 설계서 승격과 되돌리기, 구현 승인, 관찰 검증 대기 뒤 대화만 보기";
    });

    await step("B3 홈 숫자 요약 타일 제거와 세 탭", async () => {
      await openTaskDrawer(flowPage);
      const review = await groupText(flowPage, "review");
      const awaiting = await groupText(flowPage, "awaiting");
      const running = await groupText(flowPage, "running");
      assert.ok(review.includes("0개"), `검수 그룹이 비지 않았습니다: ${review}`);
      assert.ok(awaiting.includes("3개") && awaiting.includes("#1512") && awaiting.includes("#1112"), `검증 대기 그룹이 다릅니다: ${awaiting}`);
      assert.ok(running.includes("4개") && running.includes("#1680"), `진행 중 그룹이 다릅니다: ${running}`);
      assert.ok((await groupText(flowPage, "hold")).includes("18개"));
      await closeWithEscape(flowPage, '[data-testid="pas-task-drawer"]');

      await flowPage.locator(".pas-split-nav").getByRole("button", { name: "홈", exact: true }).click({ force: true });
      await flowPage.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
      const homeText = (await flowPage.locator('[data-testid="pas-home"]').innerText()).replace(/\s+/g, " ");
      assert.equal(await flowPage.locator(".pas-home-board-grid, .pas-home-summary").count(), 0,
        "홈 숫자 요약 타일이 남았습니다");
      assert.doesNotMatch(homeText, /미결재 \d+건/, "미결재 숫자 요약이 남았습니다");
      assert.doesNotMatch(homeText, /검수 \d+건/, "검수 숫자 요약이 남았습니다");
      const tabs = flowPage.locator(".pas-home-tabs [role=tab]");
      assert.equal(await tabs.count(), 3, "홈 탭이 세 개가 아닙니다");
      assert.equal(await flowPage.getByRole("tab", { name: "카드 목록" }).getAttribute("aria-selected"), "true");
      const cardsText = (await flowPage.locator("#pas-home-view-panel").innerText()).replace(/\s+/g, " ");
      await flowPage.getByRole("tab", { name: "폴더 문서" }).click({ force: true });
      await flowPage.waitForFunction(() => location.hash === "#folder-docs");
      const docsText = (await flowPage.locator("#pas-home-view-panel").innerText()).replace(/\s+/g, " ");
      assert.notEqual(cardsText, docsText, "폴더 문서 탭 내용이 카드 목록과 같습니다");
      assert.equal(await flowPage.locator('[data-testid="pas-home"]').getAttribute("data-focus"), "docs");
      await capture(flowPage, "09-1440-dark-home-docs.png");
      return "숫자 요약 타일 0, 탭 3개, 카드 목록과 폴더 문서 내용 변화";
    });

    await step("B5 폴더 문서 리더와 카드 작업대 열기", async () => {
      const docRows = flowPage.locator(".pas-home-doc-row");
      assert.equal(await docRows.count(), 3, "소울스트림 폴더 문서가 3건이 아닙니다");
      assert.ok((await docRows.allInnerTexts()).some(text => text.includes("턴 안 상호작용 3단계 도입 설계안")));
      const promoted = flowPage.locator('.pas-home-doc-row[data-document-id="doc-turn-interaction-design"]');
      await promoted.click({ force: true });
      await flowPage.locator('[data-testid="internal-document-dialog"]').waitFor({ state: "visible" });
      const dialogText = (await flowPage.locator('[data-testid="internal-document-dialog"]').innerText()).replace(/\s+/g, " ");
      assert.ok(dialogText.includes("턴 안 상호작용 3단계 도입 설계안"));
      assert.ok(dialogText.includes("접수") && dialogText.includes("분류") && dialogText.includes("실행"), "승격 문서 본문이 보이지 않습니다");
      await capture(flowPage, "10-1440-dark-document-reader.png");
      await closeWithEscape(flowPage, '[data-testid="internal-document-dialog"]');
      const focused = await active(flowPage);
      assert.equal(focused?.documentId, "doc-turn-interaction-design", `문서를 닫은 뒤 초점이 다릅니다: ${JSON.stringify(focused)}`);

      await flowPage.getByRole("tab", { name: "카드 목록" }).click({ force: true });
      await flowPage.waitForFunction(() => location.hash === "#home");
      const cardRows = flowPage.locator(".pas-home-card-row");
      assert.ok(await cardRows.count() > 0, "카드 목록이 비었습니다");
      await cardRows.first().click({ force: true });
      await flowPage.locator('[data-testid="v3-card-workspace"]').waitFor({ state: "visible" });
      await capture(flowPage, "11-1440-dark-card-workspace.png");
      await flowPage.getByRole("button", { name: "카드 닫기" }).click({ force: true });
      await flowPage.locator('[data-testid="v3-card-workspace"]').waitFor({ state: "hidden" });
      return "승격 문서 리더와 초점 복귀, 카드 행에서 정규 CardWorkspace 열기";
    });

    await step("B5 칸반 보드, 보류 18, 폴더 거르기, 에이전트 초상", async () => {
      await flowPage.getByRole("tab", { name: "칸반 보드" }).click({ force: true });
      await flowPage.waitForSelector(".v3-card-board", { state: "visible" });
      await pause(200);
      const hold = (await flowPage.locator('[data-board-column="on_hold"]').innerText()).replace(/\s+/g, " ").trim();
      assert.ok(hold.includes("18개"), `보류 열이 18개가 아닙니다: ${hold}`);
      for (const status of ["awaiting_verification", "running", "on_hold", "done"]) {
        assert.ok(await flowPage.locator(`[data-board-column="${status}"]`).count() > 0, `${status} 열이 없습니다`);
      }
      await capture(flowPage, "12-1440-dark-home-board.png");

      await flowPage.waitForFunction(() => [...document.querySelectorAll(".pas-home-board img")]
        .filter(image => image.complete && image.naturalWidth > 0).length >= 4);
      const portraits = await flowPage.evaluate(() => [...new Set([...document.querySelectorAll(".pas-home-board img")]
        .map(image => image.getAttribute("src"))
        .filter(src => Boolean(src)))]);
      assert.ok(portraits.length >= 4, `에이전트 초상이 구분되지 않습니다: ${JSON.stringify(portraits)}`);
      for (const file of ["roselin.png", "keke.png", "selaphiel.png", "characters/seosoyoung/still.png"]) {
        assert.ok(portraits.some(src => src.includes(file)), `${file} 초상이 없습니다: ${JSON.stringify(portraits)}`);
      }

      await flowPage.locator('[data-board-column="on_hold"] .v3-postit-open').first().click({ force: true });
      await flowPage.locator('[data-testid="v3-card-workspace"]').waitFor({ state: "visible" });
      await flowPage.getByRole("button", { name: "카드 닫기" }).click({ force: true });
      await flowPage.locator('[data-testid="v3-card-workspace"]').waitFor({ state: "hidden" });

      await flowPage.getByRole("button", { name: "🔮 kaleidoscope", exact: true }).click({ force: true });
      await pause(200);
      const filtered = (await flowPage.locator("#pas-home-view-panel").innerText()).replace(/\s+/g, " ");
      assert.ok(filtered.includes("사용량 앱"), `폴더 거르기 결과가 다릅니다: ${filtered.slice(0, 160)}`);
      assert.equal(await flowPage.locator('[data-board-column="on_hold"]').count(), 0,
        "다른 폴더에서 보류 카드가 남았습니다");

      await flowPage.getByRole("tab", { name: "폴더 문서" }).click({ force: true });
      await pause(150);
      assert.equal(await flowPage.locator(".pas-home-doc-row").count(), 1, "kaleidoscope 문서가 1건이 아닙니다");
      assert.ok((await flowPage.locator(".pas-home-doc-row").innerText()).includes("kaleidoscope 사용량 앱"));

      await flowPage.getByRole("tab", { name: "카드 목록" }).click({ force: true });
      await pause(150);
      assert.equal(await flowPage.locator(".pas-home-card-row").count(), 2, "kaleidoscope 카드가 2건이 아닙니다");
      assert.ok((await flowPage.locator("#pas-home-view-panel").innerText()).includes("사용량 앱"));

      await flowPage.getByRole("button", { name: "✨ 소울스트림", exact: true }).click({ force: true });
      await flowPage.getByRole("tab", { name: "칸반 보드" }).click({ force: true });
      await flowPage.waitForSelector('[data-board-column="on_hold"]', { state: "visible" });
      return `보류 18, 네 열, 초상 ${portraits.length}종, 카드 작업대, kaleidoscope 거르기`;
    });

    await step("홈과 카드 작업대 응답 없는 호출 0", async () => {
      const report = await unmocked(flowPage);
      unmockedReports.flow = report;
      assert.deepEqual(report, []);
      return "STREAM 제외 0건";
    });

    await flowContext.close();

    const mobileContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const mobilePage = await mobileContext.newPage();

    await step("B1 1440, 820 검수 토글과 겹침 없음", async () => {
      const notes = [];
      for (const [width, height] of [[1440, 900], [820, 1180]]) {
        await open(mobilePage, { width, height, theme: "dark" });
        await installReviewToggle(mobilePage);
        notes.push(await assertNoToggleHits(mobilePage, `${width} PAS 서류판`));
        await mobilePage.locator(".pas-split-viewswitch button").nth(1).click({ force: true });
        await mobilePage.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
        notes.push(await assertNoToggleHits(mobilePage, `${width} PAS 대화만`));
        await mobilePage.locator(".pas-split-nav").getByRole("button", { name: "홈", exact: true }).click({ force: true });
        await mobilePage.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
        notes.push(await assertNoToggleHits(mobilePage, `${width} 홈 카드 목록`));
        await mobilePage.getByRole("tab", { name: "폴더 문서" }).click({ force: true });
        await pause(120);
        notes.push(await assertNoToggleHits(mobilePage, `${width} 홈 폴더 문서`));
        await mobilePage.getByRole("tab", { name: "칸반 보드" }).click({ force: true });
        await mobilePage.waitForSelector(".v3-card-board", { state: "visible" });
        await pause(150);
        notes.push(await assertNoToggleHits(mobilePage, `${width} 홈 칸반 보드`));
        await capture(mobilePage, `13-${width}-dark-home-board.png`);
      }
      return notes.join(", ");
    });

    await step("B1 390, 360 검수 토글과 겹침 없음", async () => {
      const notes = [];
      for (const [width, height, theme] of [[390, 844, "dark"], [360, 740, "light"]]) {
        await open(mobilePage, { width, height, theme });
        await installReviewToggle(mobilePage);
        notes.push(await assertNoToggleHits(mobilePage, `${width} PAS 서류판`));
        const composer = await mobilePage.locator('[data-testid="pas-composer"]').boundingBox();
        assert.ok(composer && height - (composer.y + composer.height) >= 60,
          `${width} 입력창이 안전 여백 위에 있지 않습니다: ${JSON.stringify(composer)}`);
        await mobilePage.locator(".pas-split-mobile-tabs").getByRole("tab", { name: /PAS 대화/ }).click({ force: true });
        await mobilePage.waitForSelector('.pas-split-body[data-mobile-tab="chat"]', { state: "visible" });
        notes.push(await assertNoToggleHits(mobilePage, `${width} PAS 대화`));
        await mobilePage.locator(".pas-split-nav").getByRole("button", { name: "홈", exact: true }).click({ force: true });
        await mobilePage.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
        notes.push(await assertNoToggleHits(mobilePage, `${width} 홈 카드 목록`));
        await mobilePage.getByRole("tab", { name: "폴더 문서" }).click({ force: true });
        await pause(120);
        notes.push(await assertNoToggleHits(mobilePage, `${width} 홈 폴더 문서`));
        await mobilePage.getByRole("tab", { name: "칸반 보드" }).click({ force: true });
        await mobilePage.waitForSelector(".v3-card-board", { state: "visible" });
        await pause(120);
        notes.push(await assertNoToggleHits(mobilePage, `${width} 홈 칸반 보드`));
        await capture(mobilePage, `14-${width}-${theme}-home-board.png`);
      }
      return notes.join(", ");
    });

    await step("B10 390 한국어 어절 중간 줄바꿈 없음", async () => {
      await open(mobilePage, { width: 390, height: 844, theme: "dark" });
      const targets = [".pas-sheet-excerpt", ".pas-check-text", ".pas-question-options button"];
      const notes = [];
      for (const selector of targets) {
        const report = await brokenWords(mobilePage, selector);
        assert.equal(report.missing, false, `${selector}가 없습니다`);
        assert.equal(report.broken.length, 0, `${selector} 어절 중간 줄바꿈: ${JSON.stringify(report.broken)}`);
        assert.equal(report.style.wordBreak, "keep-all", `${selector} word-break가 keep-all이 아닙니다`);
        assert.equal(report.style.overflowWrap, "break-word", `${selector} overflow-wrap이 break-word가 아닙니다`);
        if (selector.includes("question")) {
          assert.equal(report.style.whiteSpace, "normal", "선택지 단추가 줄바꿈되지 않습니다");
        }
        notes.push(`${selector} 정상`);
      }
      const labelStyle = await mobilePage.evaluate(() => {
        const label = document.querySelector(".pas-sheet-section h3");
        const scope = document.querySelector(".pas-split-app") ?? document.body;
        const probe = document.createElement("span");
        probe.style.color = "var(--v3-text-secondary)";
        scope.append(probe);
        const expected = getComputedStyle(probe).color;
        const actual = getComputedStyle(label);
        const result = { fontSize: actual.fontSize, color: actual.color, expected };
        probe.remove();
        return result;
      });
      assert.equal(labelStyle.fontSize, "12px", `확인 항목 라벨이 12px가 아닙니다: ${labelStyle.fontSize}`);
      assert.equal(labelStyle.color, labelStyle.expected, `확인 항목 라벨 색이 72%가 아닙니다: ${JSON.stringify(labelStyle)}`);
      await capture(mobilePage, "15-390-dark-word-break.png");
      return `${notes.join(", ")}, 라벨 12px 72%`;
    });

    await step("R5 390 모바일 탭과 안전 여백", async () => {
      await open(mobilePage, { width: 390, height: 844, theme: "dark" });
      const tabs = mobilePage.locator(".pas-split-mobile-tabs");
      await tabs.waitFor({ state: "visible" });
      assert.equal(await mobilePage.locator(".pas-split-viewswitch").isVisible(), false);
      assert.equal(await mobilePage.locator(".pas-clipboard-index > .dashboard-icon-cap").first().isVisible(), false,
        "좁은 화면에서 색인 화살표가 포커스 대상으로 남았습니다");
      const box = await mobilePage.locator('[data-testid="pas-composer"]').boundingBox();
      assert.ok(box && 844 - (box.y + box.height) >= 60, `입력창 안전 여백이 부족합니다: ${JSON.stringify(box)}`);
      await capture(mobilePage, "16-390-dark-board.png");
      await tabs.getByRole("tab", { name: /PAS 대화/ }).click({ force: true });
      await mobilePage.waitForSelector('.pas-split-body[data-mobile-tab="chat"]', { state: "visible" });
      assert.equal(await mobilePage.locator(".pas-split-clipboard").isVisible(), false);
      assert.equal(await mobilePage.locator('[data-testid="pas-composer"]').isVisible(), true,
        "대화 탭에서 입력창이 사라졌습니다");
      await capture(mobilePage, "17-390-dark-chat.png");
      return await assertNoOverflow(mobilePage, "390 dark");
    });

    await step("R5 360과 820, 넘침 없음", async () => {
      await open(mobilePage, { width: 360, height: 800, theme: "light" });
      const at360 = await assertNoOverflow(mobilePage, "360 light");
      await capture(mobilePage, "18-360-light-board.png");
      await mobilePage.evaluate(() => {
        const title = document.querySelector("#pas-sheet-title");
        const check = document.querySelector(".pas-check-text");
        if (title) title.textContent = "긴 제목".repeat(80);
        if (check) check.textContent = "긴확인항목".repeat(120);
      });
      const stressed = await assertNoOverflow(mobilePage, "360 light 긴 글");
      await capture(mobilePage, "18b-360-light-stress.png");

      await open(mobilePage, { width: 820, height: 1080, theme: "dark" });
      const at820 = await assertNoOverflow(mobilePage, "820 dark");
      const columns = await mobilePage.locator(".pas-split-body").evaluate(
        element => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
      );
      assert.equal(columns, 2, `820에서 2단이 아닙니다: ${columns}`);
      await capture(mobilePage, "19-820-dark-board.png");
      return `${at360}, ${stressed}, ${at820}`;
    });
    await mobileContext.close();

    const resizeContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const resizePage = await resizeContext.newPage();
    await step("ui 18 창 크기 바꾸기", async () => {
      await openQuiet(resizePage, { width: 1440, height: 620, theme: "dark" });
      const textarea = resizePage.locator('textarea[aria-label="PAS 메시지"]');
      const longLine = "창 크기 확인 문장을 길게 남겨 대화 목록이 넘치도록 합니다. ";
      for (let index = 0; index < 5; index += 1) {
        await textarea.fill(`${index + 1}. ${longLine.repeat(8)}`);
        await textarea.press("Enter");
      }
      await resizePage.waitForFunction(() => {
        const list = document.querySelector(".pas-split-messages");
        return Boolean(list && list.scrollHeight > list.clientHeight + 40);
      });
      await resizePage.evaluate(() => {
        const list = document.querySelector(".pas-split-messages");
        if (list) list.scrollTop = 120;
      });
      const before = await resizePage.evaluate(() => document.querySelector(".pas-split-messages")?.scrollTop ?? 0);
      assert.ok(before > 0, "대화 목록이 스크롤되지 않았습니다");
      await textarea.fill("초안을 남겨 둡니다");
      await resizePage.setViewportSize({ width: 390, height: 844 });
      await pause(200);
      assert.equal(await textarea.inputValue(), "초안을 남겨 둡니다");
      const narrow = await resizePage.evaluate(() => document.querySelector(".pas-split-messages")?.scrollTop ?? 0);
      assert.ok(narrow > 0, "좁은 폭에서 스크롤 위치가 초기화됐습니다");
      await resizePage.setViewportSize({ width: 1440, height: 620 });
      await pause(200);
      assert.equal(await textarea.inputValue(), "초안을 남겨 둡니다");
      const wide = await resizePage.evaluate(() => document.querySelector(".pas-split-messages")?.scrollTop ?? 0);
      assert.ok(wide > 0, "넓은 폭으로 돌아온 뒤 스크롤 위치가 초기화됐습니다");
      await capture(resizePage, "20-1440-dark-resize-restored.png");
      return `스크롤 ${Math.round(before)}px 유지, 입력 글 유지`;
    });
    await resizeContext.close();

    const errorContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const errorPage = await errorContext.newPage();
    await step("ui 17 문서 실패 안내와 다시 열기", async () => {
      await openRoute(errorPage, { width: 1440, height: 900, theme: "dark", hash: "folder-docs" });
      await errorPage.evaluate(() => {
        const original = window.fetch;
        window.__pasSplitOriginalFetch = original;
        window.fetch = async (input, init) => {
          if (String(input).includes("/api/markdown-documents/")) {
            return new Response(JSON.stringify({ error: "mockup failure" }), {
              status: 500, headers: { "Content-Type": "application/json" },
            });
          }
          return original(input, init);
        };
      });
      await errorPage.locator('.pas-home-doc-row[data-document-id="doc-pas-approval-notes"]').click({ force: true });
      await errorPage.locator('[data-testid="internal-document-dialog"]').waitFor({ state: "visible" });
      await errorPage.waitForFunction(() => document.body.textContent?.includes("문서를 불러오지 못했습니다"));
      await capture(errorPage, "21-1440-dark-reader-error.png");
      await closeWithEscape(errorPage, '[data-testid="internal-document-dialog"]');
      await errorPage.evaluate(() => {
        if (window.__pasSplitOriginalFetch) window.fetch = window.__pasSplitOriginalFetch;
      });
      await errorPage.locator('.pas-home-doc-row[data-document-id="doc-pas-approval-notes"]').click({ force: true });
      await errorPage.locator('[data-testid="internal-document-dialog"]').waitFor({ state: "visible" });
      await errorPage.waitForFunction(() => document.body.textContent?.includes("PAS 결재 뷰 요구 정리"));
      const text = (await errorPage.locator('[data-testid="internal-document-dialog"]').innerText()).replace(/\s+/g, " ");
      assert.ok(text.includes("다시") || text.includes("요구") || text.includes("배경"), "다시 연 문서가 비어 있습니다");
      await closeWithEscape(errorPage, '[data-testid="internal-document-dialog"]');
      return "실패 안내 뒤 닫고 다시 열면 본문이 뜹니다";
    });
    await errorContext.close();

    const allErrors = [...pageErrors, ...flowErrors];
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
};
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log("");
for (const result of failed) console.log(`FAIL  ${result.id}  ${result.error}`);
console.log(`pas-approval-split-1707: ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(`summary ${join(output, "summary.json")}`);
if (failed.length > 0) process.exitCode = 1;
