import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BD_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-task-board-declutter"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bd-v3-task-board-declutter",
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
    await page.getByTestId("v3-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-task-alpha").click();
    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "업무 보드 열기" }).click();

    const board = page.getByTestId("v3-task-board-pane");
    const resources = page.getByTestId("v3-task-board-resources");
    const canvas = page.getByTestId("v3-task-board-canvas");
    const chat = page.getByTestId("v3-task-board-chat");
    const tiles = page.locator('[data-board-tile="true"]');
    await board.waitFor({ state: "visible" });
    await resources.waitFor({ state: "visible" });
    await canvas.waitFor({ state: "visible" });
    await chat.waitFor({ state: "visible" });
    await capture(page, theme, "00-board-open");
    await page.getByTestId("v3-task-board-loading").waitFor({ state: "hidden" });
    const boardItemCount = Number(await board.getAttribute("data-board-item-count") ?? "0");
    assert(boardItemCount >= 5, `혼합 보드 응답이 ${boardItemCount}개뿐입니다: ${await board.innerText()}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-board-tile="true"]').length >= 3);
    assert(await page.getByTestId("task-board-fixed-card").count() === 0, "체크리스트가 중앙 보드에 남았습니다.");
    assert(await canvas.locator('[data-testid="board-session-tile"]').count() === 0, "세션 카드가 중앙 보드에 남았습니다.");
    assert(await resources.getByTestId("task-card").count() === 1, "체크리스트가 왼쪽 자료 패널에 없습니다.");

    const before = await measureLayout(page);
    assert(before.pairOverlaps > 0, "정리 전 공간 객체 겹침을 재현하지 못했습니다.");
    assert(before.resources.right <= before.canvas.left, "업무 자료와 중앙 보드가 겹칩니다.");
    assert(before.canvas.right <= before.chat.left, "중앙 보드와 채팅이 겹칩니다.");
    await capture(page, theme, "01-before-declutter");

    const readsBefore = boardReads;
    await page.getByTestId("board-declutter-button").click();
    await page.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-board-tile="true"]'));
      const bounds = cards.map((card) => card.getBoundingClientRect());
      return cards.length >= 3 && bounds.every((left, index) => (
        bounds.slice(index + 1).every((right) => !(
          left.left < right.right
          && left.right > right.left
          && left.top < right.bottom
          && left.bottom > right.top
        ))
      ));
    });

    const after = await measureLayout(page);
    assert(after.pairOverlaps === 0, `정리 뒤 일반 카드끼리 ${after.pairOverlaps}쌍 겹칩니다.`);
    assert(boardReads === readsBefore, `정리가 board-items를 ${boardReads - readsBefore}회 재조회했습니다.`);
    assert(boardWrites === 0, `정리가 REST board-items 쓰기를 ${boardWrites}회 만들었습니다.`);
    assert(await tiles.count() === 3, `중앙 공간 객체가 3개가 아닙니다: ${await tiles.count()}`);
    await capture(page, theme, "02-after-declutter");

    await resources.getByRole("tab", { name: "위임 관계" }).click();
    assert(await resources.locator(".v3-run-row").count() >= 2, "왼쪽 위임 관계에 업무 세션이 없습니다.");
    await resources.locator(".v3-run-open").first().click();
    assert(!(await chat.innerText()).includes("선택된 세션 없음"), "위임 세션 선택이 오른쪽 채팅에 연결되지 않았습니다.");

    await resources.getByRole("tab", { name: "PR-O 결정 로그" }).click();
    await resources.getByRole("button", { name: "PR-O 결정 로그 편집기 열기" }).click();
    const overlay = page.getByTestId("v3-task-board-document-overlay");
    await overlay.waitFor({ state: "visible" });
    const wide = await measureLayout(page);
    assert(wide.overlay !== null, "넓은 화면 문서 오버레이가 없습니다.");
    assert(wide.overlay.left >= wide.canvas.left, "넓은 화면 오버레이가 업무 자료를 덮습니다.");
    assert(wide.overlay.right <= wide.canvas.right, "넓은 화면 오버레이가 중앙 보드를 벗어납니다.");
    assert(wide.overlay.right <= wide.chat.left, "넓은 화면 오버레이가 채팅을 덮습니다.");
    await capture(page, theme, "03-document-wide");

    await page.setViewportSize({ width: 1024, height: 900 });
    const narrow = await measureLayout(page);
    assert(narrow.overlay !== null, "좁은 화면 문서 오버레이가 없습니다.");
    assert(narrow.overlay.left < narrow.canvas.left, "좁은 화면 오버레이가 왼쪽 자료 영역으로 확장되지 않았습니다.");
    assert(narrow.overlay.right <= narrow.chat.left, "좁은 화면 오버레이가 채팅을 덮습니다.");
    await capture(page, theme, "04-document-narrow");

    await overlay.getByRole("button", { name: "문서 편집기 접기" }).click();
    await overlay.waitFor({ state: "hidden" });
    assert(pageErrors.length === 0, `브라우저 오류가 발생했습니다: ${pageErrors.join(" | ")}`);

    return {
      cards: await tiles.count(),
      checklistInResources: true,
      centralSessions: 0,
      overlapsBefore: before.pairOverlaps,
      overlapsAfter: after.pairOverlaps,
      wideOverlayInsideBoard: true,
      narrowOverlayStopsBeforeChat: true,
      boardRefetches: boardReads - readsBefore,
      restWrites: boardWrites,
    };
  } finally {
    await context.close();
  }
}

async function measureLayout(page: Page) {
  return await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector}를 찾지 못했습니다.`);
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-board-tile="true"]'))
      .map((card) => {
        const bounds = card.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      });
    const overlayElement = document.querySelector<HTMLElement>('[data-testid="v3-task-board-document-overlay"]');
    const overlayBounds = overlayElement?.getBoundingClientRect();
    return {
      resources: rect('[data-testid="v3-task-board-resources"]'),
      canvas: rect('[data-testid="v3-task-board-canvas"]'),
      chat: rect('[data-testid="v3-task-board-chat"]'),
      overlay: overlayBounds ? {
        left: overlayBounds.left,
        right: overlayBounds.right,
        top: overlayBounds.top,
        bottom: overlayBounds.bottom,
        width: overlayBounds.width,
        height: overlayBounds.height,
      } : null,
      pairOverlaps: cards.flatMap((left, index) => (
        cards.slice(index + 1).map((right) => overlaps(left, right))
      )).filter(Boolean).length,
    };
  });
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
