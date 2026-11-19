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

const START = Date.now();
const mark = (label: string) => console.log(`[${Date.now() - START}ms] ${label}`);
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
  page.setDefaultTimeout(12_000);
  page.on("pageerror", (error: Error) => logs.push(`pageerror ${error.message}`));
  page.on("requestfailed", (request: any) =>
    logs.push(`requestfailed ${request.method()} ${new URL(request.url()).pathname}`));
  page.on("response", (response: any) => {
    if (response.status() >= 400) logs.push(`http ${response.status()} ${new URL(response.url()).pathname}`);
  });
  return { context, page };
}

async function open(page: Page, hash: string, theme: Theme = "dark", glass: "css" | "webgl" = "css") {
  const glassQuery = glass === "css" ? "&glass=css" : "";
  await page.goto(`${BASE}/frame.html?theme=${theme}${glassQuery}#${hash}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".ad1707-screen", { state: "visible" });
  await page.waitForTimeout(350);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, name), animations: "disabled" });
  captures.push(name);
}

async function readLayout(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main.v3-mockup-bare");
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
      ".v3-global-toolbar button",
      ".ad1707-filmstrip-item",
      ".ad1707-evidence",
      ".ad1707-link-card",
      ".ad1707-stamp-bar button",
      ".ad1707-undo-button",
      ".ad1707-home-actions button",
      ".ad1707-nav .v3-project-nav-link",
      ".ad1707-briefing-capsule button",
      ".ad1707-manuscript-composer button",
      ".ad1707-desk-empty-actions button",
      ".ad1707-question-action button",
      ".ad1707-inline-fix button",
      ".v3-postit-open",
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

/** 발행 드래프트의 코멘트 단추 자리(오른쪽 112, 아래 64)에 보이는 조작 요소가 닿는지 잰다.
 *  스크롤 상자 밖으로 잘린 부분은 보이지 않으므로 자른 사각형으로 비교한다. */
async function readSafeZone(page: Page) {
  return page.evaluate(() => {
    const safe = {
      left: window.innerWidth - 112,
      top: window.innerHeight - 64,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    const hits: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>("button, a, input, textarea, [role=button], [role=tab], select");
    for (const element of controls) {
      const style = getComputedStyle(element);
      const base = element.getBoundingClientRect();
      if (base.width === 0 || base.height === 0 || style.display === "none" || style.visibility === "hidden") continue;
      let left = base.left;
      let top = base.top;
      let right = base.right;
      let bottom = base.bottom;
      let ancestor = element.parentElement;
      while (ancestor) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (ancestorStyle.overflowX !== "visible" || ancestorStyle.overflowY !== "visible") {
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
      if (right - left <= 1 || bottom - top <= 1) continue;
      const width = Math.min(right, safe.right) - Math.max(left, safe.left);
      const height = Math.min(bottom, safe.bottom) - Math.max(top, safe.top);
      if (width > 0 && height > 0) {
        const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 28);
        hits.push(`${element.tagName.toLowerCase()}[${label}] ${Math.round(width)}x${Math.round(height)}`);
      }
    }
    return hits;
  });
}

async function readClipped(page: Page) {
  return page.evaluate(() => {
    const selectors = [
      ".ad1707-doc-title",
      ".ad1707-request p",
      ".ad1707-check-result",
      ".ad1707-home-head h1",
      ".ad1707-briefing-capsule > span",
      ".ad1707-dialog-head h2",
      ".ad1707-desk-empty h2",
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
  const safeZone = await readSafeZone(page);
  assert(layout.documentOverflow <= 0, `${label}: document 가로 넘침 ${layout.documentOverflow}`);
  assert(layout.bodyOverflow <= 0, `${label}: body 가로 넘침 ${layout.bodyOverflow}`);
  assert(layout.mainOverflow === null || layout.mainOverflow <= 0, `${label}: main 가로 넘침 ${layout.mainOverflow}`);
  assert(layout.screenOverflow === null || layout.screenOverflow <= 0, `${label}: screen 가로 넘침 ${layout.screenOverflow}`);
  assert.deepEqual(overlaps, [], `${label}: 요소 겹침 ${overlaps.join(", ")}`);
  assert.deepEqual(clipped, [], `${label}: 글 잘림 ${JSON.stringify(clipped)}`);
  assert.deepEqual(safeZone, [], `${label}: 코멘트 단추 자리 가림 ${safeZone.join(", ")}`);
  return { layout, overlaps, clipped, safeZone };
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
  return page.locator(selector).evaluate((element: HTMLElement) =>
    getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
}

async function readToolbarContrast(page: Page) {
  // oklch와 color(srgb ... / alpha)를 캔버스로 RGB로 바꾼 뒤 배경과의 대비를 잰다.
  return page.evaluate(`(() => {
    const parse = (value) => {
      const canvas = new OffscreenCanvas(1, 1);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    };
    const luminance = (rgb) => {
      const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const background = parse(getComputedStyle(document.documentElement).getPropertyValue("--background"));
    const sample = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const color = parse(getComputedStyle(element).color);
      const alpha = color[3];
      const composed = [
        color[0] * alpha + background[0] * (1 - alpha),
        color[1] * alpha + background[1] * (1 - alpha),
        color[2] * alpha + background[2] * (1 - alpha),
      ];
      const foreground = luminance(composed);
      const backdrop = luminance(background);
      return {
        color: getComputedStyle(element).color,
        alpha,
        ratio: Math.round(((Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05)) * 100) / 100,
        luminance: Math.round(foreground * 1000) / 1000,
      };
    };
    return {
      background: getComputedStyle(document.documentElement).getPropertyValue("--background"),
      backgroundLuminance: Math.round(luminance(background) * 1000) / 1000,
      brand: sample(".dashboard-toolbar-brand span:last-child"),
      active: sample(".ad1707-nav-button.is-active"),
      inactive: sample(".ad1707-nav-button:not(.is-active)"),
      theme: sample(".dashboard-toolbar-actions button[aria-label*='모드로 전환']"),
      componentsMain: document.querySelectorAll(".v3-components-main").length,
      bareMain: document.querySelectorAll("main.v3-mockup-bare").length,
      navCount: document.querySelectorAll(".ad1707-nav-button").length,
      clipboardActions: document.querySelectorAll(".dashboard-toolbar-actions [aria-label*='결재'], .dashboard-toolbar-actions .lucide-clipboard-check").length,
    };
  })()`);
}

async function readPortraits(page: Page) {
  return page.evaluate(`(async () => {
    const agents = ["seosoyoung", "roselin", "keke", "selaphiel"];
    const results = [];
    for (const agent of agents) {
      const image = new Image();
      const loaded = new Promise((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
      });
      image.src = "/api/nodes/eiaserinnys/agents/" + agent + "/portrait";
      const ok = await loaded;
      let average = null;
      if (ok) {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] <= 32) continue;
          red += data[index];
          green += data[index + 1];
          blue += data[index + 2];
          count += 1;
        }
        average = count > 0 ? [Math.round(red / count), Math.round(green / count), Math.round(blue / count)] : null;
      }
      results.push({ agent, ok, src: image.src, naturalWidth: image.naturalWidth, average });
    }
    return results;
  })()`);
}

async function readBoard(page: Page) {
  return page.evaluate(() => {
    const board = document.querySelector(".v3-card-board");
    const columns = [...document.querySelectorAll<HTMLElement>(".v3-card-board-column[data-board-column]")].map(column => ({
      status: column.getAttribute("data-board-column"),
      header: (column.querySelector(".v3-detail-section-head span")?.textContent ?? "").trim(),
      cards: column.querySelectorAll(".v3-postit-card").length,
    }));
    const running = document.querySelector<HTMLElement>("[data-board-column='running']");
    const name = running?.querySelector<HTMLElement>(".v3-postit-assignee > span:last-child") ?? null;
    return {
      board: !!board,
      total: (document.querySelector(".v3-card-board-workspace .v3-folder-card-head > span")?.textContent ?? "").trim(),
      columns,
      runningName: name ? {
        text: name.textContent ?? "",
        clientWidth: name.clientWidth,
        scrollWidth: name.scrollWidth,
        font: getComputedStyle(name).font,
      } : null,
    };
  });
}

async function readFonts(page: Page) {
  return page.evaluate(() => {
    const optionDesc = document.querySelector<HTMLElement>(".ad1707-option-desc");
    const filmstripTitle = document.querySelector<HTMLElement>(".ad1707-filmstrip-title");
    const filmstripKind = document.querySelector<HTMLElement>(".ad1707-filmstrip-kind");
    const capsuleText = document.querySelector<HTMLElement>(".ad1707-briefing-capsule > span");
    const capsule = document.querySelector<HTMLElement>(".ad1707-briefing-capsule");
    const optionStyle = optionDesc ? getComputedStyle(optionDesc) : null;
    const titleStyle = filmstripTitle ? getComputedStyle(filmstripTitle) : null;
    const kindStyle = filmstripKind ? getComputedStyle(filmstripKind) : null;
    const capsuleStyle = capsuleText ? getComputedStyle(capsuleText) : null;
    return {
      optionDesc: optionStyle ? { fontSize: optionStyle.fontSize, fontWeight: optionStyle.fontWeight, color: optionStyle.color } : null,
      filmstripTitle: titleStyle ? { fontSize: titleStyle.fontSize, fontWeight: titleStyle.fontWeight, color: titleStyle.color } : null,
      filmstripKind: kindStyle ? { fontSize: kindStyle.fontSize, fontWeight: kindStyle.fontWeight, color: kindStyle.color } : null,
      capsuleText: capsuleStyle ? { fontSize: capsuleStyle.fontSize, fontWeight: capsuleStyle.fontWeight, color: capsuleStyle.color } : null,
      capsuleClass: capsule?.className ?? null,
      foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground"),
    };
  });
}

async function readArrowOverlap(page: Page) {
  return page.evaluate(() => {
    const arrows = [...document.querySelectorAll<HTMLElement>("button[aria-label='앞 서류'], button[aria-label='다음 서류']")]
      .map(element => element.getBoundingClientRect());
    const filmstrip = document.querySelector<HTMLElement>(".ad1707-filmstrip");
    const strip = filmstrip?.getBoundingClientRect();
    const chips = [...document.querySelectorAll<HTMLElement>(".ad1707-filmstrip-item")].map(element => {
      const rect = element.getBoundingClientRect();
      // 가로 스크롤 상자 밖으로 잘린 부분은 화살표를 가리지 않는다. 보이는 사각형만 비교한다.
      if (!strip) return rect;
      return {
        left: Math.max(rect.left, strip.left, 0),
        top: Math.max(rect.top, strip.top, 0),
        right: Math.min(rect.right, strip.right, window.innerWidth),
        bottom: Math.min(rect.bottom, strip.bottom, window.innerHeight),
      };
    });
    const hits: string[] = [];
    for (const arrow of arrows) {
      for (const chip of chips) {
        const width = Math.min(arrow.right, chip.right) - Math.max(arrow.left, chip.left);
        const height = Math.min(arrow.bottom, chip.bottom) - Math.max(arrow.top, chip.top);
        if (width > 1 && height > 1) hits.push(`${Math.round(width)}x${Math.round(height)}`);
      }
    }
    return { arrows: arrows.length, chips: chips.length, hits };
  });
}

await runPlaywrightLifecycle({
  lockName: "pas-approval-desk-1707",
  timeoutMs: 420_000,
  launchOptions: { headless: true },
}, async ({ browser }: { browser: Browser }) => {
  // 세라피엘 재검수의 보드 높이, 작업대 빈 상태, PAS 입력 단추를 실제 화면에서 확인한다.
  const regressionFailures: string[] = [];
  const boardFill: Record<string, unknown> = {};
  for (const [width, height] of [[1440, 900], [820, 1180]] as const) {
    const view = await makePage(browser, width, height);
    await open(view.page, "board");
    const measured = await view.page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".ad1707-home-main")!;
      const board = panel.querySelector<HTMLElement>(".v3-card-board")!;
      const columns = [...board.querySelectorAll<HTMLElement>(".v3-card-board-column")];
      const panelBottom = panel.getBoundingClientRect().bottom;
      const innerBottom = panelBottom - parseFloat(getComputedStyle(panel).paddingBottom);
      const boardRect = board.getBoundingClientRect();
      return {
        panelBottom, innerBottom,
        board: { bottom: boardRect.bottom, height: boardRect.height },
        columns: columns.map(column => {
          const rect = column.getBoundingClientRect();
          return { bottom: rect.bottom, height: rect.height };
        }),
      };
    });
    boardFill[String(width)] = measured;
    if (Math.abs(measured.innerBottom - measured.board.bottom) > 24 ||
        measured.columns.length === 0 ||
        measured.columns.some((column: { bottom: number; height: number }) =>
          Math.abs(measured.innerBottom - column.bottom) > 24 || column.height < 500)) {
      regressionFailures.push(`A15 ${width}: ${JSON.stringify(measured)}`);
    }
    await shot(view.page, `board-fill-${width}-dark.png`);
    await view.context.close();
  }
  checks.boardFill = boardFill;

  const regression = await makePage(browser, 1440, 900);
  await open(regression.page, "desk");
  await regression.page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  const trigger = regression.page.getByRole("button", { name: "전체 카드와 세션 열기" });
  await trigger.click();
  const regressionWorkspace = regression.page.getByTestId("v3-card-workspace");
  await regressionWorkspace.waitFor({ state: "visible" });
  const workspaceText = await regressionWorkspace.innerText();
  await shot(regression.page, "workspace-1387-1440-dark.png");
  if (!workspaceText.includes("선택된 세션 없음") ||
      /대화를 기다리는 중|자동 스크롤/.test(workspaceText)) {
    regressionFailures.push(`A16: ${workspaceText}`);
  }
  await regression.page.keyboard.press("Escape");
  await regressionWorkspace.waitFor({ state: "hidden" });
  const returned = await trigger.evaluate((element: HTMLElement) => element === document.activeElement);
  if (!returned) regressionFailures.push("A16: Esc 뒤 연 단추로 초점이 돌아오지 않았다");
  checks.workspaceEmpty = { empty: workspaceText.includes("선택된 세션 없음"), returned };

  await open(regression.page, "pas");
  const input = regression.page.getByTestId("chat-input");
  const stopCount = await input.locator('[aria-label*="중단"]').count();
  const sendVisible = await input.getByTestId("send-button").isVisible();
  await shot(regression.page, "pas-input-1440-dark.png");
  if (stopCount !== 0 || !sendVisible) regressionFailures.push(`A17: 중단 ${stopCount}, 전송 ${sendVisible}`);
  checks.pasInput = { stopCount, sendVisible };
  await regression.context.close();
  assert.deepEqual(regressionFailures, [], regressionFailures.join("\n"));
  mark("qa A15 A16 A17");

  // 1. 넓은 화면 기본 상태와 서류 전환.
  const main = await makePage(browser, 1440, 900, "dark");
  const page = main.page;
  await open(page, "desk", "dark");
  checks.unmockedDesk = await assertNoUnmocked(page, "desk 1440 dark");
  checks.layoutDesk1440 = await assertClean(page, "desk 1440 dark");
  mark("qa 1 desk");
  assert.equal(await page.locator("main.v3-mockup-bare").count(), 1, "bare 표면이 main.v3-mockup-bare로 서지 않았다");
  assert.equal(await page.locator(".v3-components-main").count(), 0, "bare 표면이 운영 겉틀을 물려받았다");
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  await shot(page, "desk-1440-dark-1680.png");

  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /턴 안 상호작용/);
  await shot(page, "desk-1440-dark-1387.png");

  // 2. 발행 문서 링크 카드: 정본 문서 읽기 창, 본문, Esc 닫기, 초점 복귀.
  const linkCard = page.locator(".ad1707-link-card");
  assert.equal(await linkCard.count(), 1, "#1387 발행 문서 링크 카드가 없다");
  await linkCard.click();
  const reader = page.getByTestId("internal-document-dialog");
  await reader.waitFor({ state: "visible" });
  await reader.getByText(/본문을 불러오는 중/).waitFor({ state: "hidden", timeout: 5_000 });
  assert.match(await reader.innerText(), /턴 안 상호작용 설계안/);
  assert.match(await reader.innerText(), /차단 MCP는 0건/);
  assert.match(await reader.innerText(), /3단계 도입/);
  await shot(page, "document-reader-1440-dark.png");
  await page.keyboard.press("Escape");
  await reader.waitFor({ state: "hidden", timeout: 5_000 });
  const readerFocus = await active(page);
  assert.match(String(readerFocus.label), /턴 안 상호작용 설계안 발행 문서 열기/);
  checks.documentReader = { title: "턴 안 상호작용 설계안", focus: readerFocus.label };
  mark("qa 2 document reader");

  // 3. 질문 서류: 다르게 답하기와 되묻기가 바로 처분하지 않고, 안쪽 입력을 거친다.
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1680" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "다르게 답하기" }).click();
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);
  assert.equal(await page.locator(".ad1707-question-action textarea").count(), 1);
  assert.equal(await page.getByRole("button", { name: "보내기" }).isDisabled(), true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/, "빈 입력 Enter가 서류를 넘겼다");
  const questionText = "권장 범위를 최근 7일로 두고 예외를 문서에 남겨 주세요.";
  await page.locator(".ad1707-question-action textarea").fill(questionText);
  await page.locator(".ad1707-question-action textarea").evaluate((element: HTMLTextAreaElement) =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
  await page.waitForTimeout(200);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/, "한글 조합 Enter가 서류를 넘겼다");
  assert.equal(await page.locator(".ad1707-question-action").count(), 1, "조합 Enter 뒤 입력이 닫혔다");
  await page.locator(".ad1707-question-action textarea").press("Enter");
  await page.waitForTimeout(350);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /집 PC kaleidoscope/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  assert.match(await page.locator(".ad1707-undo").innerText(), new RegExp(`다르게 답하기: ${questionText}`));
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);

  await page.getByRole("button", { name: "되묻기" }).click();
  await page.waitForTimeout(150);
  await page.locator(".ad1707-question-action textarea").fill("최근 7일을 고른 이유와 예외 기준을 한 줄로 다시 알려 주세요.");
  await page.getByRole("button", { name: "보내기" }).click();
  await page.waitForTimeout(350);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /집 PC kaleidoscope/);
  assert.match(await page.locator(".ad1707-undo").innerText(), /되묻기: 최근 7일을 고른 이유/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  checks.questionFlow = "빈 입력과 조합 Enter는 넘기지 않고, 보내기만 한 건을 처분하며 되돌리기가 복원한다";
  mark("qa 3 question flow");

  // 4. 겹 눌림: 두 번 눌러도 한 건만 처분하고 되돌리기는 한 건만 복원한다.
  await page.getByRole("button", { name: "참고 갈무리" }).dblclick({ delay: 50 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4, "겹 눌림이 서류 두 건을 처분했다");
  assert.equal(await page.locator(".ad1707-undo").count(), 1);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  checks.doubleClick = "겹 눌림 한 번에 한 건만 처분, 되돌리기 한 건 복원";
  mark("qa 4 double click");

  // 5. 다시 보기 팝오버: 첫 항목 초점, Esc 닫기, 초점 복귀, 실제 미루기와 되돌리기.
  await page.getByRole("button", { name: "다시 보기" }).click();
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("menu", { name: "다시 보기 시각" }).isVisible(), true);
  const snoozeFocus = await active(page);
  assert.match(snoozeFocus.text, /내일 오전 9시/);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("menu", { name: "다시 보기 시각" }).count(), 0);
  assert.match((await active(page)).text, /다시 보기/);

  await page.getByRole("button", { name: "다시 보기" }).click();
  await page.getByRole("menuitem", { name: "내일 오전 9시" }).click();
  await page.waitForTimeout(250);
  assert.match(await page.locator(".ad1707-undo").innerText(), /다시 보기로 미뤘습니다/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /집 PC kaleidoscope/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  assert.match(await page.locator(".ad1707-nav-badge").innerText(), /4/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  assert.equal(await page.locator(".ad1707-undo").count(), 0);
  checks.snooze = "팝오버 Esc와 초점 복귀, 미루기와 되돌리기 통과";
  mark("qa 5 snooze");

  // 6. 선택지 답, 했어, 지적과 보완 지시.
  await page.getByRole("button", { name: /최근 7일/ }).click();
  await page.waitForTimeout(250);
  assert.match(await page.locator(".ad1707-undo").innerText(), /승인 완료로 넘겼습니다: 최근 7일/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /집 PC kaleidoscope/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);

  await page.locator(".ad1707-filmstrip-item", { hasText: "#1512" }).click();
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "했어" }).click();
  await page.waitForTimeout(250);
  assert.match(await page.locator(".ad1707-undo").innerText(), /승인 완료로 넘겼습니다/);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /턴 안 상호작용/);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);

  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(150);
  await page.locator(".ad1707-check").first().getByRole("button", { name: "지적" }).click();
  await page.locator(".ad1707-inline-fix textarea").fill("경로 조사에 실행 큐 잠금 지점을 더 적어 주세요.");
  await page.getByRole("button", { name: "보완 지시 보내기" }).click();
  await page.waitForTimeout(250);
  assert.match(await page.locator(".ad1707-undo").innerText(), /경로 조사에 실행 큐 잠금 지점을 더 적어 주세요/);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 4);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);

  await page.getByRole("button", { name: "보완 지시" }).click();
  await page.waitForTimeout(250);
  await page.locator(".ad1707-nav-button", { hasText: "홈 플래너" }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator("[data-card-group='running'] .ad1707-card-seat").count(), 4);
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  checks.dispositions = "선택지 답, 했어, 지적 보완 지시, 보완 지시와 홈 진행 중 반영, 되돌리기 통과";
  mark("qa 6 dispositions");

  // 7. 증거 확대 창: 첫 동작 초점, Esc 닫기, 연 자리로 초점 복귀, Tab 가둠.
  const evidenceTrigger = page.locator(".ad1707-evidence").first();
  await evidenceTrigger.click();
  await page.waitForTimeout(250);
  const evidenceDialog = page.locator("dialog.ad1707-evidence-dialog");
  assert.equal(await evidenceDialog.evaluate((element: HTMLDialogElement) => element.open), true);
  const evidenceFocus = await active(page);
  assert.match(String(evidenceFocus.label), /증거 닫기/);
  for (let step = 0; step < 5; step += 1) {
    await page.keyboard.press("Tab");
    const tabState = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        backgroundControl: !!element?.closest(".ad1707-screen") && !element?.closest("dialog[open]"),
      };
    });
    assert.equal(tabState.backgroundControl, false, "증거 창에서 Tab이 배경 조작 요소로 나갔다");
  }
  await shot(page, "evidence-dialog-1440-dark.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  assert.equal(await evidenceDialog.evaluate((element: HTMLDialogElement) => element.open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ad1707-evidence")), true);
  checks.evidenceDialog = { focus: evidenceFocus.label, returned: true };
  mark("qa 7 evidence dialog");

  // 8. 증거 그림의 실제 결정 수치.
  const evidenceText: Record<string, string[]> = {};
  for (const [docHash, expected] of [
    ["#1680", ["18", "412", "62%"]],
    ["#1387", ["0", "차단 MCP", "0", "달러", "1 입력 큐", "2 실행 중단", "3 재개 저장"]],
    ["#1408", ["1.32", "1.55", "줄간격"]],
    ["#1112", ["평일 08:30 예약", "주말 제외", "월", "일"]],
  ] as const) {
    await page.locator(".ad1707-filmstrip-item", { hasText: docHash }).click();
    await page.waitForTimeout(200);
    const arts = page.locator(".ad1707-evidence");
    const texts: string[] = [];
    for (let index = 0; index < await arts.count(); index += 1) {
      await arts.nth(index).click();
      await page.waitForTimeout(200);
      const svgText = await page.locator("dialog.ad1707-evidence-dialog svg.ad1707-art").textContent();
      texts.push(svgText ?? "");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    for (const phrase of expected) {
      assert.ok(texts.some(text => text.includes(phrase)), `${docHash} 증거 그림에 ${phrase}가 없다`);
    }
    evidenceText[docHash] = texts;
  }
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1680" }).click();
  await page.waitForTimeout(200);
  const assignee1680 = await page.locator(".ad1707-assignee").innerText();
  assert.match(assignee1680, /PAS 대화/);
  assert.doesNotMatch(assignee1680, /세션 [0-9a-f]{6,}/);
  checks.evidenceArt = evidenceText;
  mark("qa 8 evidence art");

  // 9. 카드와 세션 두 칸 창: 정본 CardWorkspace, 두 패널, Esc 닫기, 초점 복귀.
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "전체 카드와 세션 열기" }).click();
  const workspace = page.getByTestId("v3-card-workspace");
  await workspace.waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("card-detail").count(), 1, "카드 칸이 없다");
  assert.equal(await page.getByTestId("v3-card-session-chat").count(), 1, "세션 칸이 없다");
  assert.equal(await page.getByTestId("v3-card-workspace-divider").count(), 1, "두 칸 나눔 막대가 없다");
  assert.equal(await gridColumnCount(page, ".v3-card-workspace-pair"), 3, "카드, 나눔, 세션 세 트랙이 아니다");
  await shot(page, "card-workspace-1440-dark.png");
  await page.keyboard.press("Escape");
  await workspace.waitFor({ state: "hidden", timeout: 5_000 });
  assert.equal(await page.evaluate(() =>
    document.activeElement?.textContent?.includes("전체 카드와 세션 열기") ?? false), true);
  checks.cardWorkspace = "정본 카드 상세와 세션 칸, 나눔 막대, Esc 닫기, 초점 복귀 통과";
  mark("qa 9 card workspace");

  // 10. 홈: 정본 폴더 트리와 플래너 유리, 폴더 거르기가 카드와 보드에 걸린다.
  await page.locator(".ad1707-nav-button", { hasText: "홈 플래너" }).click();
  await page.waitForSelector(".ad1707-screen[data-screen='home']", { state: "visible" });
  await page.waitForTimeout(300);
  const navClass = String(await page.locator(".ad1707-nav").getAttribute("class"));
  const plannerClass = String(await page.locator(".ad1707-home-main").getAttribute("class"));
  for (const token of ["v3-navigation", "glass-strong", "glass-chrome", "lg-rim", "border-glass-border"]) {
    assert.match(navClass, new RegExp(token), `폴더 패널에 ${token}이 없다`);
  }
  for (const token of ["v3-planner", "glass-strong", "glass-chrome", "lg-rim", "border-glass-border"]) {
    assert.match(plannerClass, new RegExp(token), `플래너에 ${token}이 없다`);
  }
  assert.equal(await page.locator(".ad1707-nav .v3-project-tree-root").count(), 1);
  assert.equal(await page.locator("[data-card-group='attention'] .ad1707-card-seat").count(), 5);
  assert.equal(await page.locator("[data-card-group='running'] .ad1707-card-seat").count(), 3);
  assert.equal(await page.locator("[data-card-group='queued'] .ad1707-card-seat").count(), 2);
  await shot(page, "home-1440-dark.png");

  const pagesFolder = page.locator(".ad1707-nav .v3-project-nav-link", { hasText: "Pages" });
  assert.equal(await pagesFolder.count(), 1, "Pages 폴더 단추가 없다");
  await pagesFolder.click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("[data-card-group='attention'] .ad1707-card-seat").count(), 1);
  assert.equal(await page.locator("[data-card-group='running'] .ad1707-card-seat").count(), 0);
  assert.match(await page.locator("[data-card-group='attention']").innerText(), /#1408/);
  assert.doesNotMatch(await page.locator("[data-card-group='attention']").innerText(), /#1680/);
  await page.getByRole("button", { name: "보드 보기" }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".v3-card-board").count(), 1);
  assert.match(await page.locator(".ad1707-board-view").innerText(), /#1408/);
  assert.doesNotMatch(await page.locator(".ad1707-board-view").innerText(), /#1680/);
  await page.getByRole("button", { name: "카드 보기" }).click();
  await page.waitForTimeout(250);
  await pagesFolder.click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("[data-card-group='attention'] .ad1707-card-seat").count(), 5);
  checks.folderFilter = "Pages 폴더가 홈 카드와 보드를 한 건으로 거르고, 다시 누르면 풀린다";
  mark("qa 10 folder filter");

  // 11. 보드: 정본 카드 보드, 칸별 수, 실행 중 로젤린 이름 잘림 없음.
  await page.getByRole("button", { name: "보드 보기" }).click();
  await page.waitForTimeout(350);
  const board = await readBoard(page);
  assert.equal(board.board, true);
  const expectedColumns: Record<string, number> = { queued: 3, running: 3, blocked: 1, review: 3, on_hold: 18, done: 12 };
  for (const [status, count] of Object.entries(expectedColumns)) {
    const column = board.columns.find(item => item.status === status);
    assert(column, `보드에 ${status} 칸이 없다`);
    assert.equal(column.cards, count, `${status} 칸 카드 수`);
    assert.equal(Number.parseInt(column.header, 10), count, `${status} 칸 머리 수`);
  }
  assert.equal(board.total, "40개 표시");
  assert.equal(board.runningName?.text, "로젤린");
  assert.equal(board.runningName?.clientWidth, board.runningName?.scrollWidth, "실행 중 칸의 로젤린이 잘렸다");
  assert((board.runningName?.clientWidth ?? 0) > 20, "실행 중 칸의 로젤린 폭이 0이다");
  await shot(page, "board-1440-dark.png");
  await page.locator(".v3-card-board").evaluate((element: HTMLElement) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(250);
  await shot(page, "board-hold-1440-dark.png");
  checks.board = board;
  mark("qa 11 board");

  // 12. 참고 갈무리: 실제 요약을 보존하고 참고 서재 카드에서 구분된다.
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForTimeout(250);
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "참고 갈무리" }).click();
  await page.waitForTimeout(300);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /슬라이드 편집 화면/);
  await page.locator(".ad1707-nav-button", { hasText: "홈 플래너" }).click();
  await page.waitForSelector(".ad1707-screen[data-screen='home']", { state: "visible" });
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /참고 서재/ }).click();
  await page.waitForTimeout(300);
  const reference = page.locator(".ad1707-reference");
  assert.equal(await reference.count(), 1);
  const referenceText = await reference.innerText();
  assert.match(referenceText, /#1387/);
  assert.match(referenceText, /입력 큐 삽입을 1단계로 두는 3단계 도입 설계와 미확인 범위/);
  assert.doesNotMatch(referenceText, /참고 서재로 갈무리했습니다/);
  await shot(page, "home-reference-1440-dark.png");
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  checks.reference = "참고 서재 카드에 #1387 실제 요약이 남고, 되돌리기가 복원한다";
  mark("qa 12 reference");

  // 13. 모두 처분한 빈 상태: 완료 카드와 두 단추만, 화살표와 전체 창 단추는 숨는다.
  for (let index = 0; index < 5; index += 1) {
    if (!await page.locator(".ad1707-stamp-reference").count()) break;
    await page.locator(".ad1707-stamp-reference").click();
    await page.waitForTimeout(450);
  }
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 0);
  assert.equal(await page.locator(".ad1707-overlay-trigger").count(), 0);
  assert.equal(await page.locator(".ad1707-stamp-bar").count(), 0);
  assert.equal(await page.getByRole("button", { name: "앞 서류" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "다음 서류" }).count(), 0);
  const emptyCard = page.locator(".ad1707-desk-empty");
  assert.equal(await emptyCard.count(), 1);
  const emptyClass = String(await emptyCard.getAttribute("class"));
  for (const token of ["glass-strong", "glass-chrome", "lg-rim", "border-glass-border"]) {
    assert.match(emptyClass, new RegExp(token), `빈 상태 카드에 ${token}이 없다`);
  }
  assert.match(await emptyCard.innerText(), /오늘 넘길 서류를 모두 넘겼습니다/);
  assert.equal(await emptyCard.getByRole("button").count(), 2);
  await shot(page, "desk-empty-1440-dark.png");
  await emptyCard.getByRole("button", { name: "예시 5건 다시 불러오기" }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".ad1707-filmstrip-item").count(), 5);
  assert.match(await page.locator(".ad1707-doc-title").innerText(), /완료 목록 기간 칩/);
  checks.emptyState = "빈 상태 카드와 두 단추, 화살표와 전체 창 숨김, 예시 복원 통과";
  mark("qa 13 empty state");

  // 14. PAS: 정본 대화와 입력, 원고지 표면, 브리핑 캡슐.
  await page.locator(".ad1707-nav-button", { hasText: "PAS 서소영" }).click();
  await page.waitForSelector(".ad1707-screen[data-screen='pas']", { state: "visible" });
  await page.waitForTimeout(400);
  assert.match(await page.locator(".ad1707-briefing-capsule").innerText(), /결재 서류 5건 대기 중/);
  assert.equal(await page.locator(".ad1707-pas-character iframe, .ad1707-pas-character img").count(), 1);
  assert.equal(await page.locator("[data-testid='chat-input']").count(), 1, "정본 ChatInput이 없다");
  assert.equal(await page.locator(".ad1707-manuscript-body > *").count(), 3, "대화 메시지 세 건이 아니다");
  const manuscriptBackground = await page.locator(".ad1707-manuscript").evaluate((element: HTMLElement) =>
    getComputedStyle(element).backgroundColor);
  assert.notEqual(manuscriptBackground, "rgba(0, 0, 0, 0)", "원고지 표면이 투명하다");
  await page.locator("[data-testid='chat-input'] textarea").fill("한글 입력 중");
  await page.locator("[data-testid='chat-input'] textarea").evaluate((element: HTMLTextAreaElement) =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
  await page.waitForTimeout(200);
  assert.equal(await page.locator("[data-testid='chat-input'] textarea").inputValue(), "한글 입력 중");
  await page.locator("[data-testid='chat-input'] textarea").fill("");
  checks.layoutPas1440 = await assertClean(page, "pas 1440 dark");
  await shot(page, "pas-1440-dark.png");

  const fonts = await readFonts(page);
  assert.equal(fonts.capsuleText?.fontSize, "14px");
  assert.match(String(fonts.capsuleClass), /glass-strong/);
  assert.match(String(fonts.capsuleClass), /glass-chrome/);
  assert.match(String(fonts.capsuleClass), /lg-rim/);
  const foreground = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".ad1707-briefing-capsule > span");
    return element ? getComputedStyle(element).color : null;
  });
  const rootForeground = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--foreground)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  assert.equal(foreground, rootForeground);
  checks.fontsPas = fonts;
  mark("qa 14 pas");

  // 15. 폭 바꾸기: PAS 입력 유지, 두 칸과 한 칸 복귀.
  await page.locator("[data-testid='chat-input'] textarea").fill("입력 중인 글");
  assert.equal(await gridColumnCount(page, ".ad1707-pas-stage"), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  assert.equal(await gridColumnCount(page, ".ad1707-pas-stage"), 1);
  assert.equal(await page.locator("[data-testid='chat-input'] textarea").inputValue(), "입력 중인 글");
  checks.layoutPasResized390 = await assertClean(page, "pas resize 390");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(350);
  assert.equal(await gridColumnCount(page, ".ad1707-pas-stage"), 2);
  assert.equal(await page.locator("[data-testid='chat-input'] textarea").inputValue(), "입력 중인 글");
  checks.layoutPasResized1440 = await assertClean(page, "pas resize 1440");
  mark("qa 15 resize");

  // 16. 데스크 글자 크기와 360 화살표와 칩.
  await page.locator(".ad1707-nav-button", { hasText: "결재 데스크" }).click();
  await page.waitForTimeout(250);
  const deskFonts = await readFonts(page);
  assert.equal(deskFonts.optionDesc?.fontSize, "14px");
  assert.equal(deskFonts.filmstripTitle?.fontSize, "14px");
  assert.equal(deskFonts.filmstripKind?.fontSize, "12px");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(350);
  const arrowOverlap = await readArrowOverlap(page);
  assert.equal(arrowOverlap.arrows, 2);
  assert.deepEqual(arrowOverlap.hits, [], `360 화살표가 칩을 가린다 ${arrowOverlap.hits.join(", ")}`);
  checks.layoutDesk360 = await assertClean(page, "desk 360");
  await shot(page, "desk-360-dark.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  checks.fontsDesk = deskFonts;
  mark("qa 16 desk fonts");

  // 17. 두 테마와 네 폭의 네 화면에서 넘침과 겹침, 글 잘림을 확인한다.
  for (const theme of ["dark", "light"] as const) {
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844], [360, 740]] as const) {
      const narrow = await makePage(browser, width, height, theme);
      for (const screen of ["desk", "home", "pas", "board"] as const) {
        await open(narrow.page, screen, theme);
        checks[`layout-${screen}-${width}-${theme}`] = await assertClean(narrow.page, `${screen} ${width} ${theme}`);
        mark(`qa 17 ${screen} ${width} ${theme}`);
        await shot(narrow.page, `${screen}-${width}-${theme}.png`);
      }
      await narrow.context.close();
    }
  }

  // 18. 밝은 테마 도구 막대: 브랜드, 화면 전환, 테마 아이콘 대비. 유리 두 방식 모두.
  for (const glass of ["css", "webgl"] as const) {
    const light = await makePage(browser, 1440, 900, "light");
    await open(light.page, "desk", "light", glass);
    assert.equal((await readLayout(light.page)).dark, false, "light 테마에 dark 클래스가 붙었다");
    const contrast = await readToolbarContrast(light.page);
    assert.equal(contrast.componentsMain, 0, "밝은 테마에서 운영 겉틀이 남았다");
    assert.equal(contrast.bareMain, 1);
    assert.equal(contrast.navCount, 3);
    assert.equal(contrast.clipboardActions, 0, "오른쪽 위에 결재 클립보드 단추가 남았다");
    for (const [name, sample] of Object.entries({ brand: contrast.brand, active: contrast.active, inactive: contrast.inactive, theme: contrast.theme })) {
      assert(sample, `밝은 테마 ${glass}: ${name} 색을 찾지 못했다`);
      assert((sample as { ratio: number }).ratio >= 4.5, `밝은 테마 ${glass}: ${name} 대비 ${(sample as { ratio: number }).ratio}`);
      assert((sample as { luminance: number }).luminance < contrast.backgroundLuminance, `밝은 테마 ${glass}: ${name}이 배경보다 밝다`);
    }
    checks[`toolbarLight-${glass}`] = contrast;
    mark(`qa 18 light ${glass}`);
    await assertClean(light.page, `desk 1440 light ${glass}`);
    await shot(light.page, `desk-1440-light-${glass}.png`);
    await light.context.close();
  }

  // 19. 어두운 테마 도구 막대도 같은 방식으로 대비를 확인한다.
  const darkContrast = await readToolbarContrast(page);
  for (const [name, sample] of Object.entries({ brand: darkContrast.brand, active: darkContrast.active, inactive: darkContrast.inactive, theme: darkContrast.theme })) {
    assert(sample, `어두운 테마: ${name} 색을 찾지 못했다`);
    assert((sample as { ratio: number }).ratio >= 4.5, `어두운 테마: ${name} 대비 ${(sample as { ratio: number }).ratio}`);
    assert((sample as { luminance: number }).luminance > darkContrast.backgroundLuminance, `어두운 테마: ${name}이 배경보다 어둡다`);
  }
  checks.toolbarDark = darkContrast;
  mark("qa 19 dark contrast");

  // 20. 담당 초상: 서소영과 로젤린이 다른 파일을 쓰고, 네 담당 초상이 모두 뜬다.
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1680" }).click();
  await page.waitForTimeout(200);
  const seosoyoungPortrait = String(await page.locator(".ad1707-assignee img").getAttribute("src"));
  assert.match(seosoyoungPortrait, /characters\/seosoyoung\/still\.png/);
  await page.locator(".ad1707-filmstrip-item", { hasText: "#1387" }).click();
  await page.waitForTimeout(200);
  const roselinPortrait = String(await page.locator(".ad1707-assignee img").getAttribute("src"));
  assert.match(roselinPortrait, /mockup-1707\/roselin\.svg/);
  assert.notEqual(seosoyoungPortrait, roselinPortrait);
  const portraits = await readPortraits(page);
  const expectedPortraitFiles: Record<string, string> = {
    seosoyoung: "characters/seosoyoung/still.png",
    roselin: "mockup-1707/roselin.svg",
    keke: "mockup-1707/keke.svg",
    selaphiel: "mockup-1707/selaphiel.svg",
  };
  for (const portrait of portraits as { agent: string; ok: boolean; src: string; naturalWidth: number; average: number[] | null }[]) {
    assert.equal(portrait.ok, true, `${portrait.agent} 초상이 뜨지 않았다`);
    assert(portrait.naturalWidth > 0, `${portrait.agent} 초상 폭이 0이다`);
    assert.match(portrait.src, new RegExp(expectedPortraitFiles[portrait.agent]!.replace(/[.]/g, "\\.")));
    assert(portrait.average, `${portrait.agent} 초상 평균색을 재지 못했다`);
  }
  const portraitColors = (portraits as { average: number[] | null }[]).map(portrait => portrait.average);
  let distinct = 0;
  for (let left = 0; left < portraitColors.length; left += 1) {
    for (let right = left + 1; right < portraitColors.length; right += 1) {
      const a = portraitColors[left]!;
      const b = portraitColors[right]!;
      const distance = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      if (distance > 24) distinct += 1;
    }
  }
  assert(distinct >= 3, `담당 초상 색이 충분히 다르지 않다 ${JSON.stringify(portraitColors)}`);
  checks.portraits = { seosoyoungPortrait, roselinPortrait, portraits, distinct };
  mark("qa 20 portraits");

  // 21. 호스트 자체: 테마와 폭 전환, 360 가로 넘침 없음.
  const host = await makePage(browser, 360, 740, "dark");
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
  assert(hostLayout.overflow <= 0, "호스트 360 가로 넘침");
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
  mark("qa 21 host");

  // 22. 닫힌 창 안으로 Tab이 들어가지 않는다.
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
  mark("qa 22 tab order");

  // 23. OG 미리보기: 1200x630 홈 플래너.
  const og = await makePage(browser, 1200, 630, "dark");
  await open(og.page, "home", "dark");
  await og.page.waitForTimeout(400);
  await og.page.screenshot({
    path: path.join(DASHBOARD, "mockups", "pas-approval-1707-desk", "og.png"),
    animations: "disabled",
  });
  await og.context.close();
  checks.og = "1200x630";
  mark("qa 23 og");

  checks.errorState = {
    status: "해당 없음",
    reason: "정적 시안이라 데이터 요청과 실패 경로가 없다. 모든 값은 픽스처다.",
  };
  checks.logs = [...new Set(logs)];
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ checks, captures }, null, 2));

  mark("closing main context");
  await main.context.close();
  mark("closing host context");
  await host.context.close();
  mark("callback done");
});
mark("lifecycle returned");
server.close();
mark("server closed");
