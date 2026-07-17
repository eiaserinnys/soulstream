import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BD_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-runbook-board-declutter"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bd-v3-runbook-board-declutter",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  let boardReads = 0;
  let boardWrites = 0;
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[${theme}] pageerror: ${error.stack ?? error.message}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/board-items") return;
    if (request.method() === "GET") boardReads += 1;
    else boardWrites += 1;
  });
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "▦ 보드" }).click();

    const board = page.getByTestId("v3-task-board-pane");
    const fixedCard = page.getByTestId("runbook-board-fixed-card");
    const tiles = page.locator('[data-board-tile="true"]');
    await board.waitFor({ state: "visible" });
    await capture(page, theme, "00-board-open");
    await page.getByTestId("v3-task-board-loading").waitFor({ state: "hidden" });
    const boardItemCount = Number(await board.getAttribute("data-board-item-count") ?? "0");
    assert(boardItemCount >= 5, `혼합 보드 응답이 ${boardItemCount}개뿐입니다: ${await board.innerText()}`);
    await fixedCard.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll('[data-board-tile="true"]').length >= 5);

    const before = await measureLayout(page);
    assert(before.fixed.width === 360 && before.fixed.height === 520, `고정 런북 카드가 ${before.fixed.width}×${before.fixed.height}px입니다.`);
    assert(before.fixedOverlaps > 0, "정리 전 런북 카드 겹침을 재현하지 못했습니다.");
    await capture(page, theme, "01-before-declutter");

    const readsBefore = boardReads;
    await page.getByTestId("board-declutter-button").click();
    await page.waitForFunction(() => {
      const fixed = document.querySelector<HTMLElement>('[data-testid="runbook-board-fixed-card"]')?.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-board-tile="true"]'));
      return fixed !== undefined && cards.length >= 5
        && cards.every((card) => card.getBoundingClientRect().top >= fixed.bottom + 20);
    });

    const after = await measureLayout(page);
    assert(after.fixedOverlaps === 0, `정리 뒤 런북 카드와 ${after.fixedOverlaps}개 카드가 겹칩니다.`);
    assert(after.pairOverlaps === 0, `정리 뒤 일반 카드끼리 ${after.pairOverlaps}쌍 겹칩니다.`);
    assert(boardReads === readsBefore, `정리가 board-items를 ${boardReads - readsBefore}회 재조회했습니다.`);
    assert(boardWrites === 0, `정리가 REST board-items 쓰기를 ${boardWrites}회 만들었습니다.`);
    assert(pageErrors.length === 0, `브라우저 오류가 발생했습니다: ${pageErrors.join(" | ")}`);
    assert(await tiles.count() >= 5, "혼합 보드 카드가 유지되지 않았습니다.");
    await capture(page, theme, "02-after-declutter");

    return {
      cards: await tiles.count(),
      fixedSize: `${after.fixed.width}x${after.fixed.height}`,
      overlapsBefore: before.fixedOverlaps,
      overlapsAfter: after.fixedOverlaps + after.pairOverlaps,
      boardRefetches: boardReads - readsBefore,
      restWrites: boardWrites,
    };
  } finally {
    await context.close();
  }
}

async function measureLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const fixedElement = document.querySelector<HTMLElement>('[data-testid="runbook-board-fixed-card"]');
    if (!fixedElement) throw new Error("고정 런북 카드를 찾지 못했습니다.");
    const fixedBounds = fixedElement.getBoundingClientRect();
    const fixed = {
      x: fixedBounds.x,
      y: fixedBounds.y,
      width: fixedBounds.width,
      height: fixedBounds.height,
    };
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-board-tile="true"]'))
      .map((card) => {
        const bounds = card.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      });
    return { fixed, cards };
  });
  return {
    fixed: layout.fixed,
    fixedOverlaps: layout.cards.filter((card) => overlaps(layout.fixed, card)).length,
    pairOverlaps: layout.cards.flatMap((left, index) => (
      layout.cards.slice(index + 1).map((right) => overlaps(left, right))
    )).filter(Boolean).length,
  };
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    if (window === window.top) {
      localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
      localStorage.setItem("ls.webglGlass", "0");
      const serviceWorker = navigator.serviceWorker;
      if (serviceWorker) {
        Object.defineProperty(serviceWorker, "register", {
          configurable: true,
          value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
        });
        Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
      }
    }
  ` });
  await installV3VisualQaRoutes(page);
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}
