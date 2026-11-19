#!/usr/bin/env node
/**
 * 카드 #1707 시안 A, PAS 강화형 결재 브리핑 갑지의 시각 검수.
 *
 * 빌드된 정적 묶음(dist-mockups/pas-report-1707-briefing)을 그 자리에서 서빙하고
 * 실제 Chromium으로 R1~R5와 ui-design 0절 14~18번을 조작해 확인한다.
 * 네 폭과 두 테마에서 넘침, 발행 페이지 고정 코멘트 자리와의 겹침, 입력 여백을 재고,
 * 말풍선에서 결재 창을 열어 다섯 안건을 차례로 처분하며 좌표와 상태를 확인한다.
 *
 * 실행:
 *   MOCKUP=pas-report-1707-briefing ./node_modules/.bin/vite build --config vite.mockup.config.ts
 *   node e2e/pas-report-1707-briefing.qa.mjs
 *
 * 캡처는 기본으로 /home/eias/workspace/.local/artifacts/pas-report-1707-briefing 에 쓴다.
 * PAS_REPORT_OUTPUT 으로 바꿀 수 있다.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = resolve(here, "..");
const distDir = resolve(dashboardDir, "dist-mockups", "pas-report-1707-briefing");
const output = process.env.PAS_REPORT_OUTPUT
  ?? "/home/eias/workspace/.local/artifacts/pas-report-1707-briefing";
if (!existsSync(join(distDir, "frame.html"))) {
  throw new Error(`묶음이 없습니다: ${distDir}\nMOCKUP=pas-report-1707-briefing vite build --config vite.mockup.config.ts 를 먼저 실행하세요.`);
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

const glassQuery = glass => glass === "css" ? "&glass=css" : "";
let navigationSerial = 0;

async function openRoute(page, { width, height, theme, hash, glass = "css" }) {
  navigationSerial += 1;
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/frame.html?theme=${theme}${glassQuery(glass)}&qa=${navigationSerial}#${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-rb-screen"]', { state: "visible" });
  if (hash === "report") {
    await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "visible" });
  } else {
    await page.waitForSelector('[data-testid="pas-rb-bubble"], [data-testid="pas-rb-complete"]', { state: "visible" });
  }
  await page.evaluate(() => document.fonts.ready);
  await pause(220);
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  assert.equal(dark, theme === "dark", `테마 클래스가 ${theme}와 다릅니다`);
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
      text: (element.textContent || "").trim().slice(0, 40),
      className: typeof element.className === "string" ? element.className.slice(0, 80) : "",
    };
  });
}

async function overflowReport(page) {
  return page.evaluate(() => {
    const app = document.querySelector('[data-testid="pas-rb-screen"]');
    const root = document.documentElement;
    const offenders = [];
    const inScrollArea = element => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) return true;
      }
      return false;
    };
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (element.closest(".wallpaper-layer")) continue;
      if (inScrollArea(element)) continue;
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

async function inputPaddingReport(page) {
  return page.evaluate(() => {
    const rows = [];
    for (const element of document.querySelectorAll("input:not([type=hidden]), textarea")) {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      rows.push({
        testid: element.getAttribute("data-testid"),
        name: element.getAttribute("aria-label") || element.getAttribute("placeholder") || "",
        top: Number.parseFloat(style.paddingTop),
        bottom: Number.parseFloat(style.paddingBottom),
      });
    }
    return rows;
  });
}

async function assertSymmetricInputPadding(page, label) {
  const rows = await inputPaddingReport(page);
  const bad = rows.filter(row => Math.abs(row.top - row.bottom) > 0.6);
  assert.equal(bad.length, 0, `${label} 입력 상자 위아래 여백 불균형: ${JSON.stringify(bad)}`);
  return `${label} 입력 여백 대칭 ${rows.length}개`;
}

async function installReviewRegion(page) {
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
      "position:fixed", "right:0", "bottom:0", "width:120px", "height:72px",
      "border:0", "border-radius:16px", "background:#111", "color:#fff",
      "font-size:14px", "font-weight:700", "z-index:2147483647",
    ].join(";");
    root.append(toggle);
    document.body.append(host);
  });
  await pause(40);
}

async function reviewRegionHits(page) {
  return page.evaluate(() => {
    const host = document.getElementById("pages-review");
    const toggle = host?.shadowRoot?.querySelector("#toggle");
    if (!toggle) return { error: "no-toggle", hits: [] };
    const rect = toggle.getBoundingClientRect();
    const selector = "button, a, input, textarea, [role=button], [role=tab], select, .pas-rb-foot, .pas-rb-bubble, .pas-rb-dialog, .persistent-session-task-toggle, .persistent-session-tasks, .persistent-session-character-toggle";
    const describe = element => {
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className.slice(0, 60) : "",
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
    toggle.style.visibility = "hidden";
    const hits = new Map();
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
    return {
      toggle: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      hits: [...hits.values()],
    };
  });
}

async function assertNoReviewRegionHits(page, label) {
  await installReviewRegion(page);
  const report = await reviewRegionHits(page);
  assert.ok(!report.error, `${label} 검토 자리 없음`);
  assert.equal(report.hits.length, 0, `${label} 고정 코멘트 자리 겹침: ${JSON.stringify(report.hits)}`);
  await page.evaluate(() => document.getElementById("pages-review")?.remove());
  return `${label} 겹침 없음`;
}

async function messageCount(page) {
  return page.locator('[data-slot="chat-manuscript-message"]').count();
}

async function bubbleCount(page) {
  return (await page.locator(".pas-rb-bubble-count").innerText()).replace(/\s+/g, " ").trim();
}

async function dialogTop(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector(".pas-rb-scroll");
    if (scroll) scroll.scrollTop = 0;
    const pick = selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? Math.round(box.top * 10) / 10 : null;
    };
    return {
      title: pick("#pas-rb-dialog-title"),
      stamp: pick('[data-testid="pas-rb-stamp-row"] button'),
      foot: pick('[data-testid="pas-rb-foot"]'),
    };
  });
}

async function navigateAgenda(page, number) {
  await page.locator('[data-testid="pas-rb-pill"]', { hasText: `#${number}` }).click();
  await page.waitForFunction(value => {
    const head = document.querySelector('[data-testid="pas-rb-agenda"]');
    return head?.getAttribute("data-number") === String(value);
  }, number);
  await pause(120);
}

async function assertDialogInsideViewport(page, label) {
  const box = await page.evaluate(() => {
    const rect = document.querySelector('[data-testid="pas-rb-dialog"]')?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
  });
  assert.ok(box, `${label} 결재 창이 없습니다`);
  assert.ok(box.left >= -1 && box.top >= -1, `${label} 창이 화면 밖: ${JSON.stringify(box)}`);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  assert.ok(box.right <= viewport.width + 1 && box.bottom <= viewport.height + 1, `${label} 창이 화면 밖: ${JSON.stringify(box)}`);
  assert.ok(box.bottom <= viewport.height - 72, `${label} 창 아래가 고정 코멘트 자리에 닿음: ${JSON.stringify(box)}`);
  return `${label} 창 안 ${Math.round(box.right)}x${Math.round(box.bottom)}`;
}

async function scanForbiddenText() {
  const roots = [
    join(dashboardDir, "client", "v3", "pas-report-briefing-1707"),
    join(dashboardDir, "mockups", "pas-report-1707-briefing"),
    join(dashboardDir, "mockups", "_shell"),
  ];
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if ([".ts", ".tsx", ".css", ".html", ".json", ".md"].includes(extname(path))) files.push(path);
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  files.push(join(dashboardDir, "e2e", "pas-report-1707-briefing.qa.mjs"));
  const middleDot = String.fromCharCode(0x00b7);
  const enDash = String.fromCharCode(0x2013);
  const emDash = String.fromCharCode(0x2014);
  const horizontalBar = String.fromCharCode(0x2015);
  const bannedWord = /박(?:다|았|아|는|고|음|지|혀|힌|힐|힘|인|여|였|을|은|세|습)/;
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if ([middleDot, enDash, emDash, horizontalBar].some(character => line.includes(character))) {
        findings.push(`${file}:${index + 1}: 금지 문장 부호`);
      }
      if (/^[ \t]*-{3,}[ \t]*$/.test(line)) findings.push(`${file}:${index + 1}: 가로줄`);
      if (bannedWord.test(line)) findings.push(`${file}:${index + 1}: 금지 어휘`);
    });
  }
  assert.equal(findings.length, 0, `금지 문구 ${JSON.stringify(findings.slice(0, 10))}`);
  return `${files.length}개 파일 문구 이상 없음`;
}

async function imageReport(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("img")].map(image => ({
      src: image.getAttribute("src") ?? "",
      complete: image.complete,
      naturalWidth: image.naturalWidth,
    }));
    const portraits = [...new Set(rows
      .filter(row => /portraits|characters/.test(row.src))
      .map(row => row.src))];
    return { rows, portraits };
  });
}

const { server, base } = await startStaticServer();
console.log(`묶음 ${distDir}`);
console.log(`서빙 ${base}`);
console.log(`캡처 ${output}`);

try {
  await runPlaywrightLifecycle({
    lockName: "pas-report-1707-briefing",
    timeoutMs: 585_000,
    launchBrowser: options => chromium.launch({ ...options, executablePath }),
  }, async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await step("D1 네 폭 두 테마 화면과 겹침", async () => {
      const summaries = [];
      for (const [width, height] of [[1440, 900], [820, 1180], [390, 844], [360, 780]]) {
        for (const theme of ["dark", "light"]) {
          await openRoute(page, { width, height, theme, hash: "pas" });
          assert.equal(await page.locator("body").innerText().then(text => text.includes("세션 중단")), false, `${width} ${theme} 세션 중단 노출`);
          summaries.push(await assertNoOverflow(page, `${width} ${theme} PAS`));
          summaries.push(await assertSymmetricInputPadding(page, `${width} ${theme} PAS`));
          summaries.push(await assertNoReviewRegionHits(page, `${width} ${theme} PAS`));
          await capture(page, `pas-${width}-${theme}.png`);

          await openRoute(page, { width, height, theme, hash: "report" });
          summaries.push(await assertNoOverflow(page, `${width} ${theme} 결재 창`));
          summaries.push(await assertSymmetricInputPadding(page, `${width} ${theme} 결재 창`));
          summaries.push(await assertNoReviewRegionHits(page, `${width} ${theme} 결재 창`));
          summaries.push(await assertDialogInsideViewport(page, `${width} ${theme}`));
          await capture(page, `report-${width}-${theme}.png`);

          await openRoute(page, { width, height, theme, hash: "pas" });
          await page.getByRole("button", { name: "작업 목록", exact: true }).click();
          await page.waitForSelector('[data-testid="pas-rb-tasks"]', { state: "visible" });
          summaries.push(await assertNoOverflow(page, `${width} ${theme} 작업 목록`));
          summaries.push(await assertNoReviewRegionHits(page, `${width} ${theme} 작업 목록`));
          const meta = await page.locator(".pas-rb-drawer-meta").innerText();
          assert.ok(meta.includes("보류함 18개 (변동 없음)"), `${width} ${theme} 보류함 줄: ${meta}`);
        }
      }
      return summaries.slice(-3).join(", ");
    });

    await step("D2 요청 응답과 초상", async () => {
      await openRoute(page, { width: 1440, height: 900, theme: "dark", hash: "pas" });
      assert.deepEqual(await unmocked(page), [], "PAS 진입 미등록 요청");
      await page.getByTestId("pas-rb-open").click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "visible" });
      for (const number of [1680, 1512, 1387, 1408, 1112]) {
        await navigateAgenda(page, number);
        await page.waitForFunction(() => [...document.querySelectorAll("img")].every(image => image.complete));
        await pause(80);
      }
      await page.getByRole("button", { name: "보고 창 닫기" }).click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "hidden" });
      await page.getByRole("button", { name: "작업 목록", exact: true }).click();
      await page.waitForSelector('[data-testid="pas-rb-tasks"]', { state: "visible" });
      await page.waitForFunction(() => [...document.querySelectorAll("img")].every(image => image.complete));
      const report = await imageReport(page);
      assert.ok(report.rows.length > 0, "그림이 없습니다");
      const broken = report.rows.filter(row => !row.complete || row.naturalWidth <= 0);
      assert.equal(broken.length, 0, `깨진 그림: ${JSON.stringify(broken)}`);
      assert.ok(report.portraits.length >= 4, `서로 다른 초상이 ${report.portraits.length}개뿐입니다: ${JSON.stringify(report.portraits)}`);
      const requests = await unmocked(page);
      unmockedReports.d2 = requests;
      assert.deepEqual(requests, [], "미등록 요청");
      return `그림 ${report.rows.length}개, 초상 ${report.portraits.length}개`;
    });

    await step("D2b 근거 확대와 좁은 폭", async () => {
      await openRoute(page, { width: 1440, height: 900, theme: "dark", hash: "report" });
      const inline = await page.locator('[data-testid="pas-rb-agenda"] .pas-rb-figure').first().boundingBox();
      await page.getByRole("button", { name: "근거 자료 크게 보기" }).first().click();
      await page.waitForSelector('[data-testid="pas-rb-evidence-dialog"]', { state: "visible" });
      const large = await page.locator('[data-testid="pas-rb-evidence-dialog"] .pas-rb-figure').first().boundingBox();
      assert.ok(inline && large && large.width >= inline.width + 40, `근거 확대 폭 ${inline?.width} ${large?.width}`);
      await capture(page, "09b-evidence-1440.png");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-rb-evidence-dialog"]', { state: "hidden" });

      await openRoute(page, { width: 360, height: 780, theme: "light", hash: "report" });
      await page.getByRole("button", { name: "근거 자료 크게 보기" }).first().click();
      await page.waitForSelector('[data-testid="pas-rb-evidence-dialog"]', { state: "visible" });
      await assertNoOverflow(page, "360 근거 창");
      await assertNoReviewRegionHits(page, "360 근거 창");
      await capture(page, "09c-evidence-360.png");
      await page.keyboard.press("Escape");
      return `근거 폭 ${Math.round(inline?.width ?? 0)}에서 ${Math.round(large?.width ?? 0)}`;
    });

    await step("D3 말풍선 열기와 초점", async () => {
      await openRoute(page, { width: 1440, height: 900, theme: "dark", hash: "pas" });
      assert.ok((await bubbleCount(page)) === "1 / 5", `말풍선 ${await bubbleCount(page)}`);
      assert.ok((await page.locator('[data-testid="pas-rb-bubble"]').innerText()).includes("#1680"), "말풍선에 안건 번호 없음");
      await page.getByTestId("pas-rb-open").click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "visible" });
      await page.waitForFunction(() => window.location.hash === "#report");
      assert.equal((await page.getByTestId("pas-rb-count").innerText()).replace(/\s+/g, " ").trim(), "1 / 5");
      const focused = await active(page);
      assert.equal(focused?.testid, "pas-rb-input", `열린 뒤 초점 ${JSON.stringify(focused)}`);
      await capture(page, "10-report-1680-before.png");
    });

    await step("D3b 발행 주소로 결재 창 열기", async () => {
      navigationSerial += 1;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/index.html?theme=dark&glass=css&qa=${navigationSerial}&view=report`, { waitUntil: "domcontentloaded" });
      const frame = page.frameLocator("iframe");
      await frame.locator('[data-testid="pas-rb-dialog"]').waitFor({ state: "visible" });
      assert.ok((await frame.locator('[data-testid="pas-rb-count"]').innerText()).includes("1 / 5"), "view=report로 열리지 않음");
      await capture(page, "09a-host-view-report.png");

      navigationSerial += 1;
      await page.goto(`${base}/index.html?theme=light&glass=css&qa=${navigationSerial}#report`, { waitUntil: "domcontentloaded" });
      const hashFrame = page.frameLocator("iframe");
      await hashFrame.locator('[data-testid="pas-rb-dialog"]').waitFor({ state: "visible" });
      await capture(page, "09a-host-hash-report.png");
      return "view=report와 부모 #report";
    });

    await step("D4 질문 선택지 처분과 되돌리기", async () => {
      await openRoute(page, { width: 1440, height: 900, theme: "dark", hash: "pas" });
      assert.equal(await messageCount(page), 4);
      await page.getByTestId("pas-rb-open").click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "visible" });
      const beforeOpen = await dialogTop(page);
      await page.getByTestId("pas-rb-dialog").getByRole("button", { name: /최근 7일/ }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("최근 7일 기준으로 정했습니다."));
      await pause(140);
      const focusAfterChoose = await active(page);
      assert.equal(focusAfterChoose?.testid, "pas-rb-status-line", `선택지 처분 뒤 초점 ${JSON.stringify(focusAfterChoose)}`);
      const after = await dialogTop(page);
      assert.ok(Math.abs(after.title - beforeOpen.title) <= 1, `처분 전후 제목 Y ${beforeOpen.title} ${after.title}`);
      assert.ok(Math.abs(after.stamp - beforeOpen.stamp) <= 1, `처분 전후 단추 Y ${beforeOpen.stamp} ${after.stamp}`);
      assert.ok(await page.getByTestId("pas-rb-undo").isVisible(), "되돌리기 없음");
      await capture(page, "11-report-1680-after.png");
      await page.getByRole("button", { name: "보고 창 닫기" }).click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "hidden" });
      await page.waitForFunction(() => window.location.hash === "#pas");
      await pause(140);
      const focusAfterClose = await active(page);
      assert.equal(focusAfterClose?.testid, "pas-rb-open", `닫은 뒤 초점 ${JSON.stringify(focusAfterClose)}`);
      assert.equal(await messageCount(page), 6, "처분 뒤 대화 줄 수");
      assert.equal(await bubbleCount(page), "1 / 4", "처분 뒤 말풍선 수");
      await capture(page, "12-pas-after-question.png");
      await page.locator(".pas-rb-bubble-title").click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "visible" });
      await pause(500);
      await page.getByTestId("pas-rb-undo").click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("최근 7일 기준으로 정했습니다."));
      const afterUndo = await dialogTop(page);
      assert.ok(Math.abs(afterUndo.title - beforeOpen.title) <= 1, `되돌린 뒤 제목 Y ${beforeOpen.title} ${afterUndo.title}`);
      assert.ok(Math.abs(afterUndo.stamp - beforeOpen.stamp) <= 1, `되돌린 뒤 단추 Y ${beforeOpen.stamp} ${afterUndo.stamp}`);
      await pause(140);
      const focusAfterUndo = await active(page);
      assert.equal(focusAfterUndo?.testid, "pas-rb-input", `되돌린 뒤 초점 ${JSON.stringify(focusAfterUndo)}`);
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "hidden" });
      await pause(140);
      const focusAfterEscape = await active(page);
      assert.equal(focusAfterEscape?.testid, "pas-rb-open", `Esc 뒤 초점 ${JSON.stringify(focusAfterEscape)}`);
      assert.equal(await messageCount(page), 4, "되돌린 뒤 대화 줄 수");
      assert.equal(await bubbleCount(page), "1 / 5", "되돌린 뒤 말풍선 수");
      await capture(page, "13-pas-after-undo.png");
      return `제목 ${beforeOpen.title} 단추 ${beforeOpen.stamp}`;
    });

    await step("D5 열다섯 초 뒤 좌표와 안건 이어 처분", async () => {
      await page.getByTestId("pas-rb-open").click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "visible" });
      const beforeOpen = await dialogTop(page);
      await page.getByTestId("pas-rb-dialog").getByRole("button", { name: /최근 7일/ }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("최근 7일 기준으로 정했습니다."));
      await pause(15_600);
      assert.equal(await page.getByTestId("pas-rb-undo").isVisible(), false, "만료 뒤 되돌리기 남음");
      const afterExpiry = await dialogTop(page);
      assert.ok(Math.abs(afterExpiry.title - beforeOpen.title) <= 1, `만료 뒤 제목 Y ${beforeOpen.title} ${afterExpiry.title}`);
      assert.ok(Math.abs(afterExpiry.stamp - beforeOpen.stamp) <= 1, `만료 뒤 단추 Y ${beforeOpen.stamp} ${afterExpiry.stamp}`);
      await capture(page, "14-report-undo-expired.png");

      await navigateAgenda(page, 1512);
      assert.ok((await page.locator("#pas-rb-dialog-title").innerText()).includes("집 PC"), "1512 제목");
      await page.getByRole("button", { name: "했어", exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("했어로 알렸습니다."));
      await pause(140);
      const focusAfterStamp = await active(page);
      assert.equal(focusAfterStamp?.testid, "pas-rb-status-line", `결재 도장 뒤 초점 ${JSON.stringify(focusAfterStamp)}`);
      assert.ok((await page.getByTestId("pas-rb-agenda").innerText()).includes("실행 중"), "1512 상태");
      await capture(page, "15-report-1512-running.png");
      return `기준 제목 ${beforeOpen.title} 단추 ${beforeOpen.stamp}`;
    });

    await step("D6 문서 열람, 초점 복귀, 실패 안내", async () => {
      await navigateAgenda(page, 1387);
      assert.ok((await page.locator("#pas-rb-dialog-title").innerText()).includes("턴 안 상호작용"), "1387 제목");
      const documentButton = page.getByRole("button", { name: "설계안 문서 열기" });
      await documentButton.click();
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "visible" });
      await page.waitForFunction(() => document.body.innerText.includes("1단계, 접수"));
      await capture(page, "16-document-1387.png");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "hidden" });
      await pause(140);
      assert.ok(await page.getByTestId("pas-rb-dialog").isVisible(), "문서를 닫자 결재 창도 닫힘");
      const focusAfterDocument = await active(page);
      assert.ok(focusAfterDocument?.tag === "BUTTON" && (focusAfterDocument.text ?? "").includes("설계안 문서 열기"), `문서 닫은 뒤 초점 ${JSON.stringify(focusAfterDocument)}`);

      await page.evaluate(() => {
        window.__pasReportRealFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
          if (url.includes("/api/markdown-documents/")) {
            return new Response(JSON.stringify({ error: "강제 실패" }), {
              status: 500, headers: { "Content-Type": "application/json" },
            });
          }
          return window.__pasReportRealFetch(input, init);
        };
      });
      await documentButton.click();
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "visible" });
      await page.waitForFunction(() => document.body.innerText.includes("문서를 불러오지 못했습니다"));
      await page.evaluate(() => { window.fetch = window.__pasReportRealFetch; });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "hidden" });
      await documentButton.click();
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "visible" });
      await page.waitForFunction(() => document.body.innerText.includes("1단계, 접수"));
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "hidden" });

      await page.getByRole("button", { name: "참고 문서로 남기고 완료" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("참고 문서로 남기고 완료했습니다."));
      assert.ok((await page.locator(".pas-rb-kicker").innerText()).includes("참고"), "1387 참고 배지");
      await capture(page, "17-report-1387-reference.png");
    });

    await step("D7 항목 지시와 관찰 보류", async () => {
      await navigateAgenda(page, 1408);
      assert.ok((await page.locator("#pas-rb-dialog-title").innerText()).includes("슬라이드"), "1408 제목");
      const firstCheckbox1408 = page.getByTestId("pas-rb-agenda").getByRole("checkbox").first();
      await firstCheckbox1408.check();
      assert.ok(await firstCheckbox1408.isChecked(), "1408 확인 항목이 켜지지 않음");
      await navigateAgenda(page, 1112);
      assert.equal(await page.getByTestId("pas-rb-agenda").getByRole("checkbox").first().isChecked(), false, "안건 사이 확인 상태가 샘");
      await navigateAgenda(page, 1408);
      assert.ok(await firstCheckbox1408.isChecked(), "돌아온 1408 확인 상태가 사라짐");
      await firstCheckbox1408.uncheck();
      await page.locator(".v3-card-check-item-target").first().click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("대상: 1번 항목"));
      await pause(140);
      const focused = await active(page);
      assert.equal(focused?.testid, "pas-rb-input", `항목 지시 초점 ${JSON.stringify(focused)}`);
      await page.getByTestId("pas-rb-input").fill("인쇄 미리보기 쪽 나눔도 확인해 주세요.");
      await page.getByTestId("pas-rb-dialog").getByRole("button", { name: "보내기", exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("1번 항목 지시를 보냈습니다."));
      await pause(140);
      const focusAfterInput = await active(page);
      assert.equal(focusAfterInput?.testid, "pas-rb-status-line", `지시를 보낸 뒤 초점 ${JSON.stringify(focusAfterInput)}`);
      assert.ok((await page.getByTestId("pas-rb-agenda").innerText()).includes("실행 중"), "1408 실행 중");
      await capture(page, "18-report-1408-running.png");

      await navigateAgenda(page, 1112);
      assert.ok((await page.locator("#pas-rb-dialog-title").innerText()).includes("할 일 앱"), "1112 제목");
      await page.getByRole("button", { name: "사흘 뒤 재확인", exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pas-rb-status-line"]')?.textContent?.includes("사흘 뒤 재확인으로 두었습니다."));
      assert.ok((await page.getByTestId("pas-rb-agenda").innerText()).includes("검증 대기"), "1112 검증 대기");
      await capture(page, "19-report-1112-awaiting.png");

      await page.getByRole("button", { name: "보고 창 닫기" }).click();
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "hidden" });
      await page.waitForSelector('[data-testid="pas-rb-complete"]', { state: "visible" });
      assert.ok((await page.getByTestId("pas-rb-complete").innerText()).includes("다섯 건을 모두 처분했습니다."), "완료 안내");
      assert.equal(await messageCount(page), 14, "다섯 처분 뒤 대화 줄 수");
      await pause(140);
      const completionFocus = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="pas-rb-complete"]')));
      assert.ok(completionFocus, "완료 안내로 초점이 가지 않음");
      await capture(page, "20-pas-complete.png");

      await page.getByRole("button", { name: "작업 목록", exact: true }).click();
      await page.waitForSelector('[data-testid="pas-rb-tasks"]', { state: "visible" });
      const meta = await page.locator(".pas-rb-drawer-meta").innerText();
      assert.ok(meta.includes("보류함 18개 (변동 없음)"), `보류함 ${meta}`);
      const runningText = await page.locator('[data-task-status-group="running"]').innerText();
      assert.ok(runningText.includes("1512") && runningText.includes("1408"), `실행 중 묶음 ${runningText}`);
      const awaitingText = await page.locator('[data-task-status-group="awaiting_verification"]').innerText();
      assert.ok(awaitingText.includes("1112"), `검증 대기 묶음 ${awaitingText}`);
      const doneText = await page.getByTestId("pas-rb-done-list").innerText();
      assert.ok(doneText.includes("1680") && doneText.includes("1387") && doneText.includes("참고"), `처분한 안건 ${doneText}`);
      await capture(page, "21-drawer-final.png");
      await page.getByRole("button", { name: "작업 목록 닫기" }).click();
      await page.waitForSelector('[data-testid="pas-rb-tasks"]', { state: "hidden" });
      await page.getByTestId("pas-rb-complete").getByRole("button", { name: "되돌리기", exact: true }).click();
      await page.waitForSelector('[data-testid="pas-rb-complete"]', { state: "hidden" });
      await page.waitForSelector('[data-testid="pas-rb-bubble"]', { state: "visible" });
      assert.equal(await messageCount(page), 12, "마지막 되돌리기 뒤 대화 줄 수");
      assert.equal(await bubbleCount(page), "1 / 1", "마지막 되돌리기 뒤 말풍선 수");
      await capture(page, "22-pas-last-undo.png");
    });

    await step("D8 창 크기 바꾸기와 입력 유지", async () => {
      await openRoute(page, { width: 1440, height: 900, theme: "dark", hash: "report" });
      await navigateAgenda(page, 1408);
      await page.getByTestId("pas-rb-input").fill("인쇄 미리보기 쪽 나눔도 확인해 주세요.");
      const beforeScroll = await page.evaluate(() => {
        const scroll = document.querySelector(".pas-rb-scroll");
        scroll.scrollTop = scroll.scrollHeight;
        return { top: scroll.scrollTop, height: scroll.scrollHeight };
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await pause(320);
      const valueAt390 = await page.getByTestId("pas-rb-input").inputValue();
      assert.equal(valueAt390, "인쇄 미리보기 쪽 나눔도 확인해 주세요.", "좁힌 뒤 입력 유지");
      const narrow = await page.evaluate(() => {
        const scroll = document.querySelector(".pas-rb-scroll");
        const rect = document.querySelector('[data-testid="pas-rb-dialog"]')?.getBoundingClientRect();
        return { top: scroll.scrollTop, bottom: rect?.bottom ?? 0, viewport: window.innerHeight };
      });
      assert.ok(narrow.top > 0, `좁힌 뒤 스크롤 위치 ${narrow.top}`);
      assert.ok(Math.abs(narrow.top - beforeScroll.top) <= 80, `스크롤 위치 보존 ${beforeScroll.top} ${narrow.top}`);
      assert.ok(narrow.bottom <= narrow.viewport - 72, `좁힌 뒤 창 아래 ${narrow.bottom}`);
      await assertNoOverflow(page, "390 리사이즈");
      await capture(page, "23-resize-390.png");
      await page.setViewportSize({ width: 1440, height: 900 });
      await pause(320);
      assert.equal(await page.getByTestId("pas-rb-input").inputValue(), "인쇄 미리보기 쪽 나눔도 확인해 주세요.", "넓힌 뒤 입력 유지");
      await assertNoOverflow(page, "1440 리사이즈");
      await capture(page, "24-resize-1440.png");
      return `스크롤 ${beforeScroll.top}에서 ${narrow.top}`;
    });

    await step("D9 Tab 순서와 초점 가둠", async () => {
      await openRoute(page, { width: 1440, height: 900, theme: "dark", hash: "report" });
      const order = [];
      for (let index = 0; index < 12; index += 1) {
        await page.keyboard.press("Tab");
        const state = await page.evaluate(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement)) return null;
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            label: element.getAttribute("aria-label") || (element.textContent || "").trim().slice(0, 24),
            visible: rect.width > 0 && rect.height > 0,
            hidden: Boolean(element.closest('[aria-hidden="true"]')),
            inDialog: Boolean(element.closest('[data-testid="pas-rb-dialog"]')),
          };
        });
        order.push(state);
        assert.ok(state?.visible, `Tab ${index + 1}번째가 보이지 않음: ${JSON.stringify(state)}`);
        assert.ok(!state?.hidden, `Tab ${index + 1}번째가 숨은 요소: ${JSON.stringify(state)}`);
      }
      assert.ok(order.slice(0, 6).every(state => state?.inDialog), `Tab 순서가 창 밖으로 나감: ${JSON.stringify(order)}`);
      const firstPill = page.locator('[data-testid="pas-rb-pill"]').first();
      await firstPill.focus();
      await page.keyboard.press("Shift+Tab");
      const wrapped = await active(page);
      assert.ok(wrapped?.tag === "BUTTON" || wrapped?.tag === "INPUT", `가둠 뒤 초점 ${JSON.stringify(wrapped)}`);
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="pas-rb-dialog"]')));
      assert.ok(inside, "Shift+Tab 뒤 초점이 창 밖");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-rb-dialog"]', { state: "hidden" });
      await pause(140);
      const back = await active(page);
      assert.equal(back?.testid, "pas-rb-open", `Esc 뒤 초점 ${JSON.stringify(back)}`);
    });

    await step("D10 금지 문구와 페이지 오류", async () => {
      const scan = await scanForbiddenText();
      assert.deepEqual(pageErrors, [], `페이지 오류 ${JSON.stringify(pageErrors)}`);
      assert.deepEqual(await unmocked(page), [], "마지막 미등록 요청");
      return scan;
    });
  });
} finally {
  writeFileSync(join(output, "summary.json"), JSON.stringify({ results, captures, unmockedReports, pageErrors: [] }, null, 2));
  await closeServer(server);
}

const failed = results.filter(result => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
console.log(`산출물 ${output}`);
if (failed.length > 0) {
  console.log(`실패 ${failed.map(result => result.id).join(", ")}`);
  process.exitCode = 1;
}
