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
const scope = process.env.PAS_RT1707_SCOPE ?? "all";
const disableWebgl = process.env.PAS_RT1707_DISABLE_WEBGL === "1";
const allowedScopes = new Set(["all", "flows", "critical", "remaining", "operations", "review", "1440x900", "820x1180", "390x844", "360x780"]);
if (!allowedScopes.has(scope)) throw new Error(`알 수 없는 QA 범위: ${scope}`);
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
  page.setDefaultTimeout(30_000);
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
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const visible = [...document.querySelectorAll(".pas-rt1707-decide-actions button")].filter(shown);
    if (visible.length === 0) return null;
    const drawer = document.querySelector(".pas-rt1707-composer-drawer");
    const bottoms = [...visible, ...(drawer && shown(drawer) ? [drawer] : [])].map((element) => element.getBoundingClientRect().bottom);
    const bottom = Math.max(...bottoms);
    const box = decide.getBoundingClientRect();
    const style = getComputedStyle(decide);
    const contentRight = box.right - parseFloat(style.paddingRight);
    const secondary = [...document.querySelectorAll(".pas-rt1707-stamps-secondary button")].filter(shown);
    const lastRight = secondary.length ? Math.max(...secondary.map((button) => button.getBoundingClientRect().right)) : null;
    return { decideBottom: box.bottom, buttonBottom: bottom, band: box.bottom - bottom,
      paddingRight: parseFloat(style.paddingRight), rightGap: lastRight === null ? null : contentRight - lastRight,
      lastSecondary: secondary.at(-1)?.textContent?.trim() ?? null };
  });
}
// 결재 상자 아래 여백은 좌우 여백과 눌리지 않게 맞춘다(데스크톱 20px, 모바일 16px).
function bandRange(width) {
  return width > 767 ? [18, 24] : [14, 20];
}
function assertBand(band, width, label) {
  const [min, max] = bandRange(width);
  assert(band && band.band >= min - 0.5 && band.band <= max + 0.5, `${label} 결재 상자 아래 여백이 ${min}~${max}px 밖이다: ${JSON.stringify(band)}`);
}
async function railInset(page) {
  return page.evaluate(() => {
    const edge = (item) => {
      const box = item.getBoundingClientRect();
      const number = item.querySelector(".pas-rt1707-rail-number").getBoundingClientRect();
      const title = item.querySelector(".pas-rt1707-rail-title").getBoundingClientRect();
      return { left: box.left, number: number.left - box.left, title: title.left - box.left };
    };
    const active = document.querySelector('.pas-rt1707-rail-item[data-active="true"]');
    const other = [...document.querySelectorAll(".pas-rt1707-rail-item")].find((item) => item !== active && item.getClientRects().length > 0);
    if (!active || !other) return null;
    const bar = parseFloat(getComputedStyle(active).boxShadow.match(/(-?[\d.]+)px/)?.[1] ?? "0");
    const a = edge(active), b = edge(other);
    return { active: a, other: b, bar, lineDifference: Math.abs((a.left + a.title) - (b.left + b.title)) };
  });
}
async function railSections(page) {
  return page.evaluate(() => {
    const textLeft = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().left;
    };
    const sections = [...document.querySelectorAll(".pas-rt1707-rail-sections > section")].filter((section) => section.getClientRects().length > 0);
    const rowTextGaps = [];
    const pairs = [];
    const headToFirst = [];
    sections.forEach((section, index) => {
      const head = section.querySelector(".pas-rt1707-rail-head");
      const items = [...section.querySelectorAll(".pas-rt1707-rail-item")];
      if (items.length) headToFirst.push(items[0].querySelector(".pas-rt1707-rail-number").getBoundingClientRect().top - head.querySelector("h2").getBoundingClientRect().bottom);
      items.slice(1).forEach((item, i) => rowTextGaps.push(item.querySelector(".pas-rt1707-rail-number").getBoundingClientRect().top
        - items[i].querySelector(".pas-rt1707-rail-title").getBoundingClientRect().bottom));
      const next = sections[index + 1];
      if (!next || !items.length) return;
      const nextHead = next.querySelector(".pas-rt1707-rail-head");
      const last = items.at(-1);
      pairs.push({ from: section.getAttribute("aria-label"), to: next.getAttribute("aria-label"),
        boxGap: nextHead.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
        textGap: nextHead.querySelector("h2").getBoundingClientRect().top - last.querySelector(".pas-rt1707-rail-title").getBoundingClientRect().bottom });
    });
    const active = document.querySelector('.pas-rt1707-rail-item[data-active="true"]');
    const other = [...document.querySelectorAll(".pas-rt1707-rail-item")].find((item) => item !== active && item.getClientRects().length > 0);
    const starts = { head: textLeft(sections[0].querySelector(".pas-rt1707-rail-head h2")), active: textLeft(active.querySelector(".pas-rt1707-rail-number")),
      other: textLeft(other.querySelector(".pas-rt1707-rail-number")), hold: textLeft(document.querySelector(".pas-rt1707-rail-foot .pas-rt1707-hold-note")) };
    return { pairs, rowTextGap: Math.max(...rowTextGaps), headToFirst: Math.max(...headToFirst), starts,
      startSpread: Math.max(...Object.values(starts)) - Math.min(...Object.values(starts)) };
  });
}
function assertRailSections(rail, label) {
  assert(rail.pairs.length > 0 && rail.pairs.every((pair) => pair.boxGap >= 16 && pair.textGap > rail.rowTextGap && rail.headToFirst < pair.textGap),
    `${label} 레일 구역 사이가 같은 구역 안 행보다 붙어 있다: ${JSON.stringify(rail)}`);
  assert(rail.startSpread <= 1, `${label} 레일 머리, 행, 보류함 글자 시작선이 어긋난다: ${JSON.stringify(rail.starts)}`);
}
async function decidePills(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".pas-rt1707-decide-actions button")].filter((button) => button.getClientRects().length > 0)
      .map((button) => {
        const box = button.getBoundingClientRect();
        return { text: button.textContent.trim(), height: box.height, center: (box.top + box.bottom) / 2,
          radius: parseFloat(getComputedStyle(button).borderTopLeftRadius), fontSize: getComputedStyle(button).fontSize };
      });
    const rows = [];
    for (const button of buttons) {
      const row = rows.find((item) => Math.abs(item.center - button.center) <= 2);
      if (row) row.buttons.push(button); else rows.push({ center: button.center, buttons: [button] });
    }
    return { buttons, fontSizes: [...new Set(buttons.map((button) => button.fontSize))], notPill: buttons.filter((button) => !(button.radius >= button.height / 2 - 0.5)),
      rowSpread: rows.map((row) => Math.max(...row.buttons.map((b) => b.height)) - Math.min(...row.buttons.map((b) => b.height))) };
  });
}
async function composerGeometry(page) {
  return page.evaluate(() => {
    const drawer = document.querySelector(".pas-rt1707-composer-drawer");
    const composer = drawer?.querySelector('[data-testid="card-composer"] [data-slot="chat-input-composer"]');
    const textarea = composer?.querySelector("textarea");
    const send = composer ? [...composer.querySelectorAll("button")].at(-1) : null;
    const stamps = document.querySelector(".pas-rt1707-decide-actions");
    if (!composer || !textarea || !send || !stamps) return null;
    const box = composer.getBoundingClientRect(), text = textarea.getBoundingClientRect(), button = send.getBoundingClientRect();
    const row = stamps.getBoundingClientRect();
    return { composerTop: box.top, stampsBottom: row.bottom, gapBelowStamps: drawer.getBoundingClientRect().top - row.bottom,
      textTop: text.top - box.top, textBottom: box.bottom - text.bottom,
      sendCenterDifference: Math.abs((button.top + button.bottom) / 2 - (text.top + text.bottom) / 2), rows: textarea.rows,
      textHeight: text.height };
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
  // 결재 단추는 정본 Button 기본 크기(알약, 누르는 자리 44px 내장)다. 모든 단추가 한 높이다.
  const heights = buttons.map((button) => button.height);
  assert(Math.max(...heights) - Math.min(...heights) <= 1, `결재 단추 높이가 서로 다르다: ${JSON.stringify(buttons)}`);
  for (const button of buttons) {
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
  const mobile = await page.getByTestId("pas-rt1707-rail-toggle").isVisible();
  if (mobile) {
    await page.getByTestId("pas-rt1707-rail-toggle").click();
  }
  await (await railItem(page, number)).click();
  await wait(250);
  const focus = mobile ? page.getByTestId("pas-rt1707-rail-toggle") : page.locator('.pas-rt1707-rail-item[data-active="true"]');
  assert(await focus.evaluate((el) => el === document.activeElement), "안건 선택 뒤 초점이 돌아오지 않았다");
}
async function clickText(page, selector, label) {
  await page.locator(selector).filter({ hasText: label }).first().click();
  await wait(300);
}
async function koreanSplits(page) {
  return page.evaluate(() => {
    const selector = ".pas-rt1707-rail-title, .pas-rt1707-report-title, .pas-rt1707-request, .pas-rt1707-session-summary, .pas-rt1707-turns p, .pas-rt1707-summary p, .pas-rt1707-check-label, .pas-rt1707-evidence figcaption, .pas-rt1707-comment p, .pas-rt1707-caveat p";
    return [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden").flatMap((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), chars = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < node.textContent.length; i++) {
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          chars.push({char:node.textContent[i], top:range.getBoundingClientRect().top});
        }
      }
      return chars.slice(1).flatMap((current, i) => Math.abs(current.top - chars[i].top) > 2 && /[가-힣]/u.test(chars[i].char) && /[가-힣]/u.test(current.char)
        ? [`${el.className}: ${chars[i].char}|${current.char}`] : []);
    });
  });
}
async function panelPixelsStable(page, panel) {
  const clip = await panel.boundingBox();
  assert(clip, "카드 패널의 화소 비교 영역이 없다");
  // Keep the same viewport coordinates for both captures.
  const capture = () => page.screenshot({ clip, animations: "disabled", caret: "hide" });
  const before = await capture();
  const thread = page.locator(".pas-rt1707-thread");
  await thread.evaluate((el) => { el.style.visibility = "hidden"; });
  let after;
  try {
    after = await capture();
  } finally {
    await thread.evaluate((el) => { el.style.visibility = ""; });
  }
  return page.evaluate(async ({first, second}) => {
    const pixels = async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = await pixels(first), b = await pixels(second);
    if (a.length !== b.length) return -1;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
    return changed;
  }, {first:before.toString("base64"), second:after.toString("base64")});
}

