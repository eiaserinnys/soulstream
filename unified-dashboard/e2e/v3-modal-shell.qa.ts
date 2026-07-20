import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CC_QA_OUTPUT ?? path.join("e2e", "evidence", "pr-cc-modal-dialogs", "after"),
);
const baseline = process.env.PR_CC_QA_BASELINE === "1";

const result = await runPlaywrightLifecycle({
  lockName: `pr-cc-modal-shell-${baseline ? "before" : "after"}`,
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) themes.push(await verifyTheme(browser, theme));
  return { baseline, themes };
});

mkdirSync(outputRoot, { recursive: true });
writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  try {
    await preparePage(page, theme);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "새 업무", exact: true }).click();
    const newTaskDialog = page.getByRole("dialog", { name: "새 업무", exact: true });
    await newTaskDialog.waitFor({ state: "visible" });
    const newTask = await readModalMetrics(page, newTaskDialog);
    await capture(page, theme, "new-task");
    await page.getByRole("button", { name: "취소", exact: true }).click();

    await page.getByTestId("v3-all-projects")
      .getByRole("button", { name: fixtureTitles.project, exact: true })
      .click();
    await page.getByRole("heading", { name: fixtureTitles.project }).waitFor({ state: "visible" });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const newSessionDialog = page.getByRole("dialog", { name: "새 세션", exact: true });
    await newSessionDialog.waitFor({ state: "visible" });
    const newSession = await readModalMetrics(page, newSessionDialog);
    const succession = await readSuccessionMetrics(page, newSessionDialog);
    await capture(page, theme, "new-session");

    if (!baseline) {
      assertModalContract(theme, "새 업무", newTask);
      assertModalContract(theme, "새 세션", newSession);
      assert(succession.sectionOrder, `${theme}: 새 세션 항목 순서가 다릅니다.`);
      assert(!succession.hasRemovedGuidance, `${theme}: 삭제한 추가 지침 입력이 남았습니다.`);
      assert(!succession.hasLegacyTerms, `${theme}: 새 세션에 기존 실행/기본 지침 명칭이 남았습니다.`);
      assert(succession.documentOverflowY === "auto", `${theme}: 보드 문서 프리뷰가 내부 스크롤 계약이 아닙니다.`);
      assert(succession.documentMaxHeight !== "none", `${theme}: 보드 문서 프리뷰 높이 제한이 없습니다.`);
      assert(succession.primaryFontPx >= 14, `${theme}: 새 세션 본문 폰트가 14px보다 작습니다.`);
      assert(succession.hasInitialInstruction, `${theme}: 초기 지시 입력란이 없습니다.`);
    }
    assert(errors.length === 0, `${theme}: 브라우저 오류: ${errors.join(" | ")}`);
    return { theme, newTask, newSession, succession };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme) {
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
  await installV3VisualQaRoutes(page, { successionPickerRuns: true });
}

async function readModalMetrics(page: Page, dialog: Locator) {
  const box = await dialog.boundingBox();
  if (!box) throw new Error("모달 좌표를 읽지 못했습니다.");
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    centerDeltaPx: Math.round((box.y + box.height / 2 - viewportHeight / 2) * 100) / 100,
    placement: await page.locator('[data-slot="dialog-viewport"]').getAttribute("data-modal-placement"),
    liquidGlassClass: await dialog.evaluate((element) => element.classList.contains("liquid-glass-card")),
    liquidGlassEnhanced: await dialog.getAttribute("data-liquid-glass-enhanced"),
    liquidGlassLayerCount: await dialog.locator(".liquid-glass-card__layer").count(),
  };
}

async function readSuccessionMetrics(page: Page, dialog: Locator) {
  const text = await dialog.textContent() ?? "";
  const labels = ["노드 / 에이전트", "컨텍스트", "초기 지시"];
  const positions = labels.map((label) => text.indexOf(label));
  const documents = dialog.locator(".v3-succession-document-options");
  const documentStyle = await documents.evaluate((element) => {
    const style = getComputedStyle(element);
    return { overflowY: style.overflowY, maxHeight: style.maxHeight };
  });
  const primaryFontPx = Number.parseFloat(await dialog.locator(".v3-succession-context-editor > section > strong").first().evaluate(
    (element) => getComputedStyle(element).fontSize,
  ));
  return {
    sectionOrder: positions.every((position, index) => position >= 0 && (index === 0 || positions[index - 1] < position)),
    hasRemovedGuidance: text.includes("추가 지침"),
    hasLegacyTerms: text.includes("실행 에이전트") || text.includes("실행 노드") || text.includes("기본 지침"),
    documentOverflowY: documentStyle.overflowY,
    documentMaxHeight: documentStyle.maxHeight,
    primaryFontPx,
    hasInitialInstruction: await dialog.getByRole("textbox", { name: "초기 지시" }).count() === 1,
  };
}

function assertModalContract(theme: Theme, name: string, metrics: Awaited<ReturnType<typeof readModalMetrics>>) {
  assert(Math.abs(metrics.centerDeltaPx) <= 1, `${theme} ${name}: 세로 중앙 편차 ${metrics.centerDeltaPx}px`);
  assert(metrics.placement === "center", `${theme} ${name}: 공통 중앙 셸을 쓰지 않습니다.`);
  assert(metrics.liquidGlassClass, `${theme} ${name}: liquid-glass-card 정본 클래스가 없습니다.`);
  assert(metrics.liquidGlassEnhanced === "true", `${theme} ${name}: 리퀴드 글래스 향상 레이어가 비활성입니다.`);
  assert(metrics.liquidGlassLayerCount === 1, `${theme} ${name}: 리퀴드 글래스 레이어가 정확히 하나가 아닙니다.`);
}

async function capture(page: Page, theme: Theme, name: string) {
  mkdirSync(outputRoot, { recursive: true });
  await page.screenshot({
    path: path.join(outputRoot, `${theme}-${name}.png`),
    animations: "disabled",
    fullPage: false,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
