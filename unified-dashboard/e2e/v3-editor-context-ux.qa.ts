import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const mode = process.env.PR_AD_QA_MODE === "before" ? "before" : "after";
const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AD_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-editor-context-ux"),
  mode,
);

console.log(`[pr-ad/qa] ${mode} 시작 · ${baseUrl}`);
const results = await runPlaywrightLifecycle({
  lockName: `pr-ad-editor-context-${mode}`,
  timeoutMs: 120_000,
}, async ({ browser }) => {
  console.log("[pr-ad/qa] Chromium 시작됨");
  const desktop = await openFixturePage(browser, { width: 1440, height: 1000 });
  console.log("[pr-ad/qa] fixture page 준비됨");
  try {
    const shifts = mode === "before"
      ? await captureBefore(desktop)
      : await captureAfter(desktop);

    if (mode === "after") await captureMobile(desktop);
    return shifts;
  } finally {
    await desktop.context().close();
  }
});
console.log(JSON.stringify({ ok: true, mode, residualProcesses: 0, ...results }, null, 2));

async function captureBefore(page: Page) {
  await gotoPlanner(page);
  const memo = page.locator(".v3-daily-memo");
  console.log("[pr-ad/qa] 기준 오늘 메모 확인");
  await waitVisible(memo.locator("textarea"), "기준 오늘 메모 textarea");
  console.log("[pr-ad/qa] 기준 오늘 메모 textarea 확인됨");
  await capture(page, "01-daily-memo-always-open");

  await openProject(page);
  const context = page.getByTestId("v3-project-context");
  const heightBefore = await elementHeight(context);
  await context.locator("button.v3-project-context-chip").filter({ hasText: "soulstream" }).click();
  await waitVisible(context.locator(".v3-project-context-editor"), "기준 atom 인라인 편집기");
  const heightAfter = await elementHeight(context);
  if (heightAfter - heightBefore < 40) {
    throw new Error(`기준 화면에서 atom 인라인 편집의 레이아웃 이동을 재현하지 못했습니다: ${heightBefore} → ${heightAfter}`);
  }
  await capture(page, "02-atom-inline-layout-shift");

  await gotoPlanner(page);
  await openPrimaryTask(page);
  await page.getByRole("button", { name: /PR-O 결정 로그/ }).click();
  const inlineMarkdown = page.getByTestId("v3-inline-markdown");
  await waitVisible(inlineMarkdown, "기준 인라인 마크다운");
  await waitCount(inlineMarkdown.locator("textarea"), 0, "기준 인라인 마크다운 textarea");
  await capture(page, "03-inline-markdown-readonly");
  return { atomContextHeightBefore: heightBefore, atomContextHeightAfter: heightAfter };
}

