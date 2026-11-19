#!/usr/bin/env node
/**
 * 시안 B, PAS 지휘실 2단 스플릿 시각 검수.
 *
 * 빌드된 정적 묶음(dist-mockups/pas-approval-1707-split)을 그 자리에서 서빙하고
 * 실제 Chromium으로 R1~R5와 ui-design 0절 14~18번을 조작해 확인한다.
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
  try {
    const detail = await callback();
    results.push({ id, pass: true, detail: detail ?? null });
    console.log(`PASS  ${id}${detail ? `  ${detail}` : ""}`);
  } catch (error) {
    results.push({ id, pass: false, error: error.message });
    console.log(`FAIL  ${id}  ${error.message}`);
  }
}

async function open(page, { width, height, theme }) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/frame.html?theme=${theme}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-split-app"]', { state: "visible" });
  await page.waitForSelector("#pas-sheet-title", { state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await pause(250);
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  assert.equal(dark, theme === "dark", `테마 클래스가 ${theme}와 다릅니다`);
}

async function openQuiet(page, { width, height, theme }) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/frame.html?theme=${theme}#pas-chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pas-split-app"]', { state: "visible" });
  await page.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await pause(250);
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

async function activeIsTextarea(page) {
  return page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "PAS 메시지");
}

async function sheetTitle(page) {
  return (await page.locator("#pas-sheet-title").innerText()).replace(/\s+/g, " ").trim();
}

async function tab(page, number) {
  await page.locator(".pas-clipboard-tab", { hasText: `#${number}` }).click();
  await page.waitForFunction(value => {
    const element = document.querySelector("#pas-sheet-title");
    return element?.textContent?.includes(`#${value}`);
  }, number);
}

async function primary(page, label) {
  await page.locator(".pas-sheet-actions").getByRole("button", { name: label }).click();
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
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
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

const { server, base } = await startStaticServer();
console.log(`묶음 ${distDir}`);
console.log(`서빙 ${base}`);
console.log(`캡처 ${output}`);

try {
  await runPlaywrightLifecycle({
    lockName: "pas-approval-split-1707",
    timeoutMs: 540_000,
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
      await nav.getByRole("button", { name: "홈", exact: true }).click();
      await page.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#home");
      await page.locator(".pas-home-subnav").getByRole("button", { name: "폴더 문서" }).click();
      await pause(120);
      assert.equal(new URL(page.url()).hash, "#folder-docs");
      assert.equal(await page.locator('[data-testid="pas-home"]').getAttribute("data-focus"), "docs");

      await nav.getByRole("button", { name: "PAS 지휘실" }).click();
      await page.waitForSelector(".pas-split-body", { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#pas");
      await page.locator(".pas-split-viewswitch button").nth(1).click();
      await page.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#pas-chat");
      await page.locator(".pas-split-viewswitch button").first().click();
      await page.waitForSelector('.pas-split-body[data-mode="board"]', { state: "visible" });
      assert.equal(new URL(page.url()).hash, "#pas");
      return "PAS 지휘실 기본, 홈/폴더 문서/PAS 대화 해시 왕복";
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
      await page.locator(".pas-evidence-trigger").click();
      await page.locator(".pas-split-evidence-dialog").waitFor({ state: "visible" });
      await capture(page, "02-1440-dark-evidence.png");
      await closeWithEscape(page, ".pas-split-evidence-dialog");
      const focused = await active(page);
      assert.ok(focused?.className.includes("pas-evidence-trigger"), `증거를 닫은 뒤 초점이 돌아오지 않았습니다: ${JSON.stringify(focused)}`);
      return "탭 5개, ArrowLeft/Right, 증거 대화상자 Esc 닫기와 초점 복귀";
    });

    await step("R2 확인 항목과 구두 지시 칩, 입력창 초점", async () => {
      await tab(page, 1408);
      const firstCheck = page.locator(".pas-check-row").first();
      await firstCheck.locator('input[type="checkbox"]').check();
      assert.equal(await firstCheck.getAttribute("data-done"), "true");
      await firstCheck.locator('input[type="checkbox"]').uncheck();
      assert.equal(await firstCheck.getAttribute("data-done"), null);

      await page.locator(".pas-check-row").nth(1).getByRole("button", { name: "구두 지시" }).click();
      await page.waitForSelector('[data-testid="pas-instruction-target"]', { state: "visible" });
      const targetText = (await page.locator('[data-testid="pas-instruction-target"]').innerText()).replace(/\s+/g, " ").trim();
      assert.ok(targetText.includes("전달 대상: #1408 2번 항목 보완 지시"), `칩 글자가 다릅니다: ${targetText}`);
      await pause(80);
      assert.ok(await activeIsTextarea(page), "구두 지시를 누른 뒤 입력창에 초점이 없습니다");
      await page.getByRole("button", { name: "전달 대상 해제" }).click();
      await page.waitForSelector('[data-testid="pas-instruction-target"]', { state: "hidden" });
      await pause(80);
      assert.ok(await activeIsTextarea(page), "칩을 지운 뒤 입력창에 초점이 없습니다");
      return "확인 항목 토글, 칩 표시와 해제, 입력창 초점";
    });

    await step("R2 IME 조합 Enter와 지시 전송", async () => {
      await tab(page, 1408);
      await page.locator(".pas-check-row").nth(1).getByRole("button", { name: "구두 지시" }).click();
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

    await step("R2 대화만 보기와 SwayCharacter", async () => {
      await page.locator(".pas-split-viewswitch button").nth(1).click();
      await page.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      const character = page.locator(".pas-quiet-character :is(img, iframe)").first();
      await character.waitFor({ state: "visible" });
      const box = await character.boundingBox();
      assert.ok(box && box.height > 200, `캐릭터가 서 있지 않습니다: ${JSON.stringify(box)}`);
      await capture(page, "04-1440-dark-quiet.png");
      return `SwayCharacter 높이 ${Math.round(box.height)}px`;
    });

    await context.close();

    const lightContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const lightPage = await lightContext.newPage();
    await step("라이트 테마 1440", async () => {
      await open(lightPage, { width: 1440, height: 900, theme: "light" });
      await capture(lightPage, "05-1440-light-board.png");
      await lightPage.locator(".pas-split-viewswitch button").nth(1).click();
      await lightPage.waitForSelector('.pas-split-body[data-mode="quiet"]', { state: "visible" });
      await capture(lightPage, "06-1440-light-quiet.png");
      return await assertNoOverflow(lightPage, "1440 light");
    });
    await lightContext.close();

    const flowPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    await step("R3 처분, 되돌리기, 폴더 문서 승격", async () => {
      await open(flowPage, { width: 1440, height: 900, theme: "dark" });

      await flowPage.locator(".pas-sheet-actions").getByRole("button", { name: "자유 응답" }).click();
      await flowPage.locator('textarea[aria-label="PAS 메시지"]').fill("7일 유지를 기본으로 두겠습니다");
      await flowPage.locator('textarea[aria-label="PAS 메시지"]').press("Enter");
      await pause(100);
      assert.equal(await pendingCount(flowPage), 4);
      assert.match(await sheetTitle(flowPage), /^#1512 /);

      await primary(flowPage, "저녁에 재확인");
      assert.equal(await pendingCount(flowPage), 3);
      assert.match(await sheetTitle(flowPage), /^#1387 /);

      await primary(flowPage, "폴더 문서로 남기고 완료");
      assert.equal(await pendingCount(flowPage), 2);
      assert.match(await sheetTitle(flowPage), /^#1408 /);
      assert.match(await flowPage.locator('[data-testid="pas-split-toast"]').innerText(), /#1387 폴더 문서로 남기고 완료했습니다/);
      await capture(flowPage, "07-1440-dark-toast.png");

      await flowPage.getByRole("button", { name: "되돌리기" }).click();
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

    await step("R4 작업 목록과 홈, 폴더 문서 리더", async () => {
      await openTaskDrawer(flowPage);
      const review = await groupText(flowPage, "review");
      const awaiting = await groupText(flowPage, "awaiting");
      const running = await groupText(flowPage, "running");
      assert.ok(review.includes("0개"), `검수 그룹이 비지 않았습니다: ${review}`);
      assert.ok(awaiting.includes("3개") && awaiting.includes("#1512") && awaiting.includes("#1112"), `검증 대기 그룹이 다릅니다: ${awaiting}`);
      assert.ok(running.includes("4개") && running.includes("#1680"), `진행 중 그룹이 다릅니다: ${running}`);
      assert.ok((await groupText(flowPage, "hold")).includes("18개"));
      await closeWithEscape(flowPage, '[data-testid="pas-task-drawer"]');

      await flowPage.locator(".pas-split-nav").getByRole("button", { name: "홈", exact: true }).click();
      await flowPage.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
      const docRows = flowPage.locator(".pas-home-doc-row");
      assert.equal(await docRows.count(), 3, "폴더 문서가 3건이 아닙니다");
      assert.ok((await docRows.allInnerTexts()).some(text => text.includes("턴 안 상호작용 3단계 도입 설계안")));
      const hold = (await flowPage.locator('[data-board-column="hold"]').innerText()).replace(/\s+/g, " ").trim();
      assert.ok(hold.includes("18"), `홈 보류가 18이 아닙니다: ${hold}`);
      await capture(flowPage, "08-1440-dark-home-docs.png");

      const promoted = flowPage.locator('.pas-home-doc-row[data-document-id="doc-turn-interaction-design"]');
      await promoted.click();
      await flowPage.locator('[data-testid="internal-document-dialog"]').waitFor({ state: "visible" });
      const dialogText = (await flowPage.locator('[data-testid="internal-document-dialog"]').innerText()).replace(/\s+/g, " ");
      assert.ok(dialogText.includes("턴 안 상호작용 3단계 도입 설계안"));
      assert.ok(dialogText.includes("접수") && dialogText.includes("분류") && dialogText.includes("실행"), "승격 문서 본문이 보이지 않습니다");
      await capture(flowPage, "09-1440-dark-document-reader.png");
      await closeWithEscape(flowPage, '[data-testid="internal-document-dialog"]');
      const focused = await active(flowPage);
      assert.equal(focused?.documentId, "doc-turn-interaction-design", `문서를 닫은 뒤 초점이 다릅니다: ${JSON.stringify(focused)}`);
      return "검수 0, 검증 대기 3, 진행 중 4, 보류 18, 폴더 문서 3건과 리더 초점 복귀";
    });

    await flowPage.close();

    const mobileContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const mobilePage = await mobileContext.newPage();
    await step("R5 390 모바일 탭과 하단 입력창", async () => {
      await open(mobilePage, { width: 390, height: 844, theme: "dark" });
      const tabs = mobilePage.locator(".pas-split-mobile-tabs");
      await tabs.waitFor({ state: "visible" });
      assert.equal(await mobilePage.locator(".pas-split-viewswitch").isVisible(), false);
      const box = await mobilePage.locator('[data-testid="pas-composer"]').boundingBox();
      assert.ok(box && Math.abs(box.y + box.height - 844) <= 12, `입력창이 바닥에 붙지 않았습니다: ${JSON.stringify(box)}`);
      await capture(mobilePage, "10-390-dark-board.png");
      await tabs.getByRole("tab", { name: /PAS 대화/ }).click();
      await mobilePage.waitForSelector('.pas-split-body[data-mobile-tab="chat"]', { state: "visible" });
      assert.equal(await mobilePage.locator(".pas-split-clipboard").isVisible(), false);
      await capture(mobilePage, "11-390-dark-chat.png");
      const chatBox = await mobilePage.locator('[data-testid="pas-composer"]').boundingBox();
      assert.ok(chatBox && Math.abs(chatBox.y + chatBox.height - 844) <= 12);
      return await assertNoOverflow(mobilePage, "390 dark");
    });

    await step("R5 360과 820, 넘침 없음", async () => {
      await open(mobilePage, { width: 360, height: 800, theme: "light" });
      const at360 = await assertNoOverflow(mobilePage, "360 light");
      await capture(mobilePage, "12-360-light-board.png");
      await mobilePage.evaluate(() => {
        const title = document.querySelector("#pas-sheet-title");
        const check = document.querySelector(".pas-check-text");
        if (title) title.textContent = "긴 제목".repeat(80);
        if (check) check.textContent = "긴확인항목".repeat(120);
      });
      const stressed = await assertNoOverflow(mobilePage, "360 light 긴 글");
      await capture(mobilePage, "12b-360-light-stress.png");

      await open(mobilePage, { width: 820, height: 1080, theme: "dark" });
      const at820 = await assertNoOverflow(mobilePage, "820 dark");
      const columns = await mobilePage.locator(".pas-split-body").evaluate(
        element => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
      );
      assert.equal(columns, 2, `820에서 2단이 아닙니다: ${columns}`);
      await capture(mobilePage, "13-820-dark-board.png");
      return `${at360}, ${stressed}, ${at820}`;
    });
    await mobileContext.close();

    const resizeContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const resizePage = await resizeContext.newPage();
    await step("ui 18 창 크기 바꾸기", async () => {
      await openQuiet(resizePage, { width: 1440, height: 900, theme: "dark" });
      const textarea = resizePage.locator('textarea[aria-label="PAS 메시지"]');
      for (let index = 0; index < 14; index += 1) {
        await textarea.fill(`창 크기 확인 메시지 ${index + 1}`);
        await textarea.press("Enter");
      }
      await resizePage.waitForFunction(() => document.querySelectorAll(".pas-split-message").length >= 18);
      await resizePage.evaluate(() => {
        const list = document.querySelector(".pas-split-messages");
        if (list) list.scrollTop = 220;
      });
      const before = await resizePage.evaluate(() => document.querySelector(".pas-split-messages")?.scrollTop ?? 0);
      assert.ok(before > 0, "대화 목록이 스크롤되지 않았습니다");
      await textarea.fill("초안을 남겨 둡니다");
      await resizePage.setViewportSize({ width: 390, height: 844 });
      await pause(200);
      assert.equal(await textarea.inputValue(), "초안을 남겨 둡니다");
      const narrow = await resizePage.evaluate(() => document.querySelector(".pas-split-messages")?.scrollTop ?? 0);
      assert.ok(narrow > 0, "좁은 폭에서 스크롤 위치가 초기화됐습니다");
      await resizePage.setViewportSize({ width: 1440, height: 900 });
      await pause(200);
      assert.equal(await textarea.inputValue(), "초안을 남겨 둡니다");
      const wide = await resizePage.evaluate(() => document.querySelector(".pas-split-messages")?.scrollTop ?? 0);
      assert.ok(wide > 0, "넓은 폭으로 돌아온 뒤 스크롤 위치가 초기화됐습니다");
      await capture(resizePage, "14-1440-dark-resize-restored.png");
      return `스크롤 ${Math.round(before)}px 유지, 입력 글 유지`;
    });
    await resizeContext.close();

    const errorContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    const errorPage = await errorContext.newPage();
    await step("ui 17 문서 실패 안내와 다시 열기", async () => {
      await open(errorPage, { width: 1440, height: 900, theme: "dark" });
      await errorPage.locator(".pas-split-nav").getByRole("button", { name: "홈", exact: true }).click();
      await errorPage.waitForSelector('[data-testid="pas-home"]', { state: "visible" });
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
      await errorPage.locator('.pas-home-doc-row[data-document-id="doc-pas-approval-notes"]').click();
      await errorPage.locator('[data-testid="internal-document-dialog"]').waitFor({ state: "visible" });
      await errorPage.waitForFunction(() => document.body.textContent?.includes("문서를 불러오지 못했습니다"));
      await capture(errorPage, "15-1440-dark-reader-error.png");
      await closeWithEscape(errorPage, '[data-testid="internal-document-dialog"]');
      await errorPage.evaluate(() => {
        if (window.__pasSplitOriginalFetch) window.fetch = window.__pasSplitOriginalFetch;
      });
      await errorPage.locator('.pas-home-doc-row[data-document-id="doc-pas-approval-notes"]').click();
      await errorPage.locator('[data-testid="internal-document-dialog"]').waitFor({ state: "visible" });
      await errorPage.waitForFunction(() => document.body.textContent?.includes("PAS 결재 뷰 요구 정리"));
      const text = (await errorPage.locator('[data-testid="internal-document-dialog"]').innerText()).replace(/\s+/g, " ");
      assert.ok(text.includes("다시") || text.includes("요구") || text.includes("배경"), "다시 연 문서가 비어 있습니다");
      await closeWithEscape(errorPage, '[data-testid="internal-document-dialog"]');
      return "실패 안내 뒤 닫고 다시 열면 본문이 뜹니다";
    });
    await errorContext.close();

    if (pageErrors.length > 0) {
      results.push({ id: "pageerror", pass: pageErrors.length === 0, detail: pageErrors });
      console.log(`WARN  pageerror ${pageErrors.length}건: ${pageErrors.slice(0, 3).join(" | ")}`);
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
