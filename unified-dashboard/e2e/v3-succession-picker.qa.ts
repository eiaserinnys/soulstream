import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AI_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-succession-picker"),
);
const result = await runPlaywrightLifecycle({
  lockName: "pr-ai-v3-succession-picker",
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
  await page.route("**/api/atom/nodes", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        children: [{
          id: "qa-atom-node",
          card_id: "qa-atom-card",
          card: { title: "QA atom 컨텍스트", card_type: "knowledge" },
        }],
      }),
    });
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
    await page.locator(".v3-run-row").filter({ hasText: "세션 #3" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "컨텍스트 추가", exact: true }).click();
    const sharedPicker = page.locator(".v3-context-picker").filter({ has: page.getByRole("tab", { name: "atom" }) });
    const sharedTabs = await sharedPicker.getByRole("tab").allTextContents();
    assert(JSON.stringify(sharedTabs) === JSON.stringify(["📄 페이지", "🧠 atom"]), `공통 픽커 탭이 잘못됐습니다: ${JSON.stringify(sharedTabs)}`);
    assert(!(await sharedPicker.textContent() ?? "").includes("상속됨(프로젝트에서)"), "공통 픽커에 중복 상속 표시가 남았습니다.");
    await sharedPicker.getByRole("tab", { name: "atom" }).click();
    await sharedPicker.getByRole("button", { name: /노드 선택/ }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "컨텍스트 선택 닫기", exact: true }).click();
    await page.getByRole("button", { name: "새 세션", exact: true }).click();

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
      "노드 / 에이전트",
      "컨텍스트",
      "플래너 UX 원칙",
      "대비와 잘림을 실제 픽셀로 확인",
      "디자인 검수 메모",
      "보드 문서",
      "atom 노드",
      "추가 지침",
      "초기 지시",
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

    await modal.getByRole("checkbox", { name: "PR-O 결정 로그" }).check();
    await modal.locator("label").filter({ hasText: "atom 노드" }).locator("button").click();
    await page.getByRole("button", { name: "QA atom 컨텍스트", exact: true }).click();
    await modal.getByRole("textbox", { name: "추가 지침" }).fill("결과부터 간결하게 보고한다.");
    await modal.getByRole("textbox", { name: "초기 지시" }).fill("선택한 컨텍스트를 세 문장으로 요약하세요.");

    await page.getByRole("combobox", { name: "에이전트 선택" })
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

    await page.getByRole("combobox", { name: "노드 선택" }).selectOption("qa-node");
    await page.getByRole("combobox", { name: "에이전트 선택" }).selectOption("qa-agent");
    assert(agentRequests.at(-1) === "qa-node", "노드 변경 후 에이전트 목록을 갱신하지 않았습니다.");

    const previousIndex = optionLabels.findIndex((label) => label.includes("밀도 기준 정리"));
    assert(previousIndex >= 0, "비직전 predecessor index를 찾지 못했습니다.");
    await predecessor.selectOption(String(previousIndex));
    await capture(page, theme, "01-picker-stable-30s");
    await page.getByRole("button", { name: "시작", exact: true }).click();
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "detached" });
    const createPayload = createPayloads.at(-1);
    assert(createPayload?.predecessor_session_id === "run-alpha-1", "비직전 predecessor가 생성 요청에 전달되지 않았습니다.");
    const extraContextItems = createPayload?.extra_context_items as Array<{
      key?: string;
      content?: { pages?: Array<{ page_id?: string }>; nodes?: Array<{ node_id?: string }> } | string;
    }> | undefined;
    assert(Array.isArray(extraContextItems), "세션별 contextItems가 생성 요청에 없습니다.");
    const pageSources = extraContextItems.find((item) => item.key === "page_context_sources");
    const pageIds = typeof pageSources?.content === "object"
      ? pageSources.content.pages?.map((pageEntry) => pageEntry.page_id)
      : [];
    assert(pageIds?.includes("doc-inline"), "선택한 보드 문서가 page context source에 없습니다.");
    const atomSources = extraContextItems.find((item) => item.key === "atom_context_sources");
    const atomNodeId = typeof atomSources?.content === "object"
      ? atomSources.content.nodes?.[0]?.node_id
      : undefined;
    assert(atomNodeId === "qa-atom-node", "선택한 atom 노드가 context source에 없습니다.");
    assert(extraContextItems.some((item) => (
      item.key === "session_guidance" && item.content === "결과부터 간결하게 보고한다."
    )), "추가 지침이 세션 context에 없습니다.");
    assert(createPayload?.prompt === [
      "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.",
      "선택한 컨텍스트를 세 문장으로 요약하세요.",
    ].join("\n"), "초기 지시가 세션 prompt 정본으로 조립되지 않았습니다.");
    assert(typeof createPayload?.pageAnchor === "object", "선택한 보드 문서용 page anchor가 없습니다.");

    return {
      options: optionLabels.length,
      observedMs: 31_000,
      agentMutations: mutations.agent,
      runMutations: mutations.runs,
      agentRefetchesDuringObservation,
      sessionRequestsDuringObservation: sessionListRequests - sessionRequestsBeforeObservation,
      predecessorRoundtrip: createPayload?.predecessor_session_id,
      contextItemKeys: extraContextItems.map((item) => item.key),
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
    const agent = document.querySelector('select[aria-label="에이전트 선택"]');
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