async function captureAfter(page: Page) {
  await gotoPlanner(page);
  const memo = page.locator(".v3-daily-memo");
  await waitCount(memo.locator("textarea"), 0, "오늘 메모 textarea");
  await waitVisible(memo.getByRole("button", { name: "오늘 메모 편집" }), "오늘 메모 편집 버튼");
  await capture(page, "01-daily-memo-preview");
  await memo.getByRole("button", { name: "오늘 메모 편집" }).click();
  await waitVisible(memo.getByRole("textbox", { name: "오늘 메모 마크다운" }), "오늘 메모 마크다운 편집기");
  await capture(page, "02-daily-memo-editor");

  await gotoPlanner(page);
  await openProject(page);
  const context = page.getByTestId("v3-project-context");
  const atomHeightBefore = await elementHeight(context);
  await page.getByRole("button", { name: /soulstream atom 설정 편집/ }).click();
  await waitVisible(page.locator('[data-editor-presentation="popover"]'), "atom popover");
  const atomHeightAfter = await elementHeight(context);
  if (Math.abs(atomHeightAfter - atomHeightBefore) > 1) {
    throw new Error(`atom popover가 본문 높이를 바꿨습니다: ${atomHeightBefore} → ${atomHeightAfter}`);
  }
  await capture(page, "03-atom-popover-layout-stable");
  await page.keyboard.press("Escape");
  await waitCount(page.locator('[data-editor-presentation="popover"]'), 0, "닫힌 atom popover");

  const guidance = page.getByTestId("v3-project-guidance-project-guidance");
  await waitText(guidance, "프로젝트의 결정을 실제 근거와 함께 기록하고", "프로젝트 guidance");
  const guidancePanelHeightBefore = await elementHeight(guidance);
  const guidanceHeightBefore = await elementHeight(context);
  await guidance.getByRole("button", { name: "프로젝트 guidance 편집" }).click();
  await waitVisible(page.getByRole("textbox", { name: "프로젝트 guidance 마크다운" }), "guidance 마크다운 편집기");
  await page.waitForTimeout(250);
  const guidanceEditor = page.getByTestId("v3-project-guidance-project-guidance");
  const guidancePanelHeightAfter = await elementHeight(guidanceEditor);
  const guidanceEditorMetrics = await guidanceEditor.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    const computed = getComputedStyle(htmlElement);
    return {
      inlineMinHeight: htmlElement.style.minHeight,
      computedHeight: computed.height,
      computedMinHeight: computed.minHeight,
      className: htmlElement.className,
      offsetHeight: htmlElement.offsetHeight,
      transform: computed.transform,
    };
  });
  console.log(`[pr-ad/qa] guidance 패널 · ${guidancePanelHeightBefore} → ${guidancePanelHeightAfter} · ${JSON.stringify(guidanceEditorMetrics)}`);
  const guidanceHeightAfter = await elementHeight(context);
  if (Math.abs(guidanceHeightAfter - guidanceHeightBefore) > 12) {
    throw new Error(`guidance 제자리 편집의 높이 이동이 큽니다: ${guidanceHeightBefore} → ${guidanceHeightAfter}`);
  }
  await capture(page, "04-guidance-inline-edit");

  await gotoPlanner(page);
  await openPrimaryTask(page);
  await page.getByRole("button", { name: /PR-O 결정 로그/ }).click();
  const inlineMarkdown = page.getByTestId("v3-inline-markdown");
  await inlineMarkdown.getByRole("button", { name: "PR-O 결정 로그 문서 편집" }).click();
  const editor = inlineMarkdown.getByRole("textbox", { name: "PR-O 결정 로그 문서 마크다운" });
  await editor.fill("## 수정된 결정\n\n왕복 저장 검증");
  await capture(page, "05-inline-markdown-editor");
  const saved = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/markdown-documents/doc-inline"
      && response.request().method() === "PUT"
  ));
  await editor.press("Control+Enter");
  await saved;
  await waitText(inlineMarkdown, "왕복 저장 검증", "저장 직후 인라인 마크다운");

  await gotoPlanner(page);
  await openPrimaryTask(page);
  await page.getByRole("button", { name: /PR-O 결정 로그/ }).click();
  const roundtripMarkdown = page.getByTestId("v3-inline-markdown");
  await waitText(roundtripMarkdown, "왕복 저장 검증", "재조회 인라인 마크다운");
  await roundtripMarkdown.scrollIntoViewIfNeeded();
  await capture(page, "06-inline-markdown-roundtrip");
  return {
    atomContextHeightBefore: atomHeightBefore,
    atomContextHeightAfter: atomHeightAfter,
    guidanceContextHeightBefore: guidanceHeightBefore,
    guidanceContextHeightAfter: guidanceHeightAfter,
  };
}

