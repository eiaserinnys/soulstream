#!/usr/bin/env node
/**
 * 시안 C: PAS 시간순 통합 사건 스레드 QA.
 *
 * 빌드 결과(dist-mockups/pas-report-1707-thread)를 정적 서버로 띄우고, 네 화면 폭과
 * 두 테마에서 메인 PAS 화면과 보고 창을 찍고 잰다. 이어서 결재 흐름을 실제로 눌러
 * 질문 답, 보완 지시, 참고 보관, 재확인, 되돌리기, 문서 열람, 증거 확대, 작업 목록
 * 반영까지 확인한다.
 *
 * 실행:
 *   corepack pnpm@10.32.1 exec vite build --config vite.mockup.config.ts  (MOCKUP 필요)
 *   node e2e/pas-report-1707-thread.qa.mjs
 */
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(dashboardDir, "dist-mockups/pas-report-1707-thread");
const captureDir = process.env.PAS_RT1707_CAPTURE_DIR ?? resolve(dashboardDir, ".local/artifacts/pas-report-1707-thread");
const textExtensions = new Set([".ts", ".tsx", ".css", ".html", ".mjs", ".md", ".json"]);

const { runPlaywrightLifecycle } = await import("./playwright-lifecycle-harness.mjs");

if (!existsSync(join(distDir, "frame.html"))) {
  console.error(`빌드 결과가 없습니다: ${distDir}`);
  process.exit(1);
}
await mkdir(captureDir, { recursive: true });

