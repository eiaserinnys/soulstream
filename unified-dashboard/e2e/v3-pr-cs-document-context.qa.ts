import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CS_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-pr-cs-document-context"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-cs-v3-document-context",
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
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").click();
    const board = page.getByTestId("v3-inline-board");
    await board.waitFor({ state: "visible" });
    const row = board.locator('[data-board-kind="markdown"] .v3-inline-board-row');
    await row.waitFor({ state: "visible" });

    const renamedTitle = "PR-CS 이름·본문 저장 확인";
    await page.getByRole("button", { name: "PR-O 결정 로그 이름 수정" }).click();
    const renameInput = page.getByRole("textbox", { name: "마크다운 이름" });
    await renameInput.fill(renamedTitle);
    const spacing = await page.locator(".v3-inline-board-rename-actions").evaluate((element) => {
      const style = getComputedStyle(element);
      const controls = [...element.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      return {
        gap: style.gap,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        controls,
      };
    });
    assert(spacing.gap === "4px", `이름 편집 버튼 간격이 4px가 아닙니다: ${spacing.gap}`);
    assert(spacing.paddingLeft === "4px" && spacing.paddingRight === "4px", `이름 편집 좌우 inset이 4px가 아닙니다: ${spacing.paddingLeft}/${spacing.paddingRight}`);
    assert(spacing.controls.every(({ width, height }) => width === 44 && height === 44), `이름 편집 hit area가 44px가 아닙니다: ${JSON.stringify(spacing.controls)}`);
    const renamePut = page.waitForResponse((response) => response.url().endsWith("/api/markdown-documents/doc-inline") && response.request().method() === "PUT");
    const renameReread = page.waitForResponse((response) => response.url().endsWith("/api/markdown-documents/doc-inline") && response.request().method() === "GET");
    await page.getByRole("button", { name: "마크다운 이름 변경 저장" }).click();
    await renamePut;
    await renameReread;
    await row.filter({ hasText: renamedTitle }).waitFor({ state: "visible" });

    await row.focus();
    await page.keyboard.press("Shift+F10");
    for (const label of ["문서 열기", "페이지 ID 복사", "다른 업무로 이동", "문서 삭제"]) {
      await page.getByRole("menuitem", { name: label }).waitFor({ state: "visible" });
    }
    await capture(page, theme, "01-inline-document-menu");
    await page.getByRole("menuitem", { name: "문서 열기" }).click();
    const inlineMarkdown = page.getByTestId("v3-inline-markdown");
    await inlineMarkdown.waitFor({ state: "visible" });
    const selectableContent = board.locator('[data-v3-selectable-content="true"]').first();
    await selectableContent.waitFor({ state: "visible" });
    await inlineMarkdown.getByRole("button", { name: `${renamedTitle} 문서 편집` }).first().click();
    const bodyEditor = inlineMarkdown.getByRole("textbox", { name: `${renamedTitle} 문서 마크다운` });
    const editedBody = "# 서버 재조회 완료\n\n입력 손실 없이 저장했습니다.";
    await bodyEditor.fill(editedBody);
    const bodyPut = page.waitForResponse((response) => response.url().endsWith("/api/markdown-documents/doc-inline") && response.request().method() === "PUT");
    const bodyReread = page.waitForResponse((response) => response.url().endsWith("/api/markdown-documents/doc-inline") && response.request().method() === "GET");
    await inlineMarkdown.getByRole("button", { name: "완료" }).click();
    await bodyPut;
    await bodyReread;
    await page.getByText("서버 재조회 완료", { exact: true }).waitFor({ state: "visible" });
    const selectionPolicy = await page.evaluate(() => ({
      shell: getComputedStyle(document.querySelector(".v3-shell")!).userSelect,
      row: getComputedStyle(document.querySelector(".v3-inline-board-row")!).userSelect,
      content: getComputedStyle(document.querySelector('[data-v3-selectable-content="true"]')!).userSelect,
      input: getComputedStyle(document.querySelector(".v3-shell input")!).userSelect,
    }));
    assert(selectionPolicy.shell === "none", `shell 선택 정책이 none이 아닙니다: ${selectionPolicy.shell}`);
    assert(selectionPolicy.row === "none", `조작 행 선택 정책이 none이 아닙니다: ${selectionPolicy.row}`);
    assert(selectionPolicy.content === "text", `문서 선택 정책이 text가 아닙니다: ${selectionPolicy.content}`);
    assert(selectionPolicy.input === "text", `입력 선택 정책이 text가 아닙니다: ${selectionPolicy.input}`);

    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "다른 업무로 이동" }).click();
    const moveResponse = page.waitForResponse((response) => (
      response.url().includes("/api/board-items/markdown%3Adoc-inline/container")
      && response.request().method() === "PATCH"
    ));
    await page.getByRole("button", { name: new RegExp(fixtureTitles.secondaryTask) }).click();
    await moveResponse;
    await row.waitFor({ state: "detached" });

    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
    await page.getByTestId("v3-task-task-beta").click();
    const movedRow = page.getByTestId("v3-inline-board").locator('[data-board-kind="markdown"] .v3-inline-board-row');
    await movedRow.waitFor({ state: "visible" });
    await movedRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "문서 삭제" }).click();
    await page.getByText(`‘${renamedTitle}’ 문서를 삭제하시겠습니까?`, { exact: false }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "취소" }).click();
    await movedRow.waitFor({ state: "visible" });

    await movedRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "문서 삭제" }).click();
    const deleteResponse = page.waitForResponse((response) => (
      response.url().endsWith("/api/markdown-documents/doc-inline")
      && response.request().method() === "DELETE"
    ));
    await page.getByRole("button", { name: "삭제" }).click();
    await deleteResponse;
    await movedRow.waitFor({ state: "detached" });
    await capture(page, theme, "02-moved-and-deleted");

    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
    await page.getByTestId("v3-session-row-run-outside-task").getByRole("button").first().click();
    await page.getByRole("button", { name: "업무 제목 편집" }).filter({ hasText: "완료한 접근성 정리" }).waitFor({ state: "visible" });
    await page.getByTestId("v3-standalone-session-chat").waitFor({ state: "detached" });
    assert(await page.getByText("연결된 업무가 없습니다.", { exact: true }).count() === 0, "데일리 밖 세션을 무소속으로 표시했습니다.");
    await capture(page, theme, "03-session-owning-task");

    const unexpectedErrors = errors.filter((message) => !message.includes("favicon"));
    assert(unexpectedErrors.length === 0, `브라우저 오류가 발생했습니다: ${unexpectedErrors.join(" | ")}`);
    return {
      renamedAndReread: true,
      bodySavedAndReread: true,
      inlineSpacing: spacing,
      owningTaskOpened: true,
      moved: true,
      deleted: true,
      keyboardMenu: true,
      selectionPolicy,
      browserErrors: 0,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Playwright jsdom local-board-yjs",
    });
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page, { outsideTaskSession: true });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