try {
  await runPlaywrightLifecycle({
    lockName: "pas-report-1707-thread-qa",
    timeoutMs: 900_000,
    launchOptions: { headless: true, args: disableWebgl ? ["--disable-webgl"] : [] },
    launchBrowser: (options) => chromium.launch(options),
  }, async ({ browser }) => {
    const viewports = [
      { id: "1440x900", width: 1440, height: 900 },
      { id: "820x1180", width: 820, height: 1180 },
      { id: "390x844", width: 390, height: 844 },
      { id: "360x780", width: 360, height: 780 },
    ];
    for (const viewport of viewports.filter((item) => scope === "all" || scope === item.id)) {
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
          const bottom = await page.locator('.pas-rt1707-thread-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
          assert(bottom <= 4, `최신 경과에서 시작하지 않는다: ${bottom}`);
          assert((await page.locator(".pas-rt1707-thread-scroll").getAttribute("data-auto-scroll")) === "true", "자동 스크롤이 켜지지 않았다");
          assert(await page.getByTestId('pas-rt1707-snooze-trigger').isVisible(), '답변 미루기 단추가 없다');
          assert(await page.getByTestId('pas-rt1707-open-card-panel').isVisible(), '카드 패널 단추가 없다');
          if (viewport.width <= 767) {
            assert(await page.getByTestId('pas-rt1707-rail-toggle').isVisible(), '안건 목록 단추가 없다');
          }
          const dialog = await rect(page, '[data-testid="pas-report-thread-dialog"]');
          assert(dialog, "보고 창이 열리지 않았다");
          assert(dialog.x >= 0 && dialog.y >= 0 && dialog.right <= viewport.width + 0.5 && dialog.bottom <= viewport.height - 72 + 0.5,
            `보고 창이 화면과 코멘트 자리를 벗어난다 ${JSON.stringify(dialog)}`);
          if (viewport.width <= 767) {
            assert(!(await page.locator(".pas-rt1707-rail").isVisible()), "서랍이 처음부터 열렸다");
            await page.getByTestId("pas-rt1707-rail-toggle").click();
            await page.waitForFunction(() => document.activeElement?.matches('.pas-rt1707-rail-item[data-active="true"]'));
            assert(await page.locator(".pas-rt1707-thread").evaluate((el) => el.inert), "서랍 배경이 inert가 아니다");
            const drawerInset = await railInset(page);
            assert(drawerInset && drawerInset.active.number >= 15 && drawerInset.lineDifference <= 1, `서랍 레일 글자가 색 막대에 붙었다: ${JSON.stringify(drawerInset)}`);
            for (let i = 0; i < 16; i++) {
              await page.keyboard.press("Tab");
              const inside = await page.evaluate(() => Boolean(document.activeElement?.closest(".pas-rt1707-report-head, .pas-rt1707-rail")));
              assert(inside, "서랍과 머리줄 밖으로 초점이 이동했다");
            }
            await page.screenshot({ path: join(captureDir, `${viewport.id}-${theme}-drawer.png`) });
          }
          const rail = await rect(page, ".pas-rt1707-rail");
          const thread = await rect(page, ".pas-rt1707-thread");
          const railThreadTopDifference = Math.abs(rail.top - thread.top);
          if (viewport.width > 767) assert(railThreadTopDifference <= 1, "레일과 스레드 위가 어긋난다");
          assert(await page.locator(".pas-rt1707-rail-item").filter({hasText:"#1730"}).isVisible(), "진행 중 카드가 없다");
          const rows = await page.locator(".pas-rt1707-rail-item").evaluateAll((items) => items.slice(0, 2).map((el) => {
            const rect = el.getBoundingClientRect();
            return {top: rect.top, height: rect.height, title: getComputedStyle(el.querySelector(".pas-rt1707-rail-title")).display, portrait: getComputedStyle(el.querySelector("img")).display};
          }));
          assert(rows[1].top >= rows[0].top + rows[0].height - 1 && rows.every((row) => row.title !== "none" && row.portrait !== "none"), "안건이 세로 행으로 보이지 않는다");
          const splits = await koreanSplits(page);
          assert(splits.length === 0, `한글 어절 중간 줄바꿈: ${splits.join(", ")}`);
          if (viewport.width <= 767) {
            await page.keyboard.press("Escape");
            assert(!(await page.locator(".pas-rt1707-rail").isVisible()), "Escape로 서랍이 닫히지 않았다");
            await page.getByTestId("pas-rt1707-rail-toggle").click();
            await page.locator(".pas-rt1707-rail-scrim").click({ position: { x: thread.width - 8, y: thread.height / 2 } });
            assert(!(await page.locator(".pas-rt1707-rail").isVisible()), "배경 누름으로 서랍이 닫히지 않았다");
          }
          const pageOverflow = await overflow(page);
          assert(pageOverflow === 0, `보고 창 가로 넘침 ${pageOverflow}px`);
          const hits = await controlHits(page, viewport);
          assert(hits.length === 0, `코멘트 단추 자리와 겹치는 조작: ${hits.join(", ")}`);
          const images = await imageReport(page);
          assert(images.broken.length === 0, `깨진 그림: ${images.broken.join(", ")}`);
          assert(images.portraits.length >= 4, `서로 다른 초상이 4개 미만: ${images.portraits.join(", ")}`);
          assert((await reportStatus(page)) === "질문", `미처분 질문 안건의 머리 상태가 질문이 아니다: ${await reportStatus(page)}`);
          const railChips = await page.locator('section[aria-label="결재 대기"] .pas-rt1707-rail-item [data-slot="status-chip"]').count();
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
          assertBand(band, viewport.width, "첫 화면");
          if (viewport.width === 1440) {
            assert(band.rightGap !== null && Math.abs(band.rightGap) <= 2 && band.lastSecondary === "답변 미루기",
              `결재 상자 오른쪽 끝에 빈 자리가 있다: ${JSON.stringify(band)}`);
          }
          assert(await page.locator('[data-testid="card-composer"]').count() === 0, "처음부터 입력창이 펼쳐져 있다");
          assert(await page.getByRole("button", {name:"다르게 답하기", exact:true}).isVisible()
            && await page.getByRole("button", {name:"되묻기", exact:true}).isVisible(), "다르게 답하기와 되묻기 단추가 함께 보이지 않는다");
          assert(await page.locator('.pas-rt1707-event[data-kind="silence"]').count() === 0
            && !(await textOf(page, ".pas-rt1707-thread-scroll")).includes("중간 커멘트 없음"), "중간 커멘트 없음 빈 항목이 남았다");
          if (viewport.width > 767) {
            const inset = await railInset(page);
            assert(inset && inset.active.number >= 15 && inset.active.title >= 15 && inset.active.number - inset.bar >= 11 && inset.lineDifference <= 1,
              `레일 글자가 왼쪽 색 막대에 붙었다: ${JSON.stringify(inset)}`);
          }
          const unmockedList = await unmocked(page);
          assert(unmockedList.length === 0, `가짜 응답 없는 호출: ${unmockedList.join(", ")}`);
          const snoozeBox = await page.getByTestId("pas-rt1707-snooze-trigger").boundingBox();
          const snoozeHit = await page.evaluate(({x,y}) => Boolean(document.elementFromPoint(x,y)?.closest('[data-testid="pas-rt1707-snooze-trigger"]')), {x:snoozeBox.x+snoozeBox.width/2,y:snoozeBox.y+snoozeBox.height/2});
          assert(snoozeHit, "답변 미루기 단추가 가려졌다");
          assert(await page.locator('input[type="radio"]').count() === 0, "기본 라디오가 남았다");
          const selection = await page.evaluate(() => {
            const content = document.querySelector(".pas-rt1707-summary p");
            const range = document.createRange(); range.selectNodeContents(content);
            const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
            const readable = [...document.querySelectorAll('.pas-rt1707-thread-scroll [data-v3-selectable-content="true"]')].map((el) => getComputedStyle(el).userSelect);
            const controls = [".pas-rt1707-rail-item", ".pas-rt1707-rail-head h2", ".pas-rt1707-report-count", '[data-testid="pas-rt1707-snooze-trigger"]']
              .map((selector) => ({selector, userSelect:getComputedStyle(document.querySelector(selector)).userSelect}));
            const result = {text:selected.toString(), readable, controls};
            selected.removeAllRanges(); return result;
          });
          assert(selection.text && selection.readable.length > 0 && selection.readable.every((value) => value === "text")
            && selection.controls.every((item) => item.userSelect === "none"), `본문과 조작 요소의 글 선택이 다르다: ${JSON.stringify(selection)}`);
          const groups = await page.evaluate(() => {
            const choices = [...document.querySelectorAll(".pas-rt1707-choice")].map((el) => el.getBoundingClientRect());
            const snooze = document.querySelector('[data-testid="pas-rt1707-snooze-trigger"]').getBoundingClientRect();
            return { choices:choices.map((r) => ({left:r.left,right:r.right,top:r.top,bottom:r.bottom})), snooze:{left:snooze.left,right:snooze.right,top:snooze.top,bottom:snooze.bottom} };
          });
          const lastChoice = groups.choices.at(-1);
          const sameRow = Math.abs(lastChoice.top - groups.snooze.top) <= 1;
          assert(sameRow ? groups.snooze.left - lastChoice.right > 8 : groups.snooze.top >= lastChoice.bottom,
            `미루기 단추가 답 선택지와 구분되지 않는다: ${JSON.stringify(groups)}`);
          await page.screenshot({ path: join(captureDir, `${viewport.id}-${theme}-report.png`) });
          const scrollBeforePanel = await page.locator(".pas-rt1707-thread-scroll").evaluate((el) => el.scrollTop);
          await page.getByTestId("pas-rt1707-open-card-panel").click();
          const panel = page.getByTestId("v3-card-workspace");
          await panel.waitFor({state:"visible"});
          const panelSurface = await page.locator(".pas-rt1707-dialog > .v3-workspace-scrim").evaluate((el) => {
            const style = getComputedStyle(el);
            return {background:style.backgroundColor, backdrop:style.backdropFilter};
          });
          assert(!panelSurface.background.includes(" / ") && !panelSurface.background.startsWith("rgba") && panelSurface.backdrop === "none",
            `카드 패널 배경이 불투명하지 않다: ${JSON.stringify(panelSurface)}`);
          const changedPixels = await panelPixelsStable(page, panel);
          assert(changedPixels === 0, `뒤쪽 보고 창을 숨기자 카드 패널의 ${changedPixels}개 화소가 바뀌었다`);
          const metadata = await panel.locator(".v3-task-default-summary").evaluate((summary) => {
            const values = summary.querySelector(".v3-task-default-values");
            const spans = [...values.querySelectorAll(":scope > span")];
            const edit = summary.querySelector(".v3-task-default-edit");
            const rects = spans.map((span) => span.getBoundingClientRect());
            const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
              && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
            const entries = spans.map((span, index) => {
              const node = span.firstChild;
              const text = node?.textContent ?? "";
              const lines = [];
              for (let offset = 0; node && offset < text.length; offset++) {
                const range = document.createRange();
                range.setStart(node, offset);
                range.setEnd(node, offset + 1);
                lines.push(range.getBoundingClientRect().top);
              }
              const splits = [];
              for (let i = 1; i < lines.length; i++) {
                if (Math.abs(lines[i] - lines[i - 1]) > 1 && /[\p{L}\p{N}]/u.test(text[i - 1]) && /[\p{L}\p{N}]/u.test(text[i])) {
                  splits.push(i);
                }
              }
              const overlap = rects.some((other, otherIndex) => otherIndex !== index && intersects(rects[index], other))
                || (edit && intersects(rects[index], edit.getBoundingClientRect()));
              return { text, splits, overflow: span.scrollWidth - span.clientWidth, overlap: Boolean(overlap) };
            });
            return { entries, overflow: values.scrollWidth - values.clientWidth };
          });
          assert(metadata.entries.length === 4 && metadata.overflow <= 1 && metadata.entries.every((item) =>
            item.splits.length === 0 && item.overflow <= 1 && !item.overlap), `카드 실행 설정이 쪼개지거나 넘치거나 겹쳤다: ${JSON.stringify(metadata)}`);
          const panelHit = await panel.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return Boolean(document.elementFromPoint(box.left + box.width * .75, box.top + box.height * .25)?.closest('[data-testid="v3-card-workspace"]'));
          });
          assert(panelHit, "카드 패널이 다른 층에 가렸다");
          await page.screenshot({ path: join(captureDir, `${viewport.id}-${theme}-card.png`) });
          await page.keyboard.press("Escape");
          await panel.waitFor({state:"hidden"});
          assert(await page.getByTestId("pas-rt1707-open-card-panel").evaluate((el) => el === document.activeElement), "카드 패널 닫기 뒤 초점이 돌아오지 않았다");
          assert(Math.abs(await page.locator(".pas-rt1707-thread-scroll").evaluate((el) => el.scrollTop) - scrollBeforePanel) <= 1, "카드 패널을 닫고 스크롤 위치가 바뀌었다");
          assert((await unmocked(page)).length === 0, "카드 패널에서 등록되지 않은 API를 호출했다");
          if (viewport.width <= 767) {
            await selectRail(page, 1408);
            const heading = await page.evaluate(() => {
              const title = document.querySelector(".pas-rt1707-report-title"), head = document.querySelector(".pas-rt1707-report-head");
              const buttons = [...head.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
              const titleRow = title.parentElement.getBoundingClientRect();
              const titleParts = [...title.parentElement.children].map((child) => {
                const part = child.getBoundingClientRect();
                return (part.top + part.bottom) / 2;
              });
              return {text:title.textContent, clipped:title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1,
                tops:buttons.map((r) => r.top), heights:buttons.map((r) => r.height),
                titleBelowTools: titleRow.top >= Math.max(...buttons.map((r) => r.bottom)),
                titlePartsAligned: Math.max(...titleParts) - Math.min(...titleParts) <= 1};
            });
            assert(heading.text.includes("슬라이드 편집 장 순서 변경과 줄간격 보정") && !heading.clipped, `긴 제목이 잘렸다: ${JSON.stringify(heading)}`);
            assert(Math.max(...heading.tops) - Math.min(...heading.tops) <= 1 && Math.max(...heading.heights) - Math.min(...heading.heights) <= 1, "머리 도구 단추가 한 줄이 아니다");
            assert(heading.titleBelowTools && heading.titlePartsAligned, "머리 제목, 번호, 상태가 도구 아래 한 줄에 있지 않다");
            const titleSplits = await koreanSplits(page);
            assert(titleSplits.length === 0, `긴 제목의 한글 줄바꿈: ${titleSplits.join(", ")}`);
            await page.screenshot({ path: join(captureDir, `${viewport.id}-${theme}-long-title.png`) });
            await selectRail(page, 1680);
          }
          return { dialog: { width: dialog.width, height: dialog.height }, portraits: images.portraits.length, band: band.band, rightGap: band.rightGap,
            choiceCenter: center, pageOverflow, railThreadTopDifference, changedPanelPixels: changedPixels };
        });
        {
          await check(`${viewport.id} 선택지와 결재 단추 크기`, async () => {
            const choices = await choiceButtons(page);
            const agendas = {};
            for (const number of [1680, 1512, 1387, 1408, 1112]) {
              await selectRail(page, number);
              const splits = await koreanSplits(page);
              assert(splits.length === 0, `#${number} 한글 어절 중간 줄바꿈: ${splits.join(", ")}`);
              const bottom = await page.locator(".pas-rt1707-thread-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
              assert(bottom <= 4, `#${number} 전환 뒤 최신 경과가 보이지 않는다: ${bottom}`);
              assert(await page.getByTestId("pas-rt1707-snooze-trigger").isVisible(), `#${number} 답변 미루기가 없다`);
              const before = await decisionButtons(page);
              await page.locator(".pas-rt1707-stamps button").first().click();
              await wait(300);
              const after = await decisionButtons(page);
              assert(after.some((button) => button.text === "되돌리기"), `#${number} 처분 뒤 되돌리기 단추가 없다`);
              assert(await page.locator(".pas-rt1707-undo").evaluate((el) => el === document.activeElement), `#${number} 처분 뒤 되돌리기에 초점이 없다`);
              agendas[number] = { before, after };
              await page.locator(".pas-rt1707-undo").click();
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

    if (scope === "all" || scope === "review") {
      await check("검수 보완 기본 동작", async () => {
        const page = await newPage(browser, {width:1440, height:900}, "dark");
        await gotoReport(page, "dark");
        assert(await page.locator('input[type="radio"]').count() === 0, "기본 라디오가 남았다");
        assert(await page.getByRole("button", {name:"되묻기", exact:true}).isVisible(), "정본 되묻기 단추가 없다");
        assert(await page.locator(".pas-rt1707-decide-hint").count() === 0, "기본 중복 안내가 남았다");
        const summary = page.locator(".pas-rt1707-summary p");
        await summary.scrollIntoViewIfNeeded();
        const textBounds = await summary.evaluate((el) => {
          const range = document.createRange();
          range.setStart(el.firstChild, 0);
          range.setEnd(el.firstChild, 6);
          const rect = range.getBoundingClientRect();
          return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
        });
        const selectedText = () => page.evaluate(() => window.getSelection().toString().trim());
        await page.mouse.move(textBounds.left + 1, textBounds.y);
        await page.mouse.down();
        await page.mouse.move(textBounds.right - 1, textBounds.y, { steps: 5 });
        await page.mouse.up();
        assert((await selectedText()).length > 1, "결과 요약을 끌어서 선택할 수 없다");
        await page.evaluate(() => window.getSelection().removeAllRanges());
        await page.mouse.dblclick(textBounds.left + 4, textBounds.y);
        assert((await selectedText()).length > 0, "결과 요약을 두 번 눌러 선택할 수 없다");
        await page.getByRole("button", {name:"되묻기", exact:true}).click();
        await page.locator(".pas-rt1707-choice").first().click();
        await wait(450);
        assert((await reportStatus(page)) === "완료", "되묻기 알림이 있을 때 선택지를 누르지 못했다");
        await page.locator(".pas-rt1707-undo").click();
        await page.locator(".v3-card-target-notice").waitFor();
        await page.getByTestId("pas-rt1707-snooze-trigger").click();
        assert(await page.getByRole("button", {name:"오늘 저녁", exact:true}).isVisible(), "되묻기 알림이 있을 때 미루기를 열지 못했다");
        await page.keyboard.press("Escape");
        await page.locator(".v3-card-target-notice button").click();
        await page.setViewportSize({width:390, height:844});
        await wait(400);
        await page.getByTestId("pas-rt1707-snooze-trigger").click();
        await page.getByRole("button", {name:"오늘 저녁", exact:true}).click();
        await wait(200);
        const toggle = page.getByTestId("pas-rt1707-rail-toggle");
        const afterSnooze = await page.evaluate(() => ({tag:document.activeElement?.tagName, label:document.activeElement?.getAttribute("aria-label"), width:innerWidth}));
        assert(await toggle.evaluate((el) => el === document.activeElement), `모바일 미루기 뒤 안건 목록 단추에 초점이 없다: ${JSON.stringify(afterSnooze)}`);
        await toggle.click();
        await page.waitForFunction(() => document.activeElement?.matches('.pas-rt1707-rail-item[data-active="true"]'));
        await page.locator('.pas-rt1707-rail-item').filter({hasText:"#1680"}).click();
        await wait(200);
        assert(await toggle.evaluate((el) => el === document.activeElement), "모바일 안건 선택 뒤 안건 목록 단추에 초점이 없다");
        await page.close();
        return {radio:0, dragSelection:true, doubleClickSelection:true, noticeChoice:true, noticeSnooze:true, mobileSnoozeFocus:true, mobileSelectionFocus:true};
      });
      for (const viewport of [{width:1440, height:900}, {width:390, height:844}]) {
        await check(`${viewport.width} 지시 보내기와 연속 처분 뒤 되돌리기 초점`, async () => {
          const page = await newPage(browser, viewport, "dark");
          await gotoReport(page, "dark");
          const input = page.locator(".pas-rt1707-composer-drawer textarea");
          const undo = page.locator(".pas-rt1707-undo");
          const focusState = () => page.evaluate(() => ({ tag: document.activeElement?.tagName,
            className: String(document.activeElement?.className ?? "").slice(0, 40), text: document.activeElement?.textContent?.trim().slice(0, 20) }));
          const undoFocused = async (step) => {
            const state = await focusState();
            assert(state.tag !== "BODY" && await undo.evaluate((el) => el === document.activeElement), `${step} 뒤 되돌리기에 초점이 없다: ${JSON.stringify(state)}`);
          };
          await page.getByRole("button", {name:"되묻기", exact:true}).click();
          await input.fill("왜 일주일이 적절한가요?");
          await page.locator('.pas-rt1707-composer-drawer [aria-label="되묻기 전송"]').click();
          await wait(300);
          assert(await page.locator('[data-testid="card-composer"]').count() === 0, "되묻기를 보낸 뒤 입력창이 닫히지 않았다");
          await undoFocused("#1680 되묻기 보내기");
          await page.locator(".pas-rt1707-decide .pas-rt1707-choice").filter({hasText:"최근 7일 유지"}).first().click();
          await wait(300);
          assert((await reportStatus(page)) === "완료", "되돌리기가 떠 있는 채로 누른 선택지가 반영되지 않았다");
          await undoFocused("#1680 연속 선택지");
          await undo.click();
          await wait(300);
          await selectRail(page, 1512);
          await page.getByTestId("pas-rt1707-open-composer").click();
          await input.fill("확인 부탁");
          await page.locator('.pas-rt1707-composer-drawer [aria-label="커멘트 전송"]').click();
          await wait(300);
          await undoFocused("#1512 지시 보내기");
          await undo.click();
          await wait(300);
          assert((await reportStatus(page)) === "검수 대기", "#1512 지시 되돌리기가 실패했다");
          await page.close();
          return { width: viewport.width, followupSend: "되돌리기", chainedChoice: "되돌리기", plainSend: "되돌리기" };
        });
      }
    }
    if (scope === "all" || scope === "review") {
      for (const viewport of [{width:1440, height:900}, {width:390, height:844}]) {
        await check(`${viewport.width} 단추 줄 아래 입력창과 닫은 뒤 초점`, async () => {
          const page = await newPage(browser, viewport, "dark");
          await gotoReport(page, "dark");
          const composer = page.locator('[data-testid="card-composer"]');
          const input = page.locator(".pas-rt1707-composer-drawer textarea");
          assert(await composer.count() === 0, "처음부터 입력창이 펼쳐져 있다");
          const results = {};
          const scrollState = () => page.locator(".pas-rt1707-thread-scroll").evaluate((el) => ({ distance: el.scrollHeight - el.scrollTop - el.clientHeight,
            scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, auto: el.dataset.autoScroll }));
          const openAndMeasure = async (name, slug, trigger, placeholder, close, notice, sendLabel) => {
            const beforeOpen = await scrollState();
            await trigger.click();
            await composer.waitFor();
            await wait(200);
            assert(await input.evaluate((el) => el === document.activeElement), `${name} 뒤 입력창에 초점이 없다`);
            assert(await input.getAttribute("placeholder") === placeholder, `${name} 입력 안내가 다르다: ${await input.getAttribute("placeholder")}`);
            const noticeText = (await textOf(page, ".pas-rt1707-composer-drawer .v3-card-target-notice > span"))?.trim();
            assert(noticeText === notice, `${name} 입력창 알림 문구가 다르다: ${noticeText}`);
            assert(await page.locator(`.pas-rt1707-composer-drawer [aria-label="${sendLabel}"]`).count() === 1, `${name} 전송 단추 이름이 ${sendLabel}이 아니다`);
            const geometry = await composerGeometry(page);
            assert(geometry && geometry.composerTop >= geometry.stampsBottom + 8, `${name} 입력창이 단추 줄 아래에 있지 않다: ${JSON.stringify(geometry)}`);
            assert(Math.abs(geometry.textTop - geometry.textBottom) <= 2 && geometry.sendCenterDifference <= 2,
              `${name} 입력창 글과 전송 단추가 세로 가운데가 아니다: ${JSON.stringify(geometry)}`);
            const band = await decideBand(page);
            assertBand(band, viewport.width, `${name} 입력창을 연 뒤`);
            const afterOpen = await scrollState();
            assert(afterOpen.distance <= 4, `${name} 입력창을 연 뒤 최신 경과 바닥에서 벗어났다: ${JSON.stringify({ beforeOpen, afterOpen })}`);
            await page.screenshot({ path: join(captureDir, `${viewport.width}x${viewport.height}-dark-composer-${slug}.png`) });
            if (close === "escape") { await input.press("Escape"); } else { await page.locator(".pas-rt1707-composer-drawer .v3-card-target-notice button").click(); }
            await wait(200);
            assert(await page.getByTestId("pas-report-thread-dialog").isVisible(), `${name} 입력창을 닫으며 보고 창도 닫혔다`);
            assert(await composer.count() === 0, `${name} 입력창이 닫히지 않았다`);
            assert(await trigger.evaluate((el) => el === document.activeElement), `${name} 입력창을 닫은 뒤 누른 단추로 초점이 돌아오지 않았다`);
            results[name] = { ...geometry, band: band.band, close };
          };
          await openAndMeasure("되묻기", "ask", page.getByRole("button", {name:"되묻기", exact:true}), "물어볼 것", "clear", "되묻기", "되묻기 전송");
          await openAndMeasure("다르게 답하기", "answer", page.getByRole("button", {name:"다르게 답하기", exact:true}), "다르게 답하기", "escape", "다르게 답하기", "답 전송");
          await selectRail(page, 1512);
          await openAndMeasure("지시 적기", "comment", page.getByTestId("pas-rt1707-open-composer"), "커멘트", "escape", "커멘트", "커멘트 전송");
          await page.close();
          return results;
        });
      }
    }
    if (scope === "all" || scope === "review") {
      for (const viewport of [{width:1440, height:900}, {width:390, height:844}]) {
        await check(`${viewport.width} 지시 적기를 닫은 뒤 항목 지시 초점 복귀`, async () => {
          const page = await newPage(browser, viewport, "dark");
          await gotoReport(page, "dark");
          await selectRail(page, 1512);
          const composer = page.locator('[data-testid="card-composer"]');
          const input = page.locator(".pas-rt1707-composer-drawer textarea");
          await page.getByTestId("pas-rt1707-open-composer").click();
          await composer.waitFor();
          await input.press("Escape");
          await wait(200);
          const focusState = () => page.evaluate(() => ({ tag: document.activeElement?.tagName,
            className: String(document.activeElement?.className ?? "").slice(0, 40), label: document.activeElement?.getAttribute("aria-label") }));
          const results = {};
          for (const [index, close] of [[0, "escape"], [1, "clear"]]) {
            const trigger = page.locator(".pas-rt1707-check-instruct").nth(index);
            await trigger.click();
            await composer.waitFor();
            await wait(200);
            assert(await input.evaluate((el) => el === document.activeElement), `${index + 1}번 항목 지시 뒤 입력창에 초점이 없다`);
            if (close === "escape") await input.press("Escape"); else await page.locator(".pas-rt1707-composer-drawer .v3-card-target-notice button").click();
            await wait(200);
            assert(await composer.count() === 0, `${index + 1}번 항목 입력창이 닫히지 않았다`);
            const state = await focusState();
            assert(await trigger.evaluate((el) => el === document.activeElement), `${index + 1}번 항목 입력창을 ${close}로 닫은 뒤 그 항목 지시 단추로 초점이 돌아오지 않았다: ${JSON.stringify(state)}`);
            results[`${index + 1}번`] = { close, focus: state.label };
          }
          await page.close();
          return results;
        });
      }
      for (const viewport of [{id:"1440x900", width:1440, height:900}, {id:"820x1180", width:820, height:1180}, {id:"390x844", width:390, height:844}, {id:"360x780", width:360, height:780}]) {
        await check(`${viewport.id} 레일 구역 간격과 결재 단추 알약`, async () => {
          const page = await newPage(browser, viewport, "dark");
          await gotoReport(page, "dark");
          const mobile = viewport.width <= 767;
          if (mobile) {
            await page.getByTestId("pas-rt1707-rail-toggle").click();
            await page.waitForFunction(() => document.activeElement?.matches('.pas-rt1707-rail-item[data-active="true"]'));
          }
          // 레일과 결재 단추 결함을 서로 가리지 않게 모아서 한 번에 판정한다.
          const errors = [];
          const collect = (fn) => { try { fn(); } catch (error) { errors.push(error.message); } };
          const rail = await railSections(page);
          collect(() => assertRailSections(rail, viewport.id));
          if (mobile) { await page.keyboard.press("Escape"); await wait(200); }
          const pills = {};
          for (const number of [1680, 1512]) {
            if (number !== 1680) await selectRail(page, number);
            const result = await decidePills(page);
            collect(() => assert(result.buttons.length >= 2 && result.notPill.length === 0, `#${number} 결재 단추가 알약이 아니다: ${JSON.stringify(result.notPill)}`));
            collect(() => assert(result.rowSpread.every((spread) => spread <= 1), `#${number} 같은 줄 결재 단추 높이가 다르다: ${JSON.stringify(result)}`));
            collect(() => assert(result.fontSizes.length === 1, `#${number} 결재 단추 글자 크기가 정본 되묻기 단추와 다르다: ${JSON.stringify(result.buttons.map((b) => [b.text, b.fontSize]))}`));
            const band = await decideBand(page);
            collect(() => assertBand(band, viewport.width, `#${number}`));
            if (viewport.width === 1440) collect(() => assert(band.rightGap !== null && Math.abs(band.rightGap) <= 1, `#${number} 오른쪽 끝선이 어긋난다: ${JSON.stringify(band)}`));
            pills[number] = { heights: [...new Set(result.buttons.map((b) => b.height))], fontSizes: result.fontSizes, band: band.band, rightGap: band.rightGap };
          }
          await page.close();
          assert(errors.length === 0, errors.join(" / "));
          return { rail: { pairs: rail.pairs, rowTextGap: rail.rowTextGap, headToFirst: rail.headToFirst, startSpread: rail.startSpread }, pills };
        });
      }
    }
    if (scope === "all" || scope === "operations") {
      await check("대화상자 Enter와 첫 초점", async () => {
        const page = await newPage(browser, {width:1440, height:900}, "dark");
        await gotoPas(page, "dark");
        const trigger = page.locator('[data-testid="pas-report-bubble"] .pas-rt1707-open-report');
        await trigger.focus();
        await page.keyboard.press("Enter");
        await page.getByTestId("pas-report-thread-dialog").waitFor();
        await page.waitForFunction(() => document.activeElement?.matches('.pas-rt1707-rail-item[data-active="true"]'));
        await page.getByRole("button", {name:"다르게 답하기", exact:true}).click();
        const input = page.locator(".pas-rt1707-composer-drawer textarea");
        await input.fill("첫 줄");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await page.keyboard.type("둘째 줄");
        assert((await input.inputValue()).includes("\n"), "입력창의 Enter가 줄바꿈하지 않았다");
        await input.fill("");
        const snooze = page.getByTestId("pas-rt1707-snooze-trigger");
        await snooze.focus();
        await page.keyboard.press("Enter");
        assert(await page.getByRole("button", {name:"오늘 저녁", exact:true}).isVisible(), "Enter로 미루기 선택이 열리지 않았다");
        assert(await snooze.evaluate((el) => el === document.activeElement), "미루기 선택을 연 뒤 초점이 트리거에 있지 않다");
        await page.keyboard.press("Escape");
        assert(await snooze.evaluate((el) => el === document.activeElement), "미루기 선택을 닫고 초점이 돌아오지 않았다");
        await page.setViewportSize({width:390, height:844});
        await wait(400);
        const toggle = page.getByTestId("pas-rt1707-rail-toggle");
        await toggle.focus();
        await page.keyboard.press("Enter");
        assert(await page.locator(".pas-rt1707-rail").isVisible(), "Enter로 안건 서랍이 열리지 않았다");
        await page.waitForFunction(() => document.activeElement?.matches('.pas-rt1707-rail-item[data-active="true"]'));
        await page.keyboard.press("Escape");
        assert(await toggle.evaluate((el) => el === document.activeElement), "안건 서랍을 닫고 초점이 돌아오지 않았다");
        await page.setViewportSize({width:1440, height:900});
        await wait(400);
        const evidence = page.locator(".pas-rt1707-evidence-button").first();
        await evidence.focus();
        await page.keyboard.press("Enter");
        const evidenceDialog = page.getByTestId("pas-report-evidence-dialog");
        await evidenceDialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.closest('[data-testid="pas-report-evidence-dialog"]'));
        const evidenceFocus = await page.evaluate(() => ({
          inside: Boolean(document.activeElement?.closest('[data-testid="pas-report-evidence-dialog"]')),
          label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim(),
        }));
        assert(evidenceFocus.inside, "증거 창의 첫 초점이 창 안에 없다");
        await page.keyboard.press("Escape");
        await evidenceDialog.waitFor({state:"hidden"});
        await wait(250);
        assert(await evidence.evaluate((el) => el === document.activeElement), "증거 창을 닫고 초점이 돌아오지 않았다");
        await selectRail(page, 1387);
        const documentButton = page.locator(".pas-rt1707-document-row button");
        await documentButton.focus();
        await page.keyboard.press("Enter");
        const documentDialog = page.getByTestId("internal-document-dialog");
        await documentDialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "문서 본문");
        await page.keyboard.press("Escape");
        await documentDialog.waitFor({state:"hidden"});
        await wait(250);
        assert(await documentButton.evaluate((el) => el === document.activeElement), "문서 창을 닫고 초점이 돌아오지 않았다");
        const panelTrigger = page.getByTestId("pas-rt1707-open-card-panel");
        await panelTrigger.focus();
        await page.keyboard.press("Enter");
        const panel = page.getByTestId("v3-card-workspace");
        await panel.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "카드 닫기");
        await page.keyboard.press("Enter");
        await panel.waitFor({state:"hidden"});
        await wait(250);
        assert(await panelTrigger.evaluate((el) => el === document.activeElement), "Enter로 카드 패널을 닫고 초점이 돌아오지 않았다");
        const close = page.getByLabel("보고 창 닫기");
        await close.focus();
        await page.keyboard.press("Enter");
        await page.getByTestId("pas-report-thread-dialog").waitFor({state:"hidden"});
        await wait(250);
        assert(await trigger.evaluate((el) => el === document.activeElement), "Enter로 보고 창을 닫고 초점이 돌아오지 않았다");
        await page.close();
        return {report:"안건에 첫 초점, Enter 줄바꿈", snooze:"트리거 초점", drawer:"활성 안건 초점", evidenceFocus, document:"본문에 첫 초점", panel:"닫기 단추에 첫 초점"};
      });
    }
    if (scope === "all" || scope === "flows" || scope === "critical" || scope === "remaining") {
    const viewport = { width: 1440, height: 900 };
    const page = await newPage(browser, viewport, "dark");
    await gotoPas(page, "dark");

    if (scope !== "remaining") {
    await check("직접 #report 진입", async () => {
      await gotoReport(page, "dark");
      assert(await page.locator('[data-testid="pas-report-thread-dialog"]').isVisible(), "보고 창이 보이지 않는다");
      assert(await page.locator('.pas-rt1707-rail-item[data-active="true"]').evaluate((el) => el === document.activeElement), "보고 창의 첫 초점이 현재 안건에 있지 않다");
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
        assertBand(band, 1440, `#${number}`);
        bands[number] = band.band;
      }
      await selectRail(page, 1680);
      return bands;
    });

    await check("미루기와 해제 및 되돌리기", async () => {
      await selectRail(page, 1680);
      await page.getByTestId("pas-rt1707-snooze-trigger").click();
      await page.keyboard.press("Escape");
      assert(await page.getByTestId("pas-report-thread-dialog").isVisible(), "시간 선택을 닫으며 보고 창도 닫혔다");
      assert(!(await page.getByRole("button", {name:"오늘 저녁", exact:true}).isVisible()), "Escape로 시간 선택이 닫히지 않았다");
      await page.getByTestId("pas-rt1707-snooze-trigger").click();
      await page.getByRole("button", {name:"오늘 저녁", exact:true}).click();
      await wait(300);
      assert((await textOf(page, ".pas-rt1707-report-heading")).includes("#1512"), "다음 결재 대기로 이동하지 않았다");
      assert(await page.locator('.pas-rt1707-rail-item[data-active="true"]').evaluate((el) => el === document.activeElement), "미루기 뒤 활성 안건에 초점이 없다");
      assert(await textOf(page, ".pas-rt1707-undo") === "#1680 미루기 되돌리기", "되돌리기에 미룬 안건과 동작이 드러나지 않는다");
      assert((await textOf(page, '[data-testid="pas-report-bubble"]')).includes("1 / 4"), "대기 수가 줄지 않았다");
      assert((await textOf(page, ".pas-rt1707-hold-note")).includes("18개"), "보류함 수가 달라졌다");
      assert((await textOf(page, 'section[aria-label="미뤄 둠"]')).includes("오늘 저녁"), "미룬 카드와 시각이 없다");
      await selectRail(page, 1680);
      assert((await textOf(page, ".pas-rt1707-decide")).includes("미뤄 둠: 오늘 저녁"), "미룬 시각 안내가 없다");
      await page.getByRole("button", {name:"미루기 해제"}).click();
      assert(await page.getByTestId("pas-rt1707-snooze-trigger").isVisible(), "미루기 해제가 실패했다");
      await page.getByTestId("pas-rt1707-snooze-trigger").click();
      await page.getByRole("button", {name:"1시간 뒤", exact:true}).click();
      await page.getByRole("button", {name:"되돌리기"}).click();
      assert((await textOf(page, ".pas-rt1707-report-heading")).includes("#1680"), "되돌린 카드가 열리지 않았다");
      assert(await page.getByTestId("pas-rt1707-snooze-trigger").isVisible(), "미루기 되돌리기가 실패했다");
      await selectRail(page, 1408);
      await page.getByTestId("pas-rt1707-snooze-trigger").click();
      await page.getByRole("button", {name:"내일 아침", exact:true}).click();
      assert((await textOf(page, ".pas-rt1707-report-heading")).includes("#1112"), "현재 안건 다음의 결재 대기로 이동하지 않았다");
      await page.getByRole("button", {name:"되돌리기"}).click();
      for (const number of [1512, 1387, 1112]) {
        await selectRail(page, number);
        await page.getByTestId("pas-rt1707-snooze-trigger").click();
        await page.getByRole("button", {name:"사흘 뒤", exact:true}).click();
        await selectRail(page, number);
        assert((await textOf(page, ".pas-rt1707-decide")).includes("미뤄 둠: 사흘 뒤"), `#${number} 미루기가 보이지 않는다`);
        await page.getByRole("button", {name:"미루기 해제"}).click();
        assert(await page.getByTestId("pas-rt1707-snooze-trigger").isVisible(), `#${number} 미루기 해제가 실패했다`);
      }
      await selectRail(page, 1680);
      return {hold:18};
    });

    await check("되묻기와 글 답 확정", async () => {
      const input = page.locator(".pas-rt1707-composer-drawer textarea");
      assert(await page.locator('[data-testid="card-composer"]').count() === 0, "되묻기 전부터 입력창이 펼쳐져 있다");
      const askBack = page.getByRole("button", {name:"되묻기", exact:true});
      await askBack.click();
      const notice = page.locator(".v3-card-target-notice");
      assert(await notice.isVisible() && (await notice.textContent()).includes("되묻기"), "되묻기 알림이 없다");
      assert(await input.getAttribute("placeholder") === "물어볼 것", "되묻기 입력 안내가 다르다");
      assert(await page.locator(".pas-rt1707-choice").first().isVisible() && await page.getByTestId("pas-rt1707-snooze-trigger").isVisible(), "되묻기 중 선택 동작이 가려졌다");
      for (const selector of [".pas-rt1707-choice", '[data-testid="pas-rt1707-snooze-trigger"]']) {
        const hit = await page.locator(selector).first().evaluate((el, target) => {
          const r = el.getBoundingClientRect();
          return !el.disabled && Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(target));
        }, selector);
        assert(hit, `되묻기 중 단추를 누를 수 없다: ${selector}`);
      }
      await page.locator(".v3-card-target-notice button").click();
      await wait(100);
      assert(await askBack.evaluate((el) => el === document.activeElement), "되묻기 해제 뒤 되묻기 단추로 초점이 돌아오지 않았다");
      assert(await page.locator('[data-testid="card-composer"]').count() === 0, "되묻기 해제 뒤 입력창이 남았다");
      await askBack.click();
      await input.fill("왜 일주일이 적절한가요?");
      await page.locator('.pas-rt1707-composer-drawer [aria-label="되묻기 전송"]').click();
      await wait(450);
      assert(await page.locator(".pas-rt1707-choice").first().isVisible(), "되묻기가 질문을 닫았다");
      const thread = await textOf(page, ".pas-rt1707-thread-scroll");
      assert(thread.includes("왜 일주일이 적절한가요?") && thread.includes("선택지는 그대로 열어"), "문답이 경과에 없다");
      const phases = await page.locator(".pas-rt1707-event-number").allTextContents();
      const resultIndex = await page.locator(".pas-rt1707-event").evaluateAll((items) => items.findIndex((item) => item.dataset.kind === "result"));
      assert(resultIndex >= 0 && resultIndex < phases.length - 1 && phases[resultIndex] === "3" && phases.slice(resultIndex).every((phase) => phase === "3")
        && phases.every((phase, index) => index === 0 || Number(phase) >= Number(phases[index - 1])), `경과 단계가 잘못됐다: ${phases}`);
      assert(await page.locator(".pas-rt1707-decide-phase").count() === 0, "결재 상자 위 단계 라벨 줄이 남았다");
      await page.locator(".pas-rt1707-undo").click();
      await wait(450);
      await page.getByRole("button", {name:"다르게 답하기", exact:true}).click();
      await input.fill("최근 일주일로 정합니다");
      await page.locator('.pas-rt1707-composer-drawer [aria-label="답 전송"]').click();
      await wait(450);
      assert((await reportStatus(page)) === "완료", "글 답이 확정되지 않았다");
      await page.locator(".pas-rt1707-undo").click();
      await wait(450);
      return {followup:"열림", answer:"완료"};
    });

    await check("진행 경과와 자동 스크롤", async () => {
      await selectRail(page, 1730);
      assert((await page.locator(".pas-rt1707-turns").count()) === 0, "0턴 펼침이 표시된다");
      const scroll = page.locator(".pas-rt1707-thread-scroll");
      const distance = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      assert(await distance() <= 4, "전환 직후 최신 경과가 아니다");
      await page.getByTestId("pas-rt1707-simulate-event").click();
      await wait(300);
      assert(await distance() <= 4, "새 경과를 따라가지 않았다");
      await scroll.evaluate((el) => {el.scrollTop = 0; el.dispatchEvent(new Event("scroll"));});
      await wait(200);
      const jump = page.getByTestId("pas-rt1707-jump-latest");
      assert((await jump.textContent()).includes("최신 경과로"), "최신 경과로 단추가 없다");
      await jump.click();
      assert(await distance() <= 4 && await scroll.evaluate((el) => el === document.activeElement), "최신 경과로 이동한 뒤 스레드에 초점이 없다");
      await scroll.evaluate((el) => {el.scrollTop = 0; el.dispatchEvent(new Event("scroll"));});
      await wait(200);
      const before = await scroll.evaluate((el) => ({top:el.scrollTop,height:el.clientHeight}));
      await page.getByTestId("pas-rt1707-simulate-event").click();
      await wait(300);
      const after = await scroll.evaluate((el) => ({top:el.scrollTop,height:el.clientHeight}));
      assert(Math.abs(after.top-before.top) <= 1 && after.height === before.height, "읽던 위치나 스레드 높이가 바뀌었다");
      assert((await jump.textContent()).includes("새 경과"), "새 경과 표시가 없다");
      assert(await jump.evaluate((el) => getComputedStyle(el).position) === "absolute", "단추가 겹쳐 뜨지 않는다");
      assert(await jump.evaluate((el) => getComputedStyle(el).userSelect) === "none", "최신 경과 단추의 글을 선택할 수 있다");
      await page.screenshot({ path: join(captureDir, "1440x900-dark-autoscroll-pill.png") });
      await jump.click();
      assert(await distance() <= 4 && !(await jump.isVisible()), "최신 경과로 돌아가지 않았다");
      assert(await scroll.evaluate((el) => el === document.activeElement), "최신 경과 복귀 뒤 스레드에 초점이 없다");
      return {position:after.top};
    });

    await check("정본 카드 패널과 초점 복귀", async () => {
      await selectRail(page, 1408);
      await page.getByTestId("pas-rt1707-open-card-panel").click();
      const panel = page.getByTestId("v3-card-workspace");
      await panel.waitFor({state:"visible"});
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "카드 닫기");
      assert((await panel.textContent()).includes("슬라이드 편집"), "선택한 카드가 열리지 않았다");
      const hit = await panel.evaluate((el) => {const r=el.getBoundingClientRect(); return Boolean(document.elementFromPoint(r.left+r.width*.75,r.top+r.height*.25)?.closest('[data-testid="v3-card-workspace"]'));});
      assert(hit, "카드 패널이 다른 층에 가렸다");
      await page.keyboard.press("Escape");
      await panel.waitFor({state:"hidden"});
      assert(await page.getByTestId("pas-report-thread-dialog").isVisible(), "보고 창도 닫혔다");
      assert(await page.getByTestId("pas-rt1707-open-card-panel").evaluate((el) => el === document.activeElement), "초점이 카드 열기 단추에 돌아오지 않았다");
      const fileButton = page.getByRole("button", {name:"카드 패널에서 변경 파일 보기"});
      await fileButton.click();
      await panel.waitFor({state:"visible"});
      const fileScroll = await page.locator(".pas-rt1707-thread-scroll").evaluate((el) => el.scrollTop);
      await page.getByLabel("카드 닫기").click();
      await panel.waitFor({state:"hidden"});
      await wait(100);
      assert(await fileButton.evaluate((el) => el === document.activeElement), "변경 파일 진입점에 초점이 돌아오지 않았다");
      assert(Math.abs(await page.locator(".pas-rt1707-thread-scroll").evaluate((el) => el.scrollTop) - fileScroll) <= 1, "변경 파일을 닫고 스크롤 위치가 바뀌었다");
      assert((await unmocked(page)).length === 0, `등록되지 않은 API: ${(await unmocked(page)).join(", ")}`);
      await selectRail(page, 1680);
      return {topLayer:true};
    });

    await check("안건 서랍과 미루기 키보드 조작", async () => {
      await selectRail(page, 1680);
      const snooze = page.getByTestId("pas-rt1707-snooze-trigger");
      await snooze.focus();
      await page.keyboard.press("Enter");
      assert(await page.getByRole("button", {name:"오늘 저녁", exact:true}).isVisible(), "Enter로 미루기 선택이 열리지 않았다");
      await page.keyboard.press("Escape");
      assert(!(await page.getByRole("button", {name:"오늘 저녁", exact:true}).isVisible()), "Escape로 미루기 선택이 닫히지 않았다");
      assert(await snooze.evaluate((el) => el === document.activeElement), "미루기 선택을 닫고 초점이 돌아오지 않았다");
      await page.setViewportSize({width:390, height:844});
      await wait(400);
      const toggle = page.getByTestId("pas-rt1707-rail-toggle");
      await toggle.focus();
      await page.keyboard.press("Enter");
      assert(await page.locator(".pas-rt1707-rail").isVisible(), "Enter로 안건 서랍이 열리지 않았다");
      await page.keyboard.press("Escape");
      assert(!(await page.locator(".pas-rt1707-rail").isVisible()), "Escape로 안건 서랍이 닫히지 않았다");
      assert(await toggle.evaluate((el) => el === document.activeElement), "서랍을 닫고 초점이 돌아오지 않았다");
      await page.setViewportSize({width:1440, height:900});
      await wait(400);
      return {snooze:"Enter와 Escape", drawer:"Enter와 Escape"};
    });

    let stable;
    await check("질문 답과 고정 높이 되돌리기", async () => {
      const before = {
        title: await rect(page, ".pas-rt1707-report-title"),
        decide: await rect(page, ".pas-rt1707-decide"),
      };
      assert(await page.locator(".pas-rt1707-undo").count() === 0, "처분 전부터 되돌리기 자리가 있다");
      await clickText(page, ".pas-rt1707-decide .pas-rt1707-choice", "최근 7일 유지");
      await wait(350);
      assert((await reportStatus(page)) === "완료", `답을 고른 뒤 상태가 완료가 아니다: ${await reportStatus(page)}`);
      assert((await textOf(page, ".pas-rt1707-answer-line"))?.includes("받은 답: 최근 7일 유지"), "받은 답 줄이 서지 않았다");
      assert((await (await railItem(page, 1680)).textContent())?.includes("완료"), "레일에 완료 상태가 표시되지 않는다");
      const after = {
        title: await rect(page, ".pas-rt1707-report-title"),
        decide: await rect(page, ".pas-rt1707-decide"),
        undo: await rect(page, ".pas-rt1707-undo"),
      };
      assert(Math.abs(before.title.top - after.title.top) <= 0.5, `제목이 ${after.title.top - before.title.top}px 움직였다`);
      const reference = await rect(page, '[data-testid="pas-rt1707-open-composer"]');
      assert(Math.abs(after.undo.height - reference.height) <= 1, `되돌리기 단추 높이가 옆 단추와 다르다: ${after.undo.height}, ${reference.height}`);
      const afterBand = await decideBand(page);
      assert(afterBand.rightGap !== null && Math.abs(afterBand.rightGap) <= 2 && afterBand.lastSecondary === "되돌리기", `처분 뒤 되돌리기가 오른쪽 끝에 있지 않다: ${JSON.stringify(afterBand)}`);
      assert((await textOf(page, ".pas-rt1707-undo")) === "되돌리기", "되돌리기 단추가 없다");
      await page.locator(".pas-rt1707-undo").click();
      await wait(350);
      assert((await reportStatus(page)) === "질문", `되돌린 뒤 상태가 질문이 아니다: ${await reportStatus(page)}`);
      assert((await page.locator('section[aria-label="결재 대기"] .pas-rt1707-rail-item [data-slot="status-chip"]').count()) === 0, "되돌린 뒤 레일에 상태 칩이 남았다");
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
    } else {
      await gotoReport(page, "dark");
      await clickText(page, ".pas-rt1707-decide .pas-rt1707-choice", "최근 7일 유지");
      await selectRail(page, 1512);
    }

    if (scope !== "critical") {
    await check("부탁 장 했어와 저녁 재확인", async () => {
      await clickText(page, ".pas-rt1707-stamps button", "했어");
      assert((await reportStatus(page)) === "완료", `했어 뒤 상태가 완료가 아니다: ${await reportStatus(page)}`);
      await page.locator(".pas-rt1707-undo").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "했어 되돌리기가 실패했다");
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
      await page.locator(".pas-rt1707-undo").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "참고 보관 되돌리기가 실패했다");
      assert((await (await railItem(page, 1387)).locator('[data-slot="badge"]').count()) === 0, "되돌린 뒤 참고 배지가 남았다");
      return { document: "failure then recovery", keptCard: true };
    });

    let instructionSlot;
    await check("항목 지시가 스레드와 실행 중에 반영", async () => {
      await selectRail(page, 1408);
      const instructButton = page.locator(".pas-rt1707-check-instruct").nth(1);
      await instructButton.click();
      await wait(250);
      const chip = await textOf(page, ".pas-rt1707-composer-drawer .v3-card-target-notice");
      assert(chip?.trim().startsWith("2번 항목") && !chip.includes("대상:"), `대상 알림이 2번 항목이 아니다: ${chip}`);
      const input = page.locator(".pas-rt1707-composer-drawer textarea");
      assert(await input.evaluate((el) => el === document.activeElement), "항목 지시 뒤 입력창에 초점이 없다");
      await input.press("Escape");
      await wait(200);
      assert(await page.locator('[data-testid="card-composer"]').count() === 0, "Escape로 대상 입력창이 닫히지 않았다");
      assert(await instructButton.evaluate((el) => el === document.activeElement), "대상 입력창을 닫은 뒤 항목 지시 단추로 초점이 돌아오지 않았다");
      await instructButton.click();
      await wait(250);
      await input.fill("장 사이 여백을 다시 확인해 주세요");
      await page.locator('.pas-rt1707-composer-drawer [aria-label="커멘트 전송"]').click();
      await wait(400);
      const thread = await textOf(page, ".pas-rt1707-thread-scroll");
      assert(thread?.includes("장 사이 여백을 다시 확인해 주세요"), "보낸 지시가 스레드에 붙지 않았다");
      assert((await reportStatus(page)) === "실행 중", `지시 뒤 상태가 실행 중이 아니다: ${await reportStatus(page)}`);
      const afterUndo = await rect(page, ".pas-rt1707-undo");
      const commentButton = await rect(page, '[data-testid="pas-rt1707-open-composer"]');
      assert(Math.abs(afterUndo.height - commentButton.height) <= 1, `지시 뒤 되돌리기 단추 높이가 옆 단추와 다르다: ${afterUndo.height}, ${commentButton.height}`);
      instructionSlot = afterUndo.height;
      await page.getByTestId("pas-rt1707-open-composer").click();
      await input.focus();
      const activeBefore = await textOf(page, '.pas-rt1707-rail-item[data-active="true"]');
      await page.keyboard.press("ArrowRight");
      await wait(200);
      const activeAfter = await textOf(page, '.pas-rt1707-rail-item[data-active="true"]');
      assert(activeBefore === activeAfter, "입력 중 화살표가 안건을 바꿨다");
      await input.press("Escape");
      await wait(200);
      assert(await page.getByTestId("pas-rt1707-open-composer").evaluate((el) => el === document.activeElement), "지시 적기 입력창을 닫은 뒤 초점이 단추로 돌아오지 않았다");
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
      await page.locator(".pas-rt1707-undo").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "지시 되돌리기가 실패했다");
      return { drawer: "실행 중" };
    });

    await check("관찰 장 사흘 뒤 재확인", async () => {
      await selectRail(page, 1112);
      await clickText(page, ".pas-rt1707-stamps button", "사흘 뒤 재확인");
      assert((await reportStatus(page)) === "검증 대기", `재확인 뒤 상태가 검증 대기가 아니다: ${await reportStatus(page)}`);
      assert((await textOf(page, ".pas-rt1707-hold-note"))?.includes("18개"), "보류함 수가 바뀌었다");
      await page.locator(".pas-rt1707-undo").click();
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
      await page.locator(".pas-rt1707-undo").click();
      await wait(300);
      assert((await reportStatus(page)) === "검수 대기", "승인 완료 되돌리기가 실패했다");
      return { chatCount: count };
    });

    await check("결재 입력창 안쪽 여백 대칭", async () => {
      await page.getByTestId("pas-rt1707-open-composer").click();
      await page.locator('[data-testid="card-composer"]').waitFor();
      const padding = await page.evaluate(() => {
        const element = document.querySelector('.pas-rt1707-composer-drawer [data-slot="chat-input-composer"]');
        const style = getComputedStyle(element);
        return { top: style.paddingTop, bottom: style.paddingBottom };
      });
      assert(parseFloat(padding.top) === parseFloat(padding.bottom), `결재 입력창 여백 불일치 ${JSON.stringify(padding)}`);
      return padding;
    });

    await check("창 크기 바꾸기", async () => {
      const input = page.locator(".pas-rt1707-composer-drawer textarea");
      await input.fill("리사이즈 확인");
      await page.locator(".pas-rt1707-thread-scroll").evaluate((element) => { element.scrollTop = 160; });
      await wait(200);
      await page.setViewportSize({ width: 390, height: 844 });
      await wait(500);
      const narrowDialog = await rect(page, '[data-testid="pas-report-thread-dialog"]');
      const narrowThread = await rect(page, ".pas-rt1707-thread");
      assert(narrowDialog && narrowDialog.right <= 390.5 && narrowDialog.bottom <= 844 - 72 + 0.5,
        `좁힌 뒤 보고 창이 화면과 코멘트 자리를 벗어난다 ${JSON.stringify(narrowDialog)}`);
      assert(await page.getByTestId("pas-rt1707-rail-toggle").isVisible(), "좁힌 뒤 안건 목록 단추가 없다");
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

    }
    await page.close();
    }
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
  const summary = { captureDir, webglDisabled: disableWebgl, failed: failed.length, checks };
  await mkdir(captureDir, { recursive: true });
  await writeFile(join(captureDir, "qa-report.json"), JSON.stringify(summary, null, 2));
  const resultFor = (name) => checks.find((item) => item.name === name)?.ok ? "통과" : "미확인 또는 실패";
  await writeFile(join(captureDir, "operations.md"), [
    "# 조작 결과",
    "",
    `14 초점: ${resultFor("정본 카드 패널과 초점 복귀")}. 카드 패널과 보고 창 닫기 초점 확인.`,
    `15 Tab과 Escape: ${resultFor("Tab 순서와 Esc 닫기")}. 서랍과 카드 패널의 Escape도 화면 검사에 포함.`,
    `16 좁은 폭: ${checks.filter((item) => /360x780.*보고 창/.test(item.name)).every((item) => item.ok) ? "통과" : "미확인 또는 실패"}. 가로 넘침과 조작 영역 확인.`,
    `17 오류 상태: ${resultFor("설계 문서 열람과 참고 보관")}. 문서 실패와 재열람 확인.`,
    `18 창 크기 변경: ${resultFor("창 크기 바꾸기")}. 입력과 스크롤 유지 확인.`,
    "",
    "보고 창: 말풍선에서 열고 Escape로 닫는다. 닫은 뒤 말풍선의 열기 단추로 초점이 돌아간다.",
    "안건 서랍: 안건 목록 단추로 열고 행 선택, 배경 누름 또는 Escape로 닫는다.",
    "카드 패널: 카드 패널 열기 단추로 열고 카드 닫기 또는 Escape로 닫는다. 초점은 카드 패널 열기 단추로 돌아간다.",
    "미루기 선택: 답변 미루기로 열고 시간을 선택하거나 Escape로 닫는다.",
    "",
    "실행: node e2e/pas-report-1707-thread.qa.mjs",
    `캡처: ${captureDir}`,
  ].join("\n"));
  console.log("");
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await new Promise((ok) => server.close(ok));
}
