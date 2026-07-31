import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type ViewportName = "desktop" | "narrow";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.AGENT_MODEL_QA_OUTPUT
    ?? path.join(".local", "artifacts", "screenshots", "agent-model-settings-density"),
);

const result = await runPlaywrightLifecycle({
  lockName: "agent-model-settings-density",
  timeoutMs: 180_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => ({
  desktop: await verifyViewport(browser, "desktop", { width: 1440, height: 1000 }),
  narrow: await verifyViewport(browser, "narrow", { width: 390, height: 844 }),
}));

mkdirSync(outputRoot, { recursive: true });
writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyViewport(
  browser: Browser,
  viewportName: ViewportName,
  viewport: { width: number; height: number },
) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport,
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-beta").waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "새 업무", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 업무", exact: true });
    await dialog.waitFor({ state: "visible" });
    const newTaskAssignment = dialog.getByTestId("new-task-default-assignment");
    await newTaskAssignment.scrollIntoViewIfNeeded();
    const newTaskMetrics = await readAssignmentMetrics(newTaskAssignment);
    assertAssignmentContract(viewportName, "새 업무", newTaskMetrics);
    await capture(page, viewportName, "01-new-task");
    await dialog.getByRole("button", { name: "취소", exact: true }).click();

    await page.getByTestId("v3-task-task-beta").click();
    await page.locator(".v3-task-title-button")
      .filter({ hasText: fixtureTitles.secondaryTask })
      .waitFor({ state: "visible", timeout: 30_000 });
    const information = page.locator('[data-task-section="information"]');
    const summary = information.getByTestId("task-default-summary");
    await summary.waitFor({ state: "visible" });
    await summary.getByText("roselin_codex", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const summaryMetrics = await readSummaryMetrics(summary);
    assertSummaryContract(viewportName, summaryMetrics);
    await information.scrollIntoViewIfNeeded();
    await capture(page, viewportName, "02-task-summary");

    await information.getByRole("button", { name: "기본 담당 편집", exact: true }).click();
    const editor = information.locator(".v3-task-default-editor");
    await editor.getByLabel("노드 선택").waitFor({ state: "visible" });
    await editor.getByLabel("에이전트 선택").waitFor({ state: "visible" });
    await editor.scrollIntoViewIfNeeded();
    const editorMetrics = await readAssignmentMetrics(editor);
    assertAssignmentContract(viewportName, "업무 편집", editorMetrics);
    await capture(page, viewportName, "03-task-editor");
    await editor.getByRole("button", { name: "취소", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await summary.waitFor({ state: "visible" });

    assert(browserErrors.length === 0, `${viewportName}: 브라우저 오류: ${browserErrors.join(" | ")}`);
    return {
      viewport,
      newTaskAssignment: newTaskMetrics,
      taskSummary: summaryMetrics,
      taskEditor: editorMetrics,
      browserErrors: browserErrors.length,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page) {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", "dark");
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
  await installV3VisualQaRoutes(page, {
    contextChainPreview: true,
    taskDefaultAssignment: true,
  });
}

async function readAssignmentMetrics(scope: Locator) {
  const assignment = scope.locator(".v3-succession-assignment--compact-row").first();
  await assignment.waitFor({ state: "visible" });
  return assignment.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const fields = Array.from(element.children).map((candidate) => {
      const fieldRect = candidate.getBoundingClientRect();
      return {
        left: fieldRect.left,
        right: fieldRect.right,
        top: fieldRect.top,
        bottom: fieldRect.bottom,
        width: fieldRect.width,
        height: fieldRect.height,
      };
    });
    return {
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      fields,
      gridTemplateColumns: getComputedStyle(element).gridTemplateColumns,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
}

async function readSummaryMetrics(summary: Locator) {
  return summary.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const values = element.querySelector<HTMLElement>(".v3-task-default-values");
    const button = element.querySelector<HTMLElement>(".v3-task-default-edit");
    if (!values || !button) throw new Error("업무 기본 담당 요약 요소를 찾지 못했습니다.");
    const valueRect = values.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      text: element.textContent ?? "",
      valueParts: Array.from(values.children).map((candidate) => candidate.textContent ?? ""),
      flexWrap: getComputedStyle(values).flexWrap,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      values: {
        left: valueRect.left,
        right: valueRect.right,
        top: valueRect.top,
        bottom: valueRect.bottom,
      },
      button: {
        left: buttonRect.left,
        right: buttonRect.right,
        top: buttonRect.top,
        bottom: buttonRect.bottom,
      },
      buttonLabel: button.getAttribute("aria-label"),
      editButtonCount: element.querySelectorAll(".v3-task-default-edit").length,
    };
  });
}

function assertAssignmentContract(
  viewportName: ViewportName,
  surface: string,
  metrics: Awaited<ReturnType<typeof readAssignmentMetrics>>,
) {
  assert(metrics.fields.length === 3, `${surface}: 필드가 3개가 아닙니다.`);
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, `${surface}: 설정 행이 가로로 넘칩니다.`);
  assert(
    metrics.fields.every((field) => (
      field.left >= metrics.rect.left - 1 && field.right <= metrics.rect.right + 1
    )),
    `${surface}: 필드가 설정 영역 밖으로 나갑니다.`,
  );
  if (viewportName === "desktop") {
    const tops = metrics.fields.map((field) => field.top);
    assert(Math.max(...tops) - Math.min(...tops) <= 1, `${surface}: 데스크톱 필드가 한 행에 있지 않습니다.`);
  } else {
    assert(
      metrics.fields.slice(1).every((field, index) => field.top >= metrics.fields[index].bottom),
      `${surface}: 좁은 화면 필드가 안전하게 세로 배치되지 않습니다.`,
    );
  }
}

function assertSummaryContract(
  viewportName: ViewportName,
  metrics: Awaited<ReturnType<typeof readSummaryMetrics>>,
) {
  assert(!metrics.text.includes("모델 지정"), "업무 요약에 `모델 지정`이 남았습니다.");
  assert(!metrics.text.includes("직접 지정"), "업무 요약에 `직접 지정`이 남았습니다.");
  assert(metrics.valueParts.length === 5, "노드·에이전트·모델 요약 구조가 아닙니다.");
  assert(metrics.valueParts[0].length > 0 && metrics.valueParts[2].length > 0 && metrics.valueParts[4].length > 0, "요약 값이 비었습니다.");
  assert(metrics.editButtonCount === 1, "편집 버튼이 정확히 하나가 아닙니다.");
  assert(metrics.buttonLabel === "기본 담당 편집", "편집 버튼의 접근 가능한 이름이 다릅니다.");
  assert(metrics.values.right <= metrics.button.left + 1, "요약 값과 편집 버튼이 겹칩니다.");
  assert(metrics.button.right <= metrics.rect.right + 1, "편집 버튼이 요약 영역 밖으로 나갑니다.");
  assert(
    metrics.button.top >= metrics.rect.top - 1 && metrics.button.bottom <= metrics.rect.bottom + 1,
    "편집 버튼의 세로 정렬이 요약 영역을 벗어납니다.",
  );
  assert(metrics.flexWrap === (viewportName === "desktop" ? "nowrap" : "wrap"), `${viewportName}: 요약 줄바꿈 계약이 다릅니다.`);
}

async function capture(page: Page, viewportName: ViewportName, name: string) {
  const directory = path.join(outputRoot, viewportName);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
