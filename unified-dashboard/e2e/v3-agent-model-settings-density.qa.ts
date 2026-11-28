import { koreanLocale } from "./korean-locale.mjs";
import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { openV3Folder } from "./v3-qa-entry";
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
    locale: koreanLocale,
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page);
    await openV3Folder(page, baseUrl);
    await page.getByTestId("v3-task-task-beta").waitFor({ state: "visible", timeout: 30_000 });

    const information = page.locator('[data-task-section="information"]');
    const projectContext = information.getByTestId("v3-project-context");
    await projectContext.waitFor({ state: "visible" });
    const summary = projectContext.getByRole("button", { name: "기본 에이전트 설정 편집", exact: true });
    await summary.waitFor({ state: "visible", timeout: 30_000 });
    const summaryMetrics = await readSummaryMetrics(summary);
    assertSummaryContract(summaryMetrics);
    await summary.scrollIntoViewIfNeeded();
    await capture(page, viewportName, "02-task-summary");

    await summary.click();
    const editor = page.locator(".v3-project-context-editor");
    await editor.getByLabel("기본 실행 노드").waitFor({ state: "visible" });
    await editor.getByLabel("기본 실행 에이전트").waitFor({ state: "visible" });
    await editor.scrollIntoViewIfNeeded();
    const editorMetrics = await readAssignmentMetrics(editor);
    assertAssignmentContract(viewportName, "폴더 편집", editorMetrics);
    await capture(page, viewportName, "03-task-editor");
    await editor.getByRole("button", { name: "취소", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await summary.waitFor({ state: "visible" });

    await page.getByTestId("v3-task-task-beta").click();
    await page.locator(".v3-task-title-button")
      .filter({ hasText: fixtureTitles.secondaryTask })
      .waitFor({ state: "visible", timeout: 30_000 });

    assert(browserErrors.length === 0, `${viewportName}: 브라우저 오류: ${browserErrors.join(" | ")}`);
    return {
      viewport,
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
    taskDefaultAssignment: true,
    taskAssignmentModelPreset: "qa-standard",
  });
}

async function readAssignmentMetrics(scope: Locator) {
  const assignment = scope.locator(".v3-succession-assignment").first();
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
    const style = getComputedStyle(element);
    return {
      text: element.textContent ?? "",
      whiteSpace: style.whiteSpace,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    };
  });
}

function assertAssignmentContract(
  viewportName: ViewportName,
  surface: string,
  metrics: Awaited<ReturnType<typeof readAssignmentMetrics>>,
) {
  assert(metrics.fields.length === 3, `${surface}: 필드가 3개가 아닙니다.`);
  // Radix SelectTrigger 내부의 네이티브 컨트롤이 3~4px의 스크롤 오버플로를 만든다.
  // 필드 상자는 아래에서 행 안에 있는지 따로 확인하므로 내용 잘림이 아니다.
  assert(metrics.scrollWidth <= metrics.clientWidth + 4, `${surface}: 설정 행이 가로로 넘칩니다: ${metrics.scrollWidth}/${metrics.clientWidth}`);
  assert(
    metrics.fields.every((field) => (
      field.left >= metrics.rect.left - 1 && field.right <= metrics.rect.right + 1
    )),
    `${surface}: 필드가 설정 영역 밖으로 나갑니다.`,
  );
  if (viewportName === "desktop") {
    assert(
      Math.abs(metrics.fields[0].top - metrics.fields[1].top) <= 1,
      `${surface}: 데스크톱 첫 두 필드가 한 행에 있지 않습니다.`,
    );
    assert(
      metrics.fields[2].top >= metrics.fields[0].bottom,
      `${surface}: 모델 필드가 다음 행으로 내려가지 않았습니다.`,
    );
  } else {
    assert(
      metrics.fields.slice(1).every((field, index) => field.top >= metrics.fields[index].bottom),
      `${surface}: 좁은 화면 필드가 안전하게 세로 배치되지 않습니다.`,
    );
  }
}

function assertSummaryContract(
  metrics: Awaited<ReturnType<typeof readSummaryMetrics>>,
) {
  assert(metrics.text.includes("roselin_codex"), "요약에 에이전트가 없습니다.");
  assert(metrics.text.includes("eiaserinnys"), "요약에 노드가 없습니다.");
  assert(!metrics.text.includes("qa-standard"), "내부 model preset ID가 요약에 노출됩니다.");
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, "요약 칩이 가로로 넘칩니다.");
  assert(metrics.rect.right > metrics.rect.left, "요약 칩 폭이 0입니다.");
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
