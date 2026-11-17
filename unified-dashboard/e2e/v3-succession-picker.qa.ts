import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AI_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-succession-picker"),
);
const requestedTheme = process.env.PR_AI_QA_THEME === "dark"
  || process.env.PR_AI_QA_THEME === "light"
  ? process.env.PR_AI_QA_THEME
  : null;
const observationMs = Number(process.env.V3_QA_OBSERVE_MS ?? 31_000);
const result = await runPlaywrightLifecycle({
  lockName: "pr-ai-v3-succession-picker",
  timeoutMs: 180_000,
}, async ({ browser }) => requestedTheme
  ? { [requestedTheme]: await verifyTheme(browser, requestedTheme) }
  : {
      dark: await verifyTheme(browser, "dark"),
      light: await verifyTheme(browser, "light"),
    });

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  // Keep the fixture reset date on the same day; timers still run normally.
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
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
    onSessionListRequest: () => { sessionListRequests += 1; },
    unifiedFolderView: true,
    taskAssignmentModelPreset: "qa-standard",
    sessionModelPresets: { "run-outside-task": "qa-standard", "folder-history-1": "qa-standard" },
    sessionReasoningEfforts: { "run-outside-task": "ultra", "folder-history-1": "ultra" },
    onSessionCreate: (payload) => { createPayloads.push(payload); },
  });
  await page.route("**/api/nodes/*/model-presets", (route) => route.fulfill({ json: {
    model_presets: [
      { id: "qa-standard", label: "QA 표준 모델", backend: "codex", available: true, supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
      { id: "qa-warning", label: "QA 사용량 확인 모델", backend: "codex", available: true, usage_warning: true, supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
      { id: "qa-limited", label: "QA 제한 모델", backend: "codex", available: false, reason: "quota_exhausted", reason_label: "주간 사용량 제한", resets_at: "2026-07-28T18:20:00+09:00" },
    ],
  } }));
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
    await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
    await page.locator('.v3-run-row[data-session-id="run-outside-task"]').waitFor({ state: "visible" });
    const openButton = page.getByRole("button", { name: "새 세션", exact: true });
    await openButton.click();
    const modal = page.locator(".v3-succession-modal");
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "visible" });
    const openedFocus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    for (const title of ["실행 환경", "함께 전달할 자료"]) {
      const disclosure = modal.locator("details").filter({ hasText: title });
      if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
    }
    const effort = modal.getByRole("combobox", { name: "추론 강도 선택" });
    const predecessor = modal.getByRole("combobox", { name: "이어받을 이전 세션" });
    await modal.getByTestId("succession-effort-unsupported").waitFor({ state: "visible" });
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await effort.scrollIntoViewIfNeeded();
      await capture(page, theme, `unsupported-effort-${width}`);
    }
    await modal.getByTestId("succession-effort-use-default").click();
    await modal.getByTestId("succession-effort-unsupported").waitFor({ state: "hidden" });
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await modal.locator('[data-slot="dialog-panel-scroll"]').evaluate(element => { element.scrollTop = 0; });
      await capture(page, theme, `succession-${width}`);
      await predecessor.scrollIntoViewIfNeeded();
      await capture(page, theme, `succession-previous-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await chooseSelectItem(page, effort, "High");
    assert((await effort.textContent() ?? "").includes("High"), "추론 강도가 바뀌지 않았습니다.");
    await predecessor.click();
    const choices = page.locator('[data-slot="select-item"]:visible');
    await choices.first().waitFor({ state: "visible" });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="select-item"]')]
      .filter(element => element.getClientRects().length > 0).length > 1);
    const choiceLabels = await choices.allTextContents();
    assert(choiceLabels.length > 1, "이전 세션 선택지가 부족합니다.");
    const selectedLabel = choiceLabels.find(label => label.includes("폴더 세션 1 ·"));
    assert(selectedLabel, `폴더 세션 1 선택지가 없습니다: ${JSON.stringify(choiceLabels)}`);
    await choices.filter({ hasText: "폴더 세션 1 ·" }).click();
    assert((await predecessor.textContent() ?? "").includes(selectedLabel.trim()), "이전 세션 선택이 반영되지 않았습니다.");

    const modalText = await modal.textContent() ?? "";
    for (const forbidden of [
      "승계 미리보기",
      "체크를 모두 끄면 빈 세션으로 시작합니다.",
      "목표·완료 조건·현재 결정",
      "컨텍스트 슬롯",
      "카드 본문에 포함",
      "승계 링크로 기록됨",
    ]) assert(!modalText.includes(forbidden), `삭제 대상 문구가 남았습니다: ${forbidden}`);
    assert(!modalText.includes("추가 지침"), "삭제한 추가 지침 입력이 새 세션 창에 남았습니다.");


    const modelPreset = modal.getByRole("combobox", { name: "모델", exact: true });
    await modelPreset.click();
    const limitedOption = page.locator('[data-slot="select-item"]')
      .filter({ hasText: "QA 제한 모델 (주간 사용량 제한) · 18:20 해제" });
    await limitedOption.waitFor({ state: "visible" });
    assert(
      await limitedOption.getAttribute("data-disabled") !== null,
      "사용량 제한 모델이 선택 가능 상태입니다.",
    );
    assert(
      (await limitedOption.textContent() ?? "").includes("QA 제한 모델 (주간 사용량 제한) · 18:20 해제"),
      "서버 사유 라벨과 로컬 해제 시각이 표시되지 않았습니다.",
    );
    await page.locator('[data-slot="select-item"]')
      .filter({ hasText: "QA 사용량 확인 모델 (사용량 확인 지연)" })
      .click();
    await modal.getByText("사용량 확인 지연", { exact: true }).waitFor({ state: "visible" });

    await modal.getByRole("checkbox", { name: "PR-O 결정 로그" }).check();
    await modal.getByRole("button", { name: "atom에서 추가", exact: true }).click();
    await page.getByRole("button", { name: "QA atom 컨텍스트", exact: true }).click();
    await modal.getByRole("button", { name: "자료 추가", exact: true }).click();
    await expectTriggerText(page.getByRole("combobox", { name: "에이전트 선택" }), "로젤린");
    await installMutationCounters(page);
    const agentRequestsBeforeObservation = agentRequests.length;
    const sessionRequestsBeforeObservation = sessionListRequests;
    await page.waitForTimeout(observationMs);
    const mutations = await readMutationCounters(page);
    const agentRefetchesDuringObservation = agentRequests.length - agentRequestsBeforeObservation;
    assert(mutations.agent === 0, `에이전트 콤보 DOM 변이 ${mutations.agent}회`);
    assert(mutations.runs === 0, `배경 run 목록 DOM 변이 ${mutations.runs}회`);
    assert(agentRefetchesDuringObservation === 0, `에이전트 목록 재조회 ${agentRefetchesDuringObservation}회`);

    await chooseSelectItem(page, page.getByRole("combobox", { name: "노드 선택" }), "qa-node");
    await chooseSelectItem(page, page.getByRole("combobox", { name: "에이전트 선택" }), "QA 에이전트");
    assert(agentRequests.at(-1) === "qa-node", "노드 변경 후 에이전트 목록을 갱신하지 않았습니다.");
    await expectTriggerText(modelPreset, "미지정");
    await chooseSelectItem(page, modelPreset, "QA 사용량 확인 모델 (사용량 확인 지연)");


    await chooseSelectItem(page, effort, "High");
    const instruction = modal.getByRole("textbox", { name: "초기 지시" });
    await instruction.fill("선택한 자료를 검토합니다.");
    await instruction.focus();
    const assignmentMetrics = await measureControls([
      modal.getByRole("combobox", { name: "노드 선택" }),
      modal.getByRole("combobox", { name: "에이전트 선택" }),
      modal.getByRole("combobox", { name: "모델", exact: true }), effort, predecessor,
    ]);
    assertAlignedControls(assignmentMetrics, "노드·에이전트·모델·추론 강도·이전 세션");
    assertAlignedLabels(assignmentMetrics.slice(0, 3), "노드·에이전트·모델");
    const resize: Array<{ width: number; scrollWidth: number; clientWidth: number; value: string }> = [];
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await modal.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
      resize.push({ width, ...dimensions, value: await instruction.inputValue() });
    }
    assert(resize.every(item => item.scrollWidth <= item.clientWidth + 1 && item.value === "선택한 자료를 검토합니다."), `크기 변경 오류: ${JSON.stringify(resize)}`);
    await effort.focus();
    await page.keyboard.press("Tab");
    const tabInside = await modal.evaluate(element => element.contains(document.activeElement));
    assert(tabInside, "Tab 초점이 창 밖으로 이동했습니다.");
    await modal.locator(".v3-succession-footer button:last-child").click();
    await modal.waitFor({ state: "hidden" });
    const createPayload = createPayloads.at(-1);
    assert(createPayload?.predecessor_session_id === "folder-history-1", `이전 세션 요청이 다릅니다: ${JSON.stringify(createPayload)}`);
    assert(createPayload?.reasoningEffort === "high", "추론 강도가 생성 요청에 반영되지 않았습니다.");

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
    assert(!extraContextItems.some((item) => item.key === "session_guidance"), "삭제한 추가 지침 context가 생성 요청에 남았습니다.");
    assert(
      createPayload?.initial_instruction === "선택한 자료를 검토합니다.",
      "초기 지시가 initial_instruction으로 전달되지 않았습니다.",
    );
    assert(!Object.prototype.hasOwnProperty.call(createPayload, "prompt"), "클라이언트가 서버 prompt 정본을 우회했습니다.");
    assert(typeof createPayload?.pageAnchor === "object", "선택한 보드 문서용 page anchor가 없습니다.");
    assert(createPayload?.model_preset === "qa-warning", "선택한 모델 프리셋이 생성 요청에 없습니다.");


    await openButton.click();
    await modal.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    const immediateFocus = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300));
    console.log(`승계 닫기 직후 초점: ${immediateFocus}`);
    await modal.waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    const closedFocus = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300));
    console.log(`승계 닫힘 뒤 초점: ${closedFocus}`);
    const focusRestored = await openButton.evaluate(element => document.activeElement === element);
    console.log(`승계 닫힘 초점 복귀 측정: ${focusRestored}`);
    return { observedMs: observationMs, mutations, agentRefetchesDuringObservation, sessionRequestsDuringObservation: sessionListRequests - sessionRequestsBeforeObservation, contextItemKeys: extraContextItems.map(item => item.key), openedFocus, tabInside, focusRestored, choiceLabels, resize, assignmentMetrics };
  } finally {
    await context.close();
  }
}

interface ControlMetric {
  name: string;
  height: number;
  boxShadow: string;
  labelTop: number | null;
  ariaInvalid: string | null;
  disabled: boolean;
  pressed: boolean;
  focused: boolean;
  focusVisible: boolean;
  className: string;
}

async function measureControls(controls: Locator[]): Promise<ControlMetric[]> {
  return await Promise.all(controls.map(async (control) => await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const field = element.closest(".v3-assignment-field, .v3-model-preset-field");
    const label = field?.querySelector("label");
    return {
      name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "unnamed",
      height: rect.height,
      boxShadow: getComputedStyle(element).boxShadow,
      labelTop: label?.getBoundingClientRect().top ?? null,
      ariaInvalid: element.getAttribute("aria-invalid"),
      disabled: element.hasAttribute("data-disabled"),
      pressed: element.hasAttribute("data-pressed"),
      focused: element === document.activeElement,
      focusVisible: element.matches(":focus-visible"),
      className: element.className,
    };
  })));
}

function assertAlignedControls(metrics: ControlMetric[], label: string) {
  const heights = metrics.map((metric) => metric.height);
  assert(
    Math.max(...heights) - Math.min(...heights) <= 1,
    `${label} 높이가 어긋났습니다: ${heights.join(", ")}`,
  );
  const shadows = new Set(metrics.map((metric) => metric.boxShadow));
  assert(
    shadows.size === 1,
    `${label} 그림자가 어긋났습니다: ${metrics.map((metric) =>
      `${metric.name}=${metric.boxShadow} invalid:${metric.ariaInvalid} disabled:${metric.disabled} pressed:${metric.pressed} focused:${metric.focused} focusVisible:${metric.focusVisible} class:${metric.className}`
    ).join(" / ")}`,
  );
}

function assertAlignedLabels(metrics: ControlMetric[], label: string) {
  const labelTops = metrics
    .map((metric) => metric.labelTop)
    .filter((top): top is number => top !== null);
  assert(
    labelTops.length === metrics.length
      && Math.max(...labelTops) - Math.min(...labelTops) <= 1,
    `${label} 라벨이 어긋났습니다: ${labelTops.join(", ")}`,
  );
}

async function chooseSelectItem(page: Page, trigger: Locator, text: string) {
  await trigger.click();
  const item = page.locator('[data-slot="select-item"]').filter({ hasText: text });
  await item.waitFor({ state: "visible" });
  await item.click();
  await expectTriggerText(trigger, text);
}

async function expectTriggerText(
  trigger: Locator,
  expected: string,
) {
  await trigger.filter({ hasText: expected }).waitFor({ state: "visible" });
}

async function installMutationCounters(page: Page) {
  await page.evaluate(() => {
    const state = { agent: 0, runs: 0 };
    (window as Window & { __prAiMutationCounts?: typeof state }).__prAiMutationCounts = state;
    const agent = document.querySelector('[data-slot="select-trigger"][aria-label="에이전트 선택"]');
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
