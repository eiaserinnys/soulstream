import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Mode = "before" | "after";
type Theme = "dark" | "light";

const atomNodeId = "e6abe00f-3f3f-47ee-9188-c7a6320bd426";
const atomNodeTitle = "xops";
const mode = requiredVariant<Mode>(process.env.PR_CJ_QA_MODE, ["before", "after"], "PR_CJ_QA_MODE");
const theme = requiredVariant<Theme>(process.env.PR_CJ_QA_THEME, ["dark", "light"], "PR_CJ_QA_THEME");
const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(process.env.PR_CJ_QA_OUTPUT ?? path.join(".local", "artifacts", "screenshots", "pr-cj"));

const result = await runPlaywrightLifecycle({
  lockName: `pr-cj-context-editing-${mode}-${theme}`,
  timeoutMs: 120_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => verify(browser));

console.log(JSON.stringify({ ok: true, mode, theme, residualProcesses: 0, ...result }, null, 2));

async function verify(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  const taskOperations: Array<{ operations?: Array<Record<string, unknown>> }> = [];
  const taskCreates: Record<string, unknown>[] = [];
  let plannerTodayRequests = 0;
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/pages/task-beta/operations" && request.method() === "POST") {
      taskOperations.push(request.postDataJSON() as { operations?: Array<Record<string, unknown>> });
    }
  });

  try {
    await preparePage(page);
    await installV3VisualQaRoutes(page, {
      contextChainPreview: true,
      legacyAtomContext: mode === "before",
      taskContextEditing: mode === "after",
      onPlannerTodayRequest: (count) => { plannerTodayRequests = count; },
      onTaskCreate: mode === "after" ? (payload) => taskCreates.push(payload) : undefined,
    });
    await page.route("**/api/atom/nodes", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          children: [{ id: atomNodeId, card_id: "qa-xops-card", card: { title: atomNodeTitle, card_type: "knowledge" } }],
        }),
      });
    });

    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByTestId("v3-task-task-beta").waitFor({ state: "visible", timeout: 20_000 });
    } catch (cause) {
      console.error(JSON.stringify({ browserErrors, pageUrl: page.url(), body: (await page.locator("body").textContent() ?? "").slice(0, 2_000) }));
      await capture(page, "diagnostic-load-failure").catch(() => undefined);
      throw cause;
    }

    await page.getByRole("button", { name: "새 업무", exact: true }).click();
    const newTaskDialog = page.getByRole("dialog", { name: "새 업무", exact: true });
    await newTaskDialog.waitFor({ state: "visible" });
    if (mode === "after") {
      await newTaskDialog.getByRole("button", { name: "＋ 컨텍스트", exact: true }).click();
      await newTaskDialog.getByLabel("업무 직접 guidance").fill("PR-CJ 직접 guidance");
      await newTaskDialog.getByRole("tab", { name: "atom" }).click();
      await selectAtomNode(newTaskDialog, page);
      const selected = newTaskDialog.locator(".v3-context-option--selected");
      await waitForText(selected, atomNodeTitle);
      assert((await selected.textContent())?.includes(atomNodeId), "새 업무 atom 선택에 nodeId 메타가 없습니다.");
    }
    await capture(page, "01-new-task-dialog");

    if (mode === "after") {
      await newTaskDialog.getByLabel("새 업무 제목").fill("PR-CJ 생성 컨텍스트 QA");
      await newTaskDialog.getByRole("button", { name: "업무 만들기", exact: true }).click();
      await waitUntil(() => taskCreates.length === 1, "새 업무 생성 payload");
      const initialContext = taskCreates[0]?.initial_context as Record<string, unknown> | undefined;
      assert(initialContext?.guidance === "PR-CJ 직접 guidance", "생성 guidance가 initial_context에 없습니다.");
      const references = initialContext?.atom_references;
      assert(Array.isArray(references) && references.length === 1, "생성 atom_references가 한 건이 아닙니다.");
      assert((references[0] as Record<string, unknown>).node_title === atomNodeTitle, "생성 atom 제목 스냅샷이 없습니다.");
    } else {
      await newTaskDialog.getByRole("button", { name: "취소", exact: true }).click();
    }

    await page.getByTestId("v3-task-task-beta").click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.secondaryTask }).waitFor({ state: "visible", timeout: 20_000 });
    const information = page.locator('[data-task-section="information"]');
    await waitForText(information, "컨텍스트");
    const requestsBeforeMutation = plannerTodayRequests;

    if (mode === "before") {
      const legacyRow = information.locator(".v3-context-chips > span").filter({ hasText: atomNodeId });
      await legacyRow.waitFor({ state: "visible" });
      assert(!(await legacyRow.textContent() ?? "").includes(atomNodeTitle), "기준 화면에서 UUID 결함이 재현되지 않았습니다.");
    } else {
      await information.getByRole("button", { name: "컨텍스트 추가", exact: true }).click();
      const picker = information.locator(".v3-context-picker");
      await picker.getByRole("tab", { name: "atom" }).click();
      await selectAtomNode(picker, page);
      await picker.getByRole("button", { name: "선택 추가", exact: true }).click();

      const row = information.locator(".v3-context-row").filter({ hasText: atomNodeTitle });
      await row.waitFor({ state: "visible", timeout: 20_000 });
      const rowText = await row.textContent() ?? "";
      assert(rowText.includes(atomNodeTitle), "직접 추가 atom 행에 노드 제목이 없습니다.");
      assert(!rowText.includes(atomNodeId), "직접 추가 atom 행에 UUID가 제목으로 노출됩니다.");

      await row.getByLabel(`${atomNodeTitle} atom depth`).selectOption("5");
      await row.getByLabel(`${atomNodeTitle} 제목만 포함`).check();
      await waitUntil(() => taskOperations.length >= 3, "atom 추가·depth·titles_only 부분 패치");
      const updates = taskOperations.slice(1, 3).flatMap((request) => request.operations ?? []);
      assert(updates.every((operation) => operation.op === "update_block_type_and_properties"), "설정 저장이 기존 블록 mutation을 사용하지 않았습니다.");
      assert(updates.every((operation) => Object.keys(operation).includes("block_id")), "설정 저장에 block_id 부분 패치가 없습니다.");
      assert(plannerTodayRequests === requestsBeforeMutation, `컨텍스트 저장 뒤 광역 재조회가 발생했습니다: ${requestsBeforeMutation} → ${plannerTodayRequests}`);
    }

    await information.scrollIntoViewIfNeeded();
    await capture(page, "02-task-context");

    if (mode === "after") {
      const row = information.locator(".v3-context-row").filter({ hasText: atomNodeTitle });
      await row.getByRole("button", { name: `${atomNodeTitle} 컨텍스트 제거`, exact: true }).click();
      await waitUntil(() => taskOperations.length >= 4, "atom 삭제 operation");
      const deletion = taskOperations.at(-1)?.operations?.[0];
      assert(deletion?.op === "delete_block_subtree", "atom 제거가 블록 삭제 정본을 사용하지 않았습니다.");
    }

    assert(browserErrors.length === 0, `브라우저 오류: ${browserErrors.join(" | ")}`);
    return { plannerTodayRequests, taskOperationCount: taskOperations.length, taskCreateCount: taskCreates.length, screenshotRoot: path.join(outputRoot, mode, theme) };
  } finally {
    await context.close();
  }
}

async function selectAtomNode(scope: import("@playwright/test").Locator, page: Page) {
  await scope.getByRole("button", { name: /노드 선택/ }).click();
  await page.getByRole("button", { name: atomNodeTitle, exact: true }).click();
}

async function preparePage(page: Page) {
  await page.addInitScript({ content: `
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
  ` });
}

async function waitForText(locator: import("@playwright/test").Locator, text: string) {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  await waitUntil(async () => (await locator.textContent())?.includes(text) === true, `텍스트 ${text}`);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}을 확인하지 못했습니다.`);
}

async function capture(page: Page, name: string) {
  const directory = path.join(outputRoot, mode, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function requiredVariant<T extends string>(value: string | undefined, options: readonly T[], name: string): T {
  if (value && options.includes(value as T)) return value as T;
  throw new Error(`${name}은 ${options.join(" 또는 ")}여야 합니다.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
