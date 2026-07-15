import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AI_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-succession-picker"),
);
const playwrightModule = process.env.PR_AI_PLAYWRIGHT_MODULE;
const launchBrowser = playwrightModule
  ? async (launchOptions: Record<string, unknown>) => {
      const { chromium } = await import(playwrightModule);
      return chromium.launch(launchOptions);
    }
  : undefined;

const result = await runPlaywrightLifecycle({
  lockName: "pr-ai-v3-succession-picker",
  timeoutMs: 180_000,
  ...(launchBrowser ? { launchBrowser } : {}),
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
  const agentRequests: string[] = [];
  let sessionListRequests = 0;
  const createPayloads: Record<string, unknown>[] = [];
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
  await installV3VisualQaRoutes(page, {
    successionPickerRuns: true,
    onAgentListRequest: (nodeId) => agentRequests.push(nodeId),
    onSessionCreate: (payload) => { createPayloads.push(payload); },
    onSessionListRequest: () => { sessionListRequests += 1; },
  });

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible" });
    await page.getByTestId("v3-task-task-alpha").click();
    try {
      await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask }).waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      console.error(`[pr-ai/qa] 업무 진입 실패 URL · ${page.url()}`);
      console.error(`[pr-ai/qa] 업무 진입 실패 본문 · ${(await page.locator("body").textContent() ?? "").slice(0, 2_000)}`);
      await capture(page, theme, "diagnostic-task-open-failure");
      throw error;
    }
    await page.locator(".v3-run-row").filter({ hasText: "run #3" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "＋ 새 세션" }).click();

    const modal = page.locator(".v3-succession-modal");
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "visible" });
    const predecessor = page.getByRole("combobox", { name: "이어받을 이전 세션" });
    const optionLabels = await predecessor.locator("option").allTextContents();
    assert(optionLabels.some((label) => label.includes("🧭 다음 검증은 이전 실행을 골라 이어서 진행해 주세요.")), "lastMessage 선택지가 없습니다.");
    assert(optionLabels.some((label) => label.includes("시각 QA 순회")), "displayName 선택지가 없습니다.");
    assert(optionLabels.some((label) => label.includes("밀도 기준 정리")), "비직전 run 선택지가 없습니다.");
    assert(!(await modal.textContent() ?? "").includes("run-alpha-"), "모달에 세션 UUID가 노출됐습니다.");

    const modalText = await modal.textContent() ?? "";
    for (const required of [
      "새 세션의 컨텍스트",
      "플래너 UX 원칙",
      "대비와 잘림을 실제 픽셀로 확인",
      "디자인 검수 메모",
      "이전 세션을 이어 받을 경우 세션을 승계한 것으로 간주됩니다.",
    ]) assert(modalText.includes(required), `필수 문구/컨텍스트가 없습니다: ${required}`);
    for (const forbidden of [
      "승계 미리보기",
      "체크를 모두 끄면 빈 세션으로 시작합니다.",
      "목표·완료 조건·현재 결정",
      "컨텍스트 슬롯",
      "업무 카드 본문에 포함",
      "승계 링크로 기록됨",
    ]) assert(!modalText.includes(forbidden), `삭제 대상 문구가 남았습니다: ${forbidden}`);

    await page.getByRole("combobox", { name: "기본 실행 에이전트" })
      .locator('option[value="roselin_codex"]')
      .filter({ hasText: "로젤린" })
      .waitFor({ state: "attached" });
    await installMutationCounters(page);
    const agentRequestsBeforeObservation = agentRequests.length;
    const sessionRequestsBeforeObservation = sessionListRequests;
    await page.waitForTimeout(31_000);
    const mutations = await readMutationCounters(page);
    const agentRefetchesDuringObservation = agentRequests.length - agentRequestsBeforeObservation;
    assert(mutations.agent === 0, `에이전트 콤보 DOM 변이 ${mutations.agent}회`);
    assert(mutations.runs === 0, `배경 run 목록 DOM 변이 ${mutations.runs}회`);
    assert(agentRefetchesDuringObservation === 0, `에이전트 목록 재조회 ${agentRefetchesDuringObservation}회`);

    await page.getByRole("combobox", { name: "기본 실행 노드" }).selectOption("qa-node");
    await page.getByRole("combobox", { name: "기본 실행 에이전트" }).selectOption("qa-agent");
    assert(agentRequests.at(-1) === "qa-node", "노드 변경 후 에이전트 목록을 갱신하지 않았습니다.");

    const previousIndex = optionLabels.findIndex((label) => label.includes("밀도 기준 정리"));
    assert(previousIndex >= 0, "비직전 predecessor index를 찾지 못했습니다.");
    await predecessor.selectOption(String(previousIndex));
    await capture(page, theme, "01-picker-stable-30s");
    await page.getByRole("button", { name: "시작", exact: true }).click();
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "detached" });
    const createPayload = createPayloads.at(-1);
    assert(createPayload?.predecessor_session_id === "run-alpha-1", "비직전 predecessor가 생성 요청에 전달되지 않았습니다.");

    return {
      options: optionLabels.length,
      observedMs: 31_000,
      agentMutations: mutations.agent,
      runMutations: mutations.runs,
      agentRefetchesDuringObservation,
      sessionRequestsDuringObservation: sessionListRequests - sessionRequestsBeforeObservation,
      predecessorRoundtrip: createPayload?.predecessor_session_id,
      nodeChangeAgentRefresh: agentRequests.at(-1),
    };
  } finally {
    await context.close();
  }
}

async function installMutationCounters(page: Page) {
  await page.evaluate(() => {
    const state = { agent: 0, runs: 0 };
    (window as Window & { __prAiMutationCounts?: typeof state }).__prAiMutationCounts = state;
    const agent = document.querySelector('select[aria-label="기본 실행 에이전트"]');
    const runs = document.querySelector(".v3-run-list");
    if (!agent || !runs) throw new Error("플래싱 관찰 대상을 찾지 못했습니다.");
    new MutationObserver((records) => { state.agent += records.length; })
      .observe(agent, { childList: true, subtree: true, characterData: true });
    new MutationObserver((records) => { state.runs += records.length; })
      .observe(runs, { childList: true, subtree: true, characterData: true });
  });
}

async function readMutationCounters(page: Page) {
  return await page.evaluate(() => {
    const state = (window as Window & { __prAiMutationCounts?: { agent: number; runs: number } }).__prAiMutationCounts;
    if (!state) throw new Error("플래싱 관찰 카운터가 없습니다.");
    return state;
  });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
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