const checks = [];
const startedAt = Date.now();
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  [${elapsed}s]${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}
async function check(name, fn) {
  try { record(name, true, await fn()); } catch (error) { record(name, false, { error: error.message }); }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  // 발행 호스트가 iframe 바깥 주소로 보고 창을 여는지 확인하는 검수용 껍데기.
  if (path === "/host.html") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html lang="ko"><body style="margin:0"><iframe src="/frame.html?theme=dark" title="시안 C" style="border:0;width:100vw;height:100vh"></iframe></body></html>');
    return;
  }
  const file = join(distDir, path === "/" ? "index.html" : path);
  if (!file.startsWith(distDir) || !existsSync(file)) { response.writeHead(404); response.end("not found"); return; }
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
  response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
  response.end(await readFile(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

let browserErrors = [];
async function newPage(browser, viewport, theme) {
  const page = await browser.newPage({ viewport, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: "reduce" });
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  return page;
}
async function gotoPas(page, theme) {
  await page.goto(`${base}/frame.html?theme=${theme}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="pas-report-thread-screen"]');
  await wait(500);
}
async function gotoReport(page, theme) {
  await page.goto(`${base}/frame.html?theme=${theme}#report`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="pas-report-thread-dialog"]');
  await wait(600);
}
const rect = (page, selector) => page.evaluate((sel) => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
}, selector);
const textOf = (page, selector) => page.evaluate((sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? null, selector);
const overflow = (page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
const unmocked = (page) => page.evaluate(() => (window.__mockupUnmocked ?? []).slice());
const region = (viewport) => ({ x: viewport.width - 120, y: viewport.height - 72, width: 120, height: 72 });
async function controlHits(page, viewport) {
  return page.evaluate(({ box }) => {
    const clips = (element, x, y) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!/(hidden|auto|scroll|clip)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) continue;
        const rect = node.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return true;
      }
      return false;
    };
    return [...document.querySelectorAll('button, a[href], input, textarea, select, [role="button"]')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, box.x), right = Math.min(rect.right, box.x + box.width);
        const top = Math.max(rect.top, box.y), bottom = Math.min(rect.bottom, box.y + box.height);
        if (right - left <= 0 || bottom - top <= 0) return null;
        const x = (left + right) / 2, y = (top + bottom) / 2;
        if (clips(element, x, y)) return null;
        return element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? element.tagName;
      })
      .filter(Boolean);
  }, { box: region(viewport) });
}
async function imageReport(page) {
  return page.evaluate(() => {
    const images = [...document.images].filter((image) => image.getAttribute("src"));
    return {
      total: images.length,
      broken: images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")),
      portraits: [...new Set(images.map((image) => image.getAttribute("src")).filter((src) => /mit\{|mockup-portraits|characters\/seosoyoung/.test(src ?? "")))],
    };
  });
}
async function openFromBubble(page) {
  await page.locator('[data-testid="pas-report-bubble"] .pas-rt1707-open-report').click();
  await page.waitForSelector('[data-testid="pas-report-thread-dialog"]');
  await wait(600);
}
async function railItem(page, number) {
  return page.locator(".pas-rt1707-rail-item").filter({ hasText: `#${number}` });
}
async function reportStatus(page) {
  return textOf(page, '[data-testid="pas-report-thread-dialog"] .pas-rt1707-report-heading [data-slot="status-chip"]');
}
async function decideBand(page) {
  return page.evaluate(() => {
    const decide = document.querySelector(".pas-rt1707-decide");
    if (!decide) return null;
    const visible = [...document.querySelectorAll(".pas-rt1707-decide-actions button")].filter((button) => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (visible.length === 0) return null;
    const bottom = Math.max(...visible.map((button) => button.getBoundingClientRect().bottom));
    return { decideBottom: decide.getBoundingClientRect().bottom, buttonBottom: bottom, band: decide.getBoundingClientRect().bottom - bottom };
  });
}
async function decisionButtons(page) {
  const buttons = await page.evaluate(() => [...document.querySelectorAll(".pas-rt1707-decide-actions button")]
    .filter((button) => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })
    .map((button) => {
      const box = button.getBoundingClientRect();
      const label = button.querySelector(":scope > span");
      const range = document.createRange();
      if (label) range.selectNodeContents(label);
      return {
        text: button.textContent.trim(),
        top: box.top,
        height: box.height,
        choice: button.classList.contains("pas-rt1707-choice"),
        labelRects: label?.getClientRects().length ?? 0,
        textRects: label ? range.getClientRects().length : 0,
      };
    }));
  assert(buttons.length > 0, "결재 단추가 없다");
  for (const button of buttons) {
    assert(button.height >= 44, `결재 단추 높이가 44px 미만이다: ${JSON.stringify(button)}`);
    for (const other of buttons) {
      if (Math.abs(button.top - other.top) <= 1) {
        assert(Math.abs(button.height - other.height) <= 1, `같은 줄 단추의 높이가 다르다: ${JSON.stringify([button, other])}`);
      }
    }
  }
  return buttons;
}
async function choiceButtons(page) {
  const buttons = (await decisionButtons(page)).filter((button) => button.choice);
  assert(buttons.length === 3, `선택지가 세 개가 아니다: ${JSON.stringify(buttons)}`);
  for (const button of buttons) {
    assert(button.height <= 46 && button.labelRects === 1 && button.textRects === 1,
      `선택지 글이 한 줄이 아니거나 높이가 46px를 넘는다: ${JSON.stringify(button)}`);
  }
  const heights = buttons.map((button) => button.height);
  assert(Math.max(...heights) - Math.min(...heights) <= 1, `선택지 높이가 다르다: ${JSON.stringify(buttons)}`);
  return buttons;
}
async function selectRail(page, number) {
  await (await railItem(page, number)).click();
  await wait(250);
}
async function clickText(page, selector, label) {
  await page.locator(selector).filter({ hasText: label }).first().click();
  await wait(300);
}

try {
  await runPlaywrightLifecycle({ lockName: "pas-report-1707-thread-qa", timeoutMs: 900_000, launchBrowser: (options) => chromium.launch(options) }, async ({ browser }) => {
    const viewports = [
      { id: "1440x900", width: 1440, height: 900 },
      { id: "820x1180", width: 820, height: 1180 },
      { id: "390x844", width: 390, height: 844 },
      { id: "360x780", width: 360, height: 780 },
    ];
    for (const viewport of viewports) {
      for (const theme of ["dark", "light"]) {
        const page = await newPage(browser, viewport, theme);
        await check(`${viewport.id} ${theme} 메인 화면`, async () => {
          await gotoPas(page, theme);
          const unmockedList = await unmocked(page);
          const pageOverflow = await overflow(page);
          assert(unmockedList.length === 0, `가짜 응답 없는 호출: ${unmockedList.join(", ")}`);
          assert(pageOverflow === 0, `가로 넘침 ${pageOverflow}px`);
          assert(!(await page.content()).includes("세션 중단"), "세션 중단 문구가 있다");
          const bubbleText = await textOf(page, '[data-testid="pas-report-bubble"]');
          assert(bubbleText?.includes("1 / 5"), `말풍선 순번이 1 / 5가 아니다: ${bubbleText}`);
          assert(bubbleText?.includes("#1680"), "말풍선에 카드 번호가 없다");
          assert(bubbleText?.includes("검수 대기"), "말풍선에 상태 칩이 없다");
          assert(bubbleText?.includes("보고 창 열기"), "말풍선에 보고 창 열기 단추가 없다");
          const composerPadding = await page.evaluate(() => {
            const element = document.querySelector('[data-slot="chat-input-composer"]');
            const style = getComputedStyle(element);
            return { top: style.paddingTop, bottom: style.paddingBottom };
          });
          assert(parseFloat(composerPadding.top) === parseFloat(composerPadding.bottom), `입력창 안쪽 여백 불일치 ${JSON.stringify(composerPadding)}`);
          const images = await imageReport(page);
          assert(images.broken.length === 0, `깨진 그림: ${images.broken.join(", ")}`);
          const hits = await controlHits(page, viewport);
          assert(hits.length === 0, `코멘트 단추 자리와 겹치는 조작: ${hits.join(", ")}`);
          await page.screenshot({ path: join(captureDir, `${viewport.id}-${theme}-pas.png`) });
          return { overflow: pageOverflow, images: images.total };
        });
        await check(`${viewport.id} ${theme} 보고 창`, async () => {
          // 같은 페이지에서 말풍선으로 열어 화면 재적재를 줄인다. 직접 #report 진입은
          // 아래 1440 흐름에서 한 번 더 확인한다.
          await openFromBubble(page);
          const dialog = await rect(page, '[data-testid="pas-report-thread-dialog"]');
          assert(dialog, "보고 창이 열리지 않았다");
          assert(dialog.x >= 0 && dialog.y >= 0 && dialog.right <= viewport.width + 0.5 && dialog.bottom <= viewport.height - 72 + 0.5,
            `보고 창이 화면과 코멘트 자리를 벗어난다 ${JSON.stringify(dialog)}`);
          const rail = await rect(page, ".pas-rt1707-rail");
          const thread = await rect(page, ".pas-rt1707-thread");
          if (rail.bottom <= thread.top + 1) assert(thread.top >= rail.bottom - 1, `띠 레일 아래로 스레드가 시작하지 않는다 ${rail.bottom} ${thread.top}`);
          else assert(Math.abs(rail.top - thread.top) <= 1, `레일과 스레드 위가 어긋난다 ${rail.top} ${thread.top}`);
          const pageOverflow = await overflow(page);
          assert(pageOverflow === 0, `보고 창 가로 넘침 ${pageOverflow}px`);
          const hits = await controlHits(page, viewport);
          assert(hits.length === 0, `코멘트 단추 자리와 겹치는 조작: ${hits.join(", ")}`);
          const images = await imageReport(page);
          assert(images.broken.length === 0, `깨진 그림: ${images.broken.join(", ")}`);
          assert(images.portraits.length >= 4, `서로 다른 초상이 4개 미만: ${images.portraits.join(", ")}`);
          assert((await reportStatus(page)) === "질문", `미처분 질문 안건의 머리 상태가 질문이 아니다: ${await reportStatus(page)}`);
          const railChips = await page.locator('.pas-rt1707-rail-item [data-slot="status-chip"]').count();
          assert(railChips === 0, `미결 레일에 상태 칩이 ${railChips}개 남았다`);
          assert(!(await page.content()).includes("중간에 보탠 커멘트 없이 결과까지 왔습니다"), "중복 문단이 남았다");
          const firstOption = page.locator(".pas-rt1707-decide .pas-rt1707-choice").first();
          const optionBox = await firstOption.boundingBox();
          assert(optionBox, "결재 상자에 첫 선택지가 없다");
          const center = { x: optionBox.x + optionBox.width / 2, y: optionBox.y + optionBox.height / 2 };
          assert(center.x >= 0 && center.x <= viewport.width && center.y >= 0 && center.y <= viewport.height,
            `첫 선택지 중심이 화면 밖이다 ${JSON.stringify(center)}`);
          const hit = await page.evaluate(({ x, y }) => {
            const element = document.elementFromPoint(x, y);
            return { inChoice: Boolean(element?.closest(".pas-rt1707-decide .pas-rt1707-choice")), tag: element?.tagName ?? null };
          }, center);
          assert(hit.inChoice, `첫 선택지 중심을 눌러도 선택지가 맞지 않는다: ${JSON.stringify(hit)}`);
          const band = await decideBand(page);
          assert(band && band.band <= 16, `결재 상자 아래 빈 띠가 16px를 넘는다: ${JSON.stringify(band)}`);
          const unmockedList = await unmocked(page);
          assert(unmockedList.length === 0, `가짜 응답 없는 호출: ${unmockedList.join(", ")}`);
          await page.screenshot({ path: join(captureDir, `${viewport.id}-${theme}-report.png`) });
          return { dialog: { width: dialog.width, height: dialog.height }, portraits: images.portraits.length, band: band.band, choiceCenter: center };
        });
        if (theme === "dark") {
          await check(`${viewport.id} 선택지와 결재 단추 크기`, async () => {
            const choices = await choiceButtons(page);
            const agendas = {};
            for (const number of [1680, 1512, 1387, 1408, 1112]) {
              await selectRail(page, number);
              const before = await decisionButtons(page);
              await page.locator(".pas-rt1707-stamps button").first().click();
              await wait(300);
              const after = await decisionButtons(page);
              assert(after.some((button) => button.text === "되돌리기"), `#${number} 처분 뒤 되돌리기 단추가 없다`);
              agendas[number] = { before, after };
              await page.locator(".pas-rt1707-undo-slot button").click();
              await wait(300);
            }
            await selectRail(page, 1680);
            return { choices, agendas };
          });
        }
        await check(`${viewport.id} ${theme} 닫기와 초점`, async () => {
          await page.keyboard.press("Escape");
          await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
          await wait(250);
          const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.getAttribute("aria-label"));
          assert(focused === "보고 창 열기", `초점이 보고 창 열기로 돌아오지 않았다: ${focused}`);
          const hash = await page.evaluate(() => window.location.hash);
          assert(hash !== "#report", `주소에 #report가 남았다`);
          return { focused };
        });
        await page.close();
      }
    }

    const viewport = { width: 1440, height: 900 };
    const page = await newPage(browser, viewport, "dark");
    await gotoPas(page, "dark");

    await check("직접 #report 진입", async () => {
      await gotoReport(page, "dark");
      assert(await page.locator('[data-testid="pas-report-thread-dialog"]').isVisible(), "보고 창이 보이지 않는다");
      assert((await reportStatus(page)) === "질문", `직접 진입한 질문 안건의 상태가 질문이 아니다: ${await reportStatus(page)}`);
      const hash = await page.evaluate(() => window.location.hash);
      assert(hash === "#report", `주소가 #report가 아니다: ${hash}`);
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(250);
      return { hash };
    });

    await check("말풍선으로 보고 창 열기", async () => {
      await openFromBubble(page);
      assert(await page.locator('[data-testid="pas-report-thread-dialog"]').isVisible(), "보고 창이 보이지 않는다");
      const hash = await page.evaluate(() => window.location.hash);
      assert(hash === "#report", `주소가 #report가 아니다: ${hash}`);
      return { hash };
    });

    await check("호스트 ?view=report로 보고 창 열기", async () => {
      const hostPage = await newPage(browser, { width: 1200, height: 900 }, "dark");
      await hostPage.goto(`${base}/host.html?view=report`, { waitUntil: "networkidle" });
      const frame = hostPage.frameLocator("iframe");
      await frame.locator('[data-testid="pas-report-thread-dialog"]').waitFor({ timeout: 10_000 });
      assert(await frame.locator('[data-testid="pas-report-thread-dialog"]').isVisible(), "호스트 view=report가 보고 창을 열지 않았다");
      await hostPage.close();
      return { host: "view=report" };
    });

    await check("모든 안건 결재 상자 아래 빈 띠", async () => {
      const bands = {};
      for (const number of [1680, 1512, 1387, 1408, 1112]) {
        await selectRail(page, number);
        const band = await decideBand(page);
        assert(band && band.band <= 16, `#${number} 결재 상자 아래 빈 띠가 16px를 넘는다: ${JSON.stringify(band)}`);
        bands[number] = band.band;
      }
      await selectRail(page, 1680);
      return bands;
    });

    let stable;
    await check("질문 답과 고정 높이 되돌리기", async () => {
      const before = {
        title: await rect(page, ".pas-rt1707-report-title"),
        decide: await rect(page, ".pas-rt1707-decide"),
        undo: await rect(page, ".pas-rt1707-undo-slot"),
      };
      await clickText(page, ".pas-rt1707-decide .pas-rt1707-choice", "최근 7일 유지");
      await wait(350);
      assert((await reportStatus(page)) === "완료", `답을 고른 뒤 상태가 완료가 아니다: ${await reportStatus(page)}`);
      assert((await textOf(page, ".pas-rt1707-answer-line"))?.includes("받은 답: 최근 7일 유지"), "받은 답 줄이 서지 않았다");
      assert((await (await railItem(page, 1680)).textContent())?.includes("완료"), "레일에 완료 상태가 표시되지 않는다");
      const after = {
        title: await rect(page, ".pas-rt1707-report-title"),
        decide: await rect(page, ".pas-rt1707-decide"),
        undo: await rect(page, ".pas-rt1707-undo-slot"),
      };
      assert(Math.abs(before.title.top - after.title.top) <= 0.5, `제목이 ${after.title.top - before.title.top}px 움직였다`);
      assert(Math.abs(before.decide.top - after.decide.top) <= 0.5, `결재 상자가 ${after.decide.top - before.decide.top}px 움직였다`);
      assert(Math.abs(before.undo.height - after.undo.height) <= 0.5, `되돌리기 자리 높이가 달라졌다`);
      assert(before.undo.height === 44 && after.undo.height === 44, `되돌리기 자리 높이가 44px가 아니다: ${before.undo.height}, ${after.undo.height}`);
      assert((await textOf(page, ".pas-rt1707-undo-slot button")) === "되돌리기", "되돌리기 단추가 없다");
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(350);
      assert((await reportStatus(page)) === "질문", `되돌린 뒤 상태가 질문이 아니다: ${await reportStatus(page)}`);
      assert((await page.locator('.pas-rt1707-rail-item [data-slot="status-chip"]').count()) === 0, "되돌린 뒤 레일에 상태 칩이 남았다");
      stable = { titleShift: after.title.top - before.title.top, decideShift: after.decide.top - before.decide.top, undoHeight: after.undo.height };
      return stable;
    });

    await check("답을 남기고 화면에 반영", async () => {
      await clickText(page, ".pas-rt1707-decide .pas-rt1707-choice", "최근 7일 유지");
      await wait(300);
      assert((await reportStatus(page)) === "완료", "답이 다시 완료로 바뀌지 않았다");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(300);
      const bubbleText = await textOf(page, '[data-testid="pas-report-bubble"]');
      assert(bubbleText?.includes("1 / 4"), `말풍선 순번이 1 / 4가 아니다: ${bubbleText}`);
      const chat = await textOf(page, ".pas-rt1707-chat-scroll");
      assert(chat?.includes("최근 7일 유지"), "PAS 대화에 답이 반영되지 않았다");
      await openFromBubble(page);
      return { bubble: "1 / 4" };
    });

    await check("레일 클릭과 화살표 이동", async () => {
      await selectRail(page, 1512);
      assert((await textOf(page, '.pas-rt1707-rail-item[data-active="true"]'))?.includes("#1512"), "레일 클릭으로 안건이 바뀌지 않았다");
      await page.keyboard.press("ArrowRight");
      await wait(250);
      assert((await textOf(page, '.pas-rt1707-rail-item[data-active="true"]'))?.includes("#1387"), "오른쪽 화살표로 다음 안건으로 가지 않았다");
      await page.keyboard.press("ArrowLeft");
      await wait(250);
      assert((await textOf(page, '.pas-rt1707-rail-item[data-active="true"]'))?.includes("#1512"), "왼쪽 화살표로 이전 안건으로 가지 않았다");
      return { rail: "1512" };
    });

    await check("Tab 순서와 Esc 닫기", async () => {
      const active = () => page.evaluate(() => document.activeElement?.closest(".pas-rt1707-rail-item")?.textContent?.replace(/\s+/g, " ").trim() ?? null);
      await page.keyboard.press("Tab");
      await wait(150);
      assert((await active())?.includes("#1387"), `Tab이 다음 레일 항목으로 가지 않았다: ${await active()}`);
      await page.keyboard.press("Shift+Tab");
      await wait(150);
      assert((await active())?.includes("#1512"), `Shift+Tab이 앞 레일 항목으로 가지 않았다: ${await active()}`);
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(250);
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
      assert(focused === "보고 창 열기", `Esc 뒤 초점이 보고 창 열기로 돌아오지 않았다: ${focused}`);
      await openFromBubble(page);
      return { tab: "1512 to 1387", escape: true };
    });

    await check("부탁 장 했어와 저녁 재확인", async () => {
      await clickText(page, ".pas-rt1707-stamps button", "했어");
      assert((await reportStatus(page)) === "완료", `했어 뒤 상태가 완료가 아니다: ${await reportStatus(page)}`);
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "했어 되돌리기가 실패했다");
      await clickText(page, ".pas-rt1707-stamps button", "저녁에 다시 보기");
      assert((await reportStatus(page)) === "검증 대기", `저녁 재확인 뒤 상태가 검증 대기가 아니다: ${await reportStatus(page)}`);
      assert((await textOf(page, ".pas-rt1707-hold-note"))?.includes("18개"), "보류함 수가 바뀌었다");
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "저녁 재확인 되돌리기가 실패했다");
      return { hold: 18 };
    });

    await check("설계 문서 열람과 참고 보관", async () => {
      await selectRail(page, 1387);
      await page.evaluate(() => { window.__pasDocFail = true; });
      await page.locator(".pas-rt1707-document-row button").click();
      await page.waitForSelector('[data-testid="internal-document-dialog"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="internal-document-dialog"]')?.textContent?.includes("문서를 불러오지 못했습니다"), null, { timeout: 8_000 });
      assert((await textOf(page, '[data-testid="internal-document-dialog"]'))?.includes("문서를 불러오지 못했습니다"),
        "문서 조회 500에서 실패 안내가 보이지 않는다");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(250);
      await page.evaluate(() => { window.__pasDocFail = false; });
      await page.locator(".pas-rt1707-document-row button").click();
      await page.waitForSelector('[data-testid="internal-document-dialog"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="internal-document-dialog"]')?.textContent?.includes("턴 안 상호작용 3단계 도입 설계안"), null, { timeout: 8_000 });
      const documentText = await textOf(page, '[data-testid="internal-document-dialog"]');
      assert(documentText?.includes("턴 안 상호작용 3단계 도입 설계안"), "설계 문서 본문이 보이지 않는다");
      assert(documentText?.includes("1단계, 접수"), "설계 문서의 단계가 보이지 않는다");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(250);
      await clickText(page, ".pas-rt1707-stamps button", "참고 보관 후 완료");
      assert((await reportStatus(page)) === "완료", `참고 보관 뒤 상태가 완료가 아니다: ${await reportStatus(page)}`);
      const keptRail = await railItem(page, 1387);
      assert((await keptRail.textContent())?.includes("완료"), "레일에 완료가 표시되지 않는다");
      assert((await keptRail.locator('[data-slot="badge"]').filter({ hasText: "참고" }).count()) === 1, "레일에 참고 배지가 없다");
      await page.locator(".pas-rt1707-document-row button").click();
      await page.waitForSelector('[data-testid="internal-document-dialog"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="internal-document-dialog"]')?.textContent?.includes("3단계 도입 설계안"), null, { timeout: 8_000 });
      const again = await textOf(page, '[data-testid="internal-document-dialog"]');
      assert(again?.includes("3단계 도입 설계안"), "보관 뒤 문서를 다시 읽을 수 없다");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="internal-document-dialog"]', { state: "hidden", timeout: 8_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(250);
      await page.locator(".persistent-session-task-toggle button").click();
      await page.waitForSelector('[data-testid="persistent-session-task-list"]');
      const keptCard = page.locator(".pas-rt1707-kept-card").filter({ hasText: "#1387" });
      assert((await keptCard.count()) === 1, "작업 목록 서랍에 참고 문서 카드가 없다");
      assert((await keptCard.textContent())?.includes("참고"), "작업 목록 서랍 카드에 참고 배지가 없다");
      await page.locator('[aria-label="작업 목록 닫기"]').click();
      await wait(200);
      await openFromBubble(page);
      await selectRail(page, 1387);
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "참고 보관 되돌리기가 실패했다");
      assert((await (await railItem(page, 1387)).locator('[data-slot="badge"]').count()) === 0, "되돌린 뒤 참고 배지가 남았다");
      return { document: "failure then recovery", keptCard: true };
    });

    let instructionSlot;
    await check("항목 지시가 스레드와 실행 중에 반영", async () => {
      await selectRail(page, 1408);
      const beforeUndo = await rect(page, ".pas-rt1707-undo-slot");
      await page.locator(".pas-rt1707-check-instruct").nth(1).click();
      await wait(250);
      const chip = await textOf(page, ".pas-rt1707-target-chip");
      assert(chip?.includes("대상: 2번 항목"), `대상 칩이 2번 항목이 아니다: ${chip}`);
      const input = page.locator(".pas-rt1707-decide-input textarea");
      await input.fill("장 사이 여백을 다시 확인해 주세요");
      await page.locator('.pas-rt1707-decide-input [aria-label="지시 보내기"]').click();
      await wait(400);
      const thread = await textOf(page, ".pas-rt1707-thread-scroll");
      assert(thread?.includes("장 사이 여백을 다시 확인해 주세요"), "보낸 지시가 스레드에 붙지 않았다");
      assert((await reportStatus(page)) === "실행 중", `지시 뒤 상태가 실행 중이 아니다: ${await reportStatus(page)}`);
      const afterUndo = await rect(page, ".pas-rt1707-undo-slot");
      assert(Math.abs(beforeUndo.height - afterUndo.height) <= 0.5, "되돌리기 자리 높이가 달라졌다");
      instructionSlot = afterUndo.height;
      await input.focus();
      const activeBefore = await textOf(page, '.pas-rt1707-rail-item[data-active="true"]');
      await page.keyboard.press("ArrowRight");
      await wait(200);
      const activeAfter = await textOf(page, '.pas-rt1707-rail-item[data-active="true"]');
      assert(activeBefore === activeAfter, "입력 중 화살표가 안건을 바꿨다");
      return { chip };
    });

    await check("작업 목록에 실행 중 반영", async () => {
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(250);
      await page.locator(".persistent-session-task-toggle button").click();
      await page.waitForSelector('[data-testid="persistent-session-task-list"]');
      const list = await textOf(page, '[data-testid="persistent-session-task-list"]');
      assert(list?.includes("#1408"), "작업 목록에 1408이 없다");
      assert(list?.includes("실행 중"), "작업 목록에 실행 중이 없다");
      assert((await textOf(page, ".pas-rt1707-hold-note"))?.includes("보류함 18개"), "작업 목록 아래 보류함 수가 없다");
      await page.locator('[aria-label="작업 목록 닫기"]').click();
      await wait(200);
      await openFromBubble(page);
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "지시 되돌리기가 실패했다");
      return { drawer: "실행 중" };
    });

    await check("관찰 장 사흘 뒤 재확인", async () => {
      await selectRail(page, 1112);
      await clickText(page, ".pas-rt1707-stamps button", "사흘 뒤 재확인");
      assert((await reportStatus(page)) === "검증 대기", `재확인 뒤 상태가 검증 대기가 아니다: ${await reportStatus(page)}`);
      assert((await textOf(page, ".pas-rt1707-hold-note"))?.includes("18개"), "보류함 수가 바뀌었다");
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "재확인 되돌리기가 실패했다");
      return { hold: 18 };
    });

    await check("증거 확대와 초점 복귀", async () => {
      await selectRail(page, 1680);
      const evidence = page.locator(".pas-rt1707-evidence-button").first();
      await evidence.click();
      await page.waitForSelector('[data-testid="pas-report-evidence-dialog"]');
      await wait(250);
      const evidenceText = await textOf(page, '[data-testid="pas-report-evidence-dialog"]');
      assert(evidenceText?.includes("완료 분포 도표"), "증거 확대 창에 도표 이름이 없다");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-evidence-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(300);
      const focusLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim());
      assert(focusLabel?.includes("완료 분포 도표"), `증거 확대 뒤 초점이 돌아오지 않았다: ${focusLabel}`);
      return { focusLabel };
    });

    await check("빠른 두 번 누르기를 한 번으로 막기", async () => {
      await selectRail(page, 1408);
      const clickTwice = await page.evaluate(() => {
        const button = [...document.querySelectorAll(".pas-rt1707-stamps button")].find((item) => item.textContent?.trim() === "승인 완료");
        if (!button) return false;
        button.click(); button.click();
        return true;
      });
      assert(clickTwice, "승인 완료 단추를 찾지 못했다");
      await wait(500);
      assert((await reportStatus(page)) === "완료", "승인 완료가 반영되지 않았다");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="pas-report-thread-dialog"]', { state: "hidden", timeout: 8_000 });
      await wait(300);
      const chat = await textOf(page, ".pas-rt1707-chat-scroll");
      const count = (chat?.match(/#1408 슬라이드 편집 장 순서 변경과 줄간격 보정을 승인 완료로 처분했습니다/g) ?? []).length;
      assert(count === 1, `승인 완료 대화가 ${count}번 남았다`);
      await openFromBubble(page);
      await page.locator(".pas-rt1707-undo-slot button").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "승인 완료 되돌리기가 실패했다");
      return { chatCount: count };
    });

    await check("결재 입력창 안쪽 여백 대칭", async () => {
      const padding = await page.evaluate(() => {
        const element = document.querySelector(".pas-rt1707-decide-input");
        const style = getComputedStyle(element);
        return { top: style.paddingTop, bottom: style.paddingBottom };
      });
      assert(parseFloat(padding.top) === parseFloat(padding.bottom), `결재 입력창 여백 불일치 ${JSON.stringify(padding)}`);
      return padding;
    });

    await check("창 크기 바꾸기", async () => {
      const input = page.locator(".pas-rt1707-decide-input textarea");
      await input.fill("리사이즈 확인");
      await page.locator(".pas-rt1707-thread-scroll").evaluate((element) => { element.scrollTop = 160; });
      await wait(200);
      await page.setViewportSize({ width: 390, height: 844 });
      await wait(500);
      const narrowDialog = await rect(page, '[data-testid="pas-report-thread-dialog"]');
      const narrowRail = await rect(page, ".pas-rt1707-rail");
      const narrowThread = await rect(page, ".pas-rt1707-thread");
      assert(narrowDialog && narrowDialog.right <= 390.5 && narrowDialog.bottom <= 844 - 72 + 0.5,
        `좁힌 뒤 보고 창이 화면과 코멘트 자리를 벗어난다 ${JSON.stringify(narrowDialog)}`);
      assert(narrowRail.bottom <= narrowThread.top + 1, `좁힌 뒤 레일이 스레드 위에 서지 않는다 ${narrowRail.bottom} ${narrowThread.top}`);
      assert((await input.inputValue()) === "리사이즈 확인", "좁히는 동안 결재 입력 글이 사라졌다");
      const narrowScroll = await page.locator(".pas-rt1707-thread-scroll").evaluate((element) => element.scrollTop);
      assert(narrowScroll > 0, "좁히는 동안 스레드 스크롤 위치가 맨 위로 돌아갔다");
      await page.setViewportSize({ width: 1440, height: 900 });
      await wait(500);
      const wideRail = await rect(page, ".pas-rt1707-rail");
      const wideThread = await rect(page, ".pas-rt1707-thread");
      assert(Math.abs(wideRail.top - wideThread.top) <= 1, `넓힌 뒤 레일과 스레드 위가 어긋난다 ${wideRail.top} ${wideThread.top}`);
      assert((await input.inputValue()) === "리사이즈 확인", "넓히는 동안 결재 입력 글이 사라졌다");
      await input.fill("");
      return { narrowScroll, preserved: true };
    });

    await page.close();
  });

  await check("금지 문장 부호와 어휘 없음", () => {
    const repoRoot = execFileSync("git", ["-C", dashboardDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const base = execFileSync("git", ["-C", repoRoot, "merge-base", "HEAD", "origin/main"], { encoding: "utf8" }).trim();
    const files = [...new Set([
      ...execFileSync("git", ["-C", repoRoot, "diff", "--name-only", base], { encoding: "utf8" }).split("\n"),
      ...execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n"),
    ].map((line) => line.trim()).filter(Boolean))];
    const punctuation = new RegExp("[\\u00B7\\u2014\\u2015]");
    const verb = new RegExp(`${String.fromCharCode(0xBC15)}(?:${["B2E4", "C544", "C558", "C740", "B294", "C744", "C74C", "D600", "D614", "C9C0", "C9C8", "D78C", "D798"].map((code) => `\\u${code}`).join("|")})`);
    const offenders = [];
    let scanned = 0;
    for (const relative of files) {
      if (!textExtensions.has(extname(relative))) continue;
      const absolute = resolve(repoRoot, relative);
      if (!existsSync(absolute)) continue;
      scanned += 1;
      const body = readFileSync(absolute, "utf8");
      if (punctuation.test(body)) offenders.push(`${relative}: 문장 부호`);
      if (extname(relative) === ".md" && /^---\s*$/m.test(body)) offenders.push(`${relative}: 수평선`);
      if (verb.test(body)) offenders.push(`${relative}: 금지 어휘`);
    }
    assert(offenders.length === 0, offenders.join(", "));
    return { scanned };
  });

  await check("브라우저 콘솔 오류 없음", () => {
    assert(browserErrors.length === 0, browserErrors.slice(0, 5).join(" | "));
    return { errors: 0 };
  });

  const failed = checks.filter((item) => !item.ok);
  const summary = { captureDir, failed: failed.length, checks };
  await mkdir(captureDir, { recursive: true });
  await writeFile(join(captureDir, "qa-report.json"), JSON.stringify(summary, null, 2));
  console.log("");
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await new Promise((ok) => server.close(ok));
}