async function captureMobile(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPlanner(page);
  const openArchive = page.getByRole("button", { name: "아카이브 보기 ›", exact: true });
  await waitVisible(openArchive, "390px 프로젝트 아카이브 진입 버튼");
  await openArchive.click();
  await waitVisible(page.getByTestId("v3-project-context"), "390px 프로젝트 컨텍스트");
  const context = page.getByTestId("v3-project-context");
  const heightBefore = await elementHeight(context);
  await page.getByRole("button", { name: /soulstream atom 설정 편집/ }).click();
  const popover = page.locator('[data-editor-presentation="popover"]');
  await waitVisible(popover, "390px atom popover");
  const heightAfter = await elementHeight(context);
  if (Math.abs(heightAfter - heightBefore) > 1) throw new Error("390px atom popover가 본문 높이를 변경했습니다.");
  const bounds = await popover.boundingBox();
  if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 390) throw new Error("390px popover가 viewport를 벗어났습니다.");
  await capture(page, "07-mobile-390-context-popover");
}

async function openFixturePage(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ colorScheme: "dark", reducedMotion: "reduce", viewport });
  const page = await context.newPage();
  page.on("framenavigated", (frame) => console.log(`[pr-ad/qa] navigate · ${frame.url()}`));
  page.on("pageerror", (error) => console.error(`[pr-ad/qa] page error · ${error.message}`));
  page.on("requestfailed", (request) => (
    console.error(`[pr-ad/qa] request failed · ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`)
  ));
  await page.addInitScript({
    content: `
      localStorage.setItem("soul-dashboard-theme", "dark");
      localStorage.setItem("ls.webglGlass", "0");
      const serviceWorker = navigator.serviceWorker;
      if (serviceWorker) {
        Object.defineProperty(serviceWorker, "register", {
          configurable: true,
          value: async () => ({
            update: async () => undefined,
            active: null,
            installing: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }),
        });
        Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
      }
    `,
  });
  await installV3VisualQaRoutes(page);
  return page;
}

async function gotoPlanner(page: Page) {
  console.log("[pr-ad/qa] /v3 진입");
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  try {
    await waitVisible(page.getByTestId("v3-task-task-alpha"), "플래너 업무 카드");
  } catch (error) {
    console.error(`[pr-ad/qa] 현재 URL · ${page.url()}`);
    const bodyText = await page.locator("body").textContent({ timeout: 1_000 }).catch(() => "본문 조회 실패");
    console.error(`[pr-ad/qa] 화면 본문 · ${(bodyText ?? "").slice(0, 2_000)}`);
    throw error;
  }
  console.log("[pr-ad/qa] 플래너 로드됨");
}

async function openProject(page: Page) {
  const project = page.getByTestId("v3-all-projects")
    .locator(".v3-project-nav-row")
    .filter({ hasText: fixtureTitles.project });
  await project.click();
  await waitVisible(page.getByTestId("v3-project-context"), "프로젝트 컨텍스트");
  console.log("[pr-ad/qa] 프로젝트 컨텍스트 열림");
}

async function openPrimaryTask(page: Page) {
  await page.getByTestId("v3-task-task-alpha").click();
  await waitVisible(page.getByRole("heading", { name: fixtureTitles.primaryTask, level: 2 }), "업무 상세 제목");
  console.log("[pr-ad/qa] 업무 상세 열림");
}

async function elementHeight(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("요소의 bounding box를 구하지 못했습니다.");
  return box.height;
}

async function waitVisible(locator: Locator, label: string) {
  try {
    await locator.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    throw new Error(`${label}이 보이지 않습니다.`, { cause: error });
  }
}

async function waitCount(locator: Locator, expected: number, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await locator.count() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} 개수가 ${expected}이 아닙니다. 실제: ${await locator.count()}`);
}

async function waitText(locator: Locator, expected: string, label: string) {
  await waitVisible(locator, label);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await locator.textContent())?.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}에 기대한 문구가 없습니다: ${expected}`);
}

async function capture(page: Page, name: string) {
  console.log(`[pr-ad/qa] 캡처 시작 · ${name}`);
  mkdirSync(outputRoot, { recursive: true });
  await page.screenshot({ path: path.join(outputRoot, `${name}.png`), animations: "disabled", timeout: 10_000 });
  console.log(`[pr-ad/qa] 캡처 완료 · ${name}`);
}
