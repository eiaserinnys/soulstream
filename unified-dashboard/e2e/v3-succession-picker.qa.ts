import { koreanLocale } from "./korean-locale.mjs";
/**
 * 저장소 루트에서 실행:
 * corepack pnpm -C unified-dashboard build
 * VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm -C unified-dashboard exec vite preview --host 127.0.0.1 --port 4173 --strictPort
 * PLAYWRIGHT_MODULE=$(realpath unified-dashboard/node_modules/@playwright/test/../../playwright/index.mjs) PR_AI_QA_OUTPUT=.local/card1576/after node soul-server-ts/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/v3-succession-picker.qa.ts > .local/card1576-result.json
 * 4173이 사용 중이면 preview 포트와 V3_QA_BASE_URL을 같은 다른 주소로 바꾼다.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

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
  // 기본 관찰 31초를 테마 두 번 돌린다. 180초로는 관찰만으로 상한을 넘긴다.
  timeoutMs: 300_000,
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
    locale: koreanLocale,
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
  // rb-alpha(카드 밀도와 계층 최종 QA) 폴더의 두 run이 이어받을 모델과 지원 안 하는 강도를 갖는다.
  const alphaRuns = ["run-alpha-1", "run-alpha-2"];
  await installV3VisualQaRoutes(page, {
    successionPickerRuns: true,
    onAgentListRequest: (nodeId) => agentRequests.push(nodeId),
    onSessionCreate: (payload) => { createPayloads.push(payload); },
    onSessionListRequest: () => { sessionListRequests += 1; },
    sessionModelPresets: Object.fromEntries(alphaRuns.map((id) => [id, "qa-standard"])),
    sessionReasoningEfforts: Object.fromEntries(alphaRuns.map((id) => [id, "ultra"])),
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
    await page.getByTestId("v3-starred-task-row-task-alpha").waitFor({ state: "visible" });
    await page.getByTestId("v3-starred-task-row-task-alpha").click();
    try {
      await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask }).waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      console.error(`[pr-ai/qa] 폴더 진입 실패 URL · ${page.url()}`);
      console.error(`[pr-ai/qa] 폴더 진입 실패 본문 · ${(await page.locator("body").textContent() ?? "").slice(0, 2_000)}`);
      await capture(page, theme, "diagnostic-task-open-failure");
      throw error;
    }
    await page.locator(".v3-run-row").filter({ hasText: "세션 #1" }).first().waitFor({ state: "visible" });

    // 폴더 공통 컨텍스트 편집기: atom 추가 팝오버가 노드 선택기를 띄우고 상속 표시를 겹쳐 쓰지 않는다.
    const projectContext = page.getByTestId("v3-project-context");
    assert(!(await projectContext.textContent() ?? "").includes("상속됨(프로젝트에서)"), "공통 컨텍스트에 중복 상속 표시가 남았습니다.");
    await projectContext.getByRole("button", { name: "atom 추가", exact: true }).click();
    const sharedPicker = page.locator('[data-slot="popover-popup"]').filter({ hasText: "atom 노드" });
    // 노드 트리가 함께 열리면 바깥 팝오버가 접근성 트리에서 가려지므로 글로 찾는다.
    await sharedPicker.locator("button", { hasText: "노드 선택" }).waitFor({ state: "visible" });
    for (let attempt = 0; attempt < 2 && await sharedPicker.isVisible(); attempt += 1) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await sharedPicker.waitFor({ state: "hidden" });

    // 세션을 만든 뒤에는 세션 히스토리 쪽에도 같은 이름의 단추가 생기므로 폴더 화면의 단추로 좁힌다.
    const openButton = page.getByTestId("v3-planner-scroll").getByRole("button", { name: "새 세션", exact: true });
    await openButton.click();
    const modal = page.locator(".v3-succession-modal");
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "visible" });
    const openedFocus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    // 세션을 만든 뒤에는 채팅 창이 폴더 화면을 덮으므로 Esc 닫기와 초점 측정은 첫 열기에서 한다.
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    const escapeFocusRestored = await openButton.evaluate(element => document.activeElement === element);
    assert(escapeFocusRestored, "Esc로 닫은 뒤 새 세션 단추로 초점이 돌아오지 않았습니다.");
    await openButton.click();
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "visible" });
    await modal.getByRole("button", { name: "취소", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    const cancelFocusRestored = await openButton.evaluate(element => document.activeElement === element);
    assert(cancelFocusRestored, "취소 뒤 새 세션 단추로 초점이 돌아오지 않았습니다.");
    const focusRestored = { escape: escapeFocusRestored, cancel: cancelFocusRestored };
    await openButton.click();
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "visible" });
    for (const title of ["실행 환경", "함께 전달할 자료"]) {
      const disclosure = modal.locator("details").filter({ hasText: title });
      if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
    }
    const effort = modal.getByRole("combobox", { name: "추론 강도 선택" });
    const predecessor = modal.getByRole("combobox", { name: "이어받을 이전 세션" });
    await modal.getByTestId("succession-effort-unsupported").waitFor({ state: "visible" });
    const defaultButton = modal.getByTestId("succession-effort-use-default");
    await effort.focus();
    const unfocusedShadow = await defaultButton.evaluate(element => getComputedStyle(element).boxShadow);
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await effort.scrollIntoViewIfNeeded();
      await capture(page, theme, `unsupported-effort-${width}`);
      await effort.focus();
      await page.keyboard.press("Tab");
      assert(await defaultButton.evaluate(element => document.activeElement === element), "Tab이 기본값 사용 단추로 가지 않았습니다.");
      await capture(page, theme, `default-focus-${width}`);
    }
    const defaultFocusStyle = await defaultButton.evaluate(element => ({
      outlineStyle: getComputedStyle(element).outlineStyle,
      boxShadow: getComputedStyle(element).boxShadow,
      focusVisible: element.matches(":focus-visible"),
    }));
    assert(defaultFocusStyle.focusVisible && defaultFocusStyle.outlineStyle === "none"
      && defaultFocusStyle.boxShadow !== "none" && defaultFocusStyle.boxShadow !== unfocusedShadow,
    `기본값 단추 초점 고리 오류: ${JSON.stringify(defaultFocusStyle)}`);
    await page.keyboard.press("Enter");
    await modal.getByTestId("succession-effort-unsupported").waitFor({ state: "hidden" });
    const defaultFocusTarget = await effort.evaluate(element => document.activeElement === element);
    assert(defaultFocusTarget, "기본값 사용 뒤 추론 강도 칸에 초점이 없습니다.");
    assert(await effort.getAttribute("aria-expanded") === "false", "기본값 사용 뒤 강도 목록이 열렸습니다.");
    const previousCheckbox = modal.getByRole("checkbox", { name: "이전 세션 이어받기" });
    const activeOpacity = await predecessor.evaluate(element => getComputedStyle(element).opacity);
    await previousCheckbox.uncheck();
    const disabledOpacity = await predecessor.evaluate(element => getComputedStyle(element).opacity);
    assert(activeOpacity === "1" && disabledOpacity === "0.64", `선택 칸 투명도 오류: 활성 ${activeOpacity}, 비활성 ${disabledOpacity}`);
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await predecessor.scrollIntoViewIfNeeded();
      await capture(page, theme, `disabled-previous-${width}`);
    }
    await previousCheckbox.check();
    const previousInteractionMetrics = [];
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      previousInteractionMetrics.push(await verifyPreviousInteraction(page, modal));
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
    const optionLabels = await choices.allTextContents();
    assert(optionLabels.some((label) => label.includes("시각 QA 순회")), `displayName 선택지가 없습니다: ${JSON.stringify(optionLabels)}`);
    assert(optionLabels.some((label) => label.includes("밀도 기준 정리")), `비직전 run 선택지가 없습니다: ${JSON.stringify(optionLabels)}`);
    assert(!optionLabels.some((label) => label.includes("run-alpha-")), "이전 세션 선택지에 세션 UUID가 노출됐습니다.");
    const previousLabel = optionLabels.find((label) => label.includes("밀도 기준 정리"))!.trim();
    await choices.filter({ hasText: "밀도 기준 정리" }).click();
    await expectTriggerText(predecessor, previousLabel);
    assert(!(await modal.textContent() ?? "").includes("run-alpha-"), "모달에 세션 UUID가 노출됐습니다.");

    const modalText = await modal.textContent() ?? "";
    for (const required of [
      "실행 환경",
      "함께 전달할 자료",
      "플래너 UX 원칙",
      "대비와 잘림을 실제 픽셀로 확인",
      "보드 문서",
      "PR-O 결정 로그",
      "추가 참고 자료",
      "무엇을 시작할까요?",
      "이전 세션을 이어 받을 경우 세션을 승계한 것으로 간주됩니다.",
    ]) assert(modalText.includes(required), `필수 문구/컨텍스트가 없습니다: ${required}`);
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
    // 사용 불가 모델은 이름 아래 줄에 서버 사유와 로컬 해제 시각을 따로 그린다(괄호 없음).
    const limitedOption = page.locator('[data-slot="select-item"]:visible')
      .filter({ hasText: "QA 제한 모델" });
    await limitedOption.waitFor({ state: "visible" });
    assert(
      await limitedOption.getAttribute("data-disabled") !== null,
      "사용량 제한 모델이 선택 가능 상태입니다.",
    );
    assert(
      (await limitedOption.textContent() ?? "").includes("주간 사용량 제한 · 18:20 해제"),
      "서버 사유 라벨과 로컬 해제 시각이 표시되지 않았습니다.",
    );
    await page.locator('[data-slot="select-item"]:visible')
      .filter({ hasText: "QA 사용량 확인 모델 (사용량 확인 지연)" })
      .click();
    await modal.getByText("사용량 확인 지연", { exact: true }).waitFor({ state: "visible" });

    await modal.getByRole("checkbox", { name: "PR-O 결정 로그" }).check();
    // 버튼이 「추가 참고 자료」 label 안에 있어 접근 이름은 label 글이다.
    await modal.getByRole("button", { name: "추가 참고 자료", exact: true }).filter({ hasText: "atom에서 추가" }).click();
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
    // 옵션에는 사용량 경고 접미사가 붙고 트리거에는 모델 이름만 보인다.
    await chooseSelectItem(page, modelPreset, "QA 사용량 확인 모델 (사용량 확인 지연)", "QA 사용량 확인 모델");


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
    await capture(page, theme, "01-picker-stable-30s");
    await modal.getByRole("button", { name: "세션 시작", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    const createPayload = createPayloads.at(-1);
    assert(createPayload?.predecessor_session_id === "run-alpha-1", `비직전 predecessor가 생성 요청에 전달되지 않았습니다: ${JSON.stringify(createPayload)}`);
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

    return {
      previousInteractionMetrics,
      options: optionLabels.length,
      optionLabels,
      observedMs: observationMs,
      agentMutations: mutations.agent,
      runMutations: mutations.runs,
      agentRefetchesDuringObservation,
      sessionRequestsDuringObservation: sessionListRequests - sessionRequestsBeforeObservation,
      predecessorRoundtrip: createPayload?.predecessor_session_id,
      reasoningEffortRoundtrip: createPayload?.reasoningEffort,
      contextItemKeys: extraContextItems.map((item) => item.key),
      nodeChangeAgentRefresh: agentRequests.at(-1),
      modelPresetRoundtrip: createPayload?.model_preset,
      assignmentControlHeights: assignmentMetrics.map((metric) => metric.height),
      assignmentLabelTops: assignmentMetrics.map((metric) => metric.labelTop),
      openedFocus,
      tabInside,
      focusRestored,
      defaultFocusStyle,
      defaultFocusTarget,
      activeOpacity,
      disabledOpacity,
      resize,
    };
  } finally {
    await context.close();
  }
}

/** Regression for the title/guidance checkbox target reported in visual review. */
async function verifyPreviousInteraction(page: Page, modal: Locator) {
  const row = modal.locator(".v3-succession-previous");
  const checkbox = row.getByRole("checkbox", { name: "이전 세션 이어받기" });
  const title = row.getByText("이전 세션", { exact: true }).filter({ visible: true });
  const trigger = row.getByRole("combobox", { name: "이어받을 이전 세션", exact: true });
  assert(await checkbox.isChecked(), "이전 세션 이어받기가 처음부터 꺼져 있습니다.");
  assert(await title.count() === 1, "이전 세션 제목이 한 번만 보여야 합니다.");
  await title.scrollIntoViewIfNeeded();
  const box = await title.boundingBox();
  assert(box, "이전 세션 제목의 누름 좌표가 없습니다.");
  const clickTitle = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await clickTitle();
  assert(!await checkbox.isChecked(), "제목을 눌러도 체크가 꺼지지 않았습니다.");
  assert(await page.locator('[data-slot="select-popup"]:visible').count() === 0, "제목 누름으로 선택 목록이 열렸습니다.");
  assert(await trigger.isDisabled(), "체크를 끈 뒤 선택 칸이 활성 상태입니다.");
  await clickTitle();
  assert(await checkbox.isChecked(), "같은 제목 좌표를 다시 눌러도 체크가 켜지지 않았습니다.");
  const guidance = row.locator("small");
  await guidance.click();
  assert(!await checkbox.isChecked(), "안내를 눌러도 체크가 꺼지지 않았습니다.");
  await guidance.click();
  assert(await checkbox.isChecked(), "안내를 다시 눌러도 체크가 켜지지 않았습니다.");
  assert(await page.locator('[data-slot="select-popup"]:visible').count() === 0, "안내 누름으로 선택 목록이 열렸습니다.");
  const metrics = await row.evaluate(element => {
    const label = element.querySelector('input[type="checkbox"]')?.closest("label");
    const inactive = [element, ...element.querySelectorAll("*")].filter(child =>
      child.getClientRects().length > 0 && !label?.contains(child)
      && !child.closest('[data-slot="select-trigger"]'));
    return {
      width: window.innerWidth,
      labelHeight: label?.getBoundingClientRect().height ?? 0,
      inactiveCursors: inactive.map(child => ({ tag: child.tagName, cursor: getComputedStyle(child).cursor })),
    };
  });
  assert(metrics.labelHeight >= 24, `체크 누름 영역이 작습니다: ${JSON.stringify(metrics)}`);
  assert(metrics.inactiveCursors.every(item => item.cursor !== "pointer"), `반응 없는 곳에 손가락 커서가 있습니다: ${JSON.stringify(metrics)}`);
  assert(!await trigger.isDisabled(), "체크를 켠 뒤 선택 칸이 비활성 상태입니다.");
  return metrics;
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
  return await Promise.all(controls.map(async (control) => await control.evaluate(async (element) => {
    // 선택 목록이 닫히며 초점이 빠진 트리거는 그림자 전환이 끝난 뒤에 잰다.
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
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

async function chooseSelectItem(page: Page, trigger: Locator, text: string, triggerText = text) {
  await trigger.click();
  const item = page.locator('[data-slot="select-item"]:visible').filter({ hasText: text });
  await item.waitFor({ state: "visible" });
  await item.click();
  await expectTriggerText(trigger, triggerText);
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
