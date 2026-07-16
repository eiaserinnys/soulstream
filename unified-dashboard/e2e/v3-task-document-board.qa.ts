import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BI_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-task-document-board"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bi-v3-task-document-board",
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
    const inlineBoard = page.getByTestId("v3-inline-board");
    await inlineBoard.waitFor({ state: "visible", timeout: 20_000 });

    assert(await page.locator(".v3-task-documents").count() === 0, "기존 문서 마운트 목록이 남았습니다.");
    assert(await page.getByText("＋ 문서", { exact: true }).count() === 0, "기존 문서 추가 입구가 남았습니다.");
    assert(await page.getByText("프로젝트로 승격", { exact: true }).count() === 0, "기존 문서 승격 입구가 남았습니다.");

    const existingMarkdownRow = inlineBoard.locator('[data-board-kind="markdown"]').first();
    const existingTitle = ((await existingMarkdownRow.locator("span").first().innerText()).replace(/^📄\s*/, "")).trim();
    const initialMarkdownCount = await inlineBoard.locator('[data-board-kind="markdown"]').count();
    const createButton = inlineBoard.getByRole("button", { name: "＋ 마크다운" });
    await createButton.click();
    const createInput = inlineBoard.getByRole("textbox", { name: "마크다운 이름" });
    await createInput.waitFor({ state: "visible" });
    assert(
      await inlineBoard.locator('[data-board-kind="markdown"]').count() === initialMarkdownCount + 1,
      "Y.Doc 생성 후 마크다운 행이 즉시 추가되지 않았습니다.",
    );
    await createInput.press("Escape");

    const renameButton = inlineBoard.getByRole("button", { name: `${existingTitle} 이름 수정` });
    await renameButton.click();
    const renameInput = inlineBoard.getByRole("textbox", { name: "마크다운 이름" });
    const renamedTitle = `${theme === "dark" ? "다크" : "라이트"} 업무 결정 로그`;
    await renameInput.fill(renamedTitle);
    const renameResponse = page.waitForResponse((response) => (
      response.url().includes("/api/markdown-documents/doc-inline")
      && response.request().method() === "PUT"
    ));
    await inlineBoard.getByRole("button", { name: "저장" }).click();
    await renameResponse;
    await page.waitForTimeout(200);
    const boardTextAfterRename = await inlineBoard.innerText();
    assert(
      boardTextAfterRename.includes(renamedTitle),
      `낙관 이름 수정 결과가 유지되지 않았습니다: ${boardTextAfterRename}`,
    );
    assert(errors.length === 0, `이름 수정 전 브라우저 오류가 발생했습니다: ${errors.join(" | ")}`);

    await page.route("**/api/markdown-documents/doc-inline", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "conflict" }) });
        return;
      }
      await route.fallback();
    });
    await inlineBoard.getByRole("button", { name: `${renamedTitle} 이름 수정` }).click();
    const failedTitle = `${renamedTitle} 실패`;
    await inlineBoard.getByRole("textbox", { name: "마크다운 이름" }).fill(failedTitle);
    const conflictResponse = page.waitForResponse((response) => (
      response.url().includes("/api/markdown-documents/doc-inline")
      && response.request().method() === "PUT"
      && response.status() === 409
    ));
    await inlineBoard.getByRole("button", { name: "저장" }).click();
    await conflictResponse;
    await inlineBoard.getByRole("alert").waitFor({ state: "visible" });
    const restoredInput = inlineBoard.getByRole("textbox", { name: "마크다운 이름" });
    assert(await restoredInput.inputValue() === renamedTitle, "실패 뒤 원래 문서 이름이 복구되지 않았습니다.");

    const unexpectedErrors = errors.filter((message) => !message.includes("409 (Conflict)"));
    assert(unexpectedErrors.length === 0, `브라우저 오류가 발생했습니다: ${unexpectedErrors.join(" | ")}`);
    await capture(page, theme, "01-board-documents");
    return {
      legacyMountEntranceHidden: true,
      markdownCreatedThroughYDoc: true,
      markdownRenamedInline: true,
      renameRollbackOnFailure: true,
      browserErrors: unexpectedErrors.length,
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
