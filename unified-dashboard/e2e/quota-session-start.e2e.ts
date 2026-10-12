// Kept as one suite beyond 500 lines: the U3 specification requires the existing and new quota contracts in this file.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/20261012-limit-rejected-display-308-fix4");
mkdirSync(output, { recursive: true });
const rejectedTodayResetAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const preset = { id: "codex-6.1-sol", label: "Codex - 6.1 Sol", backend: "codex",
  available: true, reason: "quota_exhausted", reason_label: "7일 사용량 제한",
  resets_at: "2030-01-02T03:04:00.000Z", usage_warning: false };
const rejectedPreset = { id: "claude-opus-rejected", label: "Claude - Opus", backend: "claude",
  available: false, reason: "limit_rejected", reason_label: "5시간 한도 거부 중",
  resets_at: rejectedTodayResetAt, usage_warning: false };
const weeklyRejectedPreset = { id: "claude-fable-rejected", label: "Claude - Fable", backend: "claude",
  available: false, reason: "limit_rejected", reason_label: "7일 한도 거부 중",
  resets_at: "2030-01-02T03:04:00.000Z", usage_warning: false };
const normalPreset = { id: "codex-5.6-sol", label: "Codex - 5.6 Sol", backend: "codex",
  available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false };
const unavailablePreset = { id: "codex-6-astra-unavailable", label: "Codex - 6 Astra", backend: "codex",
  available: false, reason: "not_authenticated", reason_label: "미인증", resets_at: null, usage_warning: false };

for (const width of [1440, 390]) for (const explicit of [true, false]) {
  test(`zero quota selection and submission ${width} explicit=${explicit}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => {
      localStorage.setItem("soul-dashboard-theme", "dark");
      localStorage.setItem("ls.webglGlass", "0");
    });
    const payloads: Record<string, unknown>[] = [];
    await installV3VisualQaRoutes(page, { unifiedFolderView: true, successionPickerRuns: true,
      onSessionCreate: payload => payloads.push(payload) });
    await page.route("**/api/nodes/*/agents", route => route.fulfill({ json: {
      agents: [{ id: "roselin_codex", name: "로젤린", backend: "codex",
        default_preset: preset.id, portraitUrl: null }] } }));
    await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: {
      model_presets: [preset, rejectedPreset, weeklyRejectedPreset, normalPreset, unavailablePreset] } }));
    await page.goto("/");
    await expect(page.locator(".v3-shell[data-mobile-tab]")).toBeVisible({ timeout: 30_000 });
    if (width < 760) {
      await page.getByTestId("v3-mobile-tab-projects").click();
      const project = page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true });
      await expect(project).toBeVisible();
      await project.click();
    } else {
      const project = page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true });
      await expect(project).toBeVisible();
      await project.click();
    }
    await page.getByRole("button", { name: "새 세션", exact: true }).press("Enter");
    const modal = page.locator(".v3-succession-modal");
    await expect(modal).toBeVisible();
    const environment = modal.locator("details").filter({ has: page.locator("summary strong").filter({ hasText: "실행 환경" }) });
    if (await environment.getAttribute("open") === null) await environment.locator("summary").click();
    const model = modal.getByRole("combobox", { name: "모델", exact: true });
    await expect(model).toContainText(preset.label);
    const before = await model.boundingBox();
    await model.click();
    const exhausted = page.locator('[data-slot="select-item"]').filter({ hasText: preset.label });
    await expect(exhausted).not.toHaveAttribute("data-disabled");
    const rejected = page.locator('[data-slot="select-item"]').filter({ hasText: rejectedPreset.label });
    await expect(rejected).toHaveAttribute("data-disabled");
    await expect(rejected).toContainText(rejectedPreset.reason_label);
    await expect(rejected).toContainText(/\d{2}:\d{2} 해제/);
    const weeklyRejected = page.locator('[data-slot="select-item"]').filter({ hasText: weeklyRejectedPreset.label });
    await expect(weeklyRejected).toHaveAttribute("data-disabled");
    await expect(weeklyRejected).toContainText(weeklyRejectedPreset.reason_label);
    await expect(weeklyRejected).toContainText(/\d{1,2}\/\d{1,2} \d{2}:\d{2} 해제/);
    await expect(weeklyRejected.getByText(weeklyRejectedPreset.label, { exact: true })).toBeVisible();
    await expect(weeklyRejected.getByText(/7일 한도 거부 중 · \d{1,2}\/\d{1,2} \d{2}:\d{2} 해제/)).toBeVisible();
    await expect(weeklyRejected.locator(".break-keep")).toHaveCSS("word-break", "keep-all");
    if (width === 390) {
      const positioner = page.locator('[data-slot="select-positioner"]:visible').last();
      await expect(positioner).toBeVisible();
      const bounds = await positioner.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(5);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(385);
    }
    await expect(page.locator('[data-slot="select-item"]').filter({ hasText: normalPreset.label }))
      .not.toHaveAttribute("data-disabled");
    await expect(page.locator('[data-slot="select-item"]').filter({ hasText: unavailablePreset.label }))
      .toHaveAttribute("data-disabled");
    const name = exhausted.getByText(preset.label, { exact: true });
    const dangerColor = await name.evaluate(el => getComputedStyle(el).color);
    expect(dangerColor).not.toBe(await exhausted.evaluate(el => getComputedStyle(el).color));
    if (explicit) {
      await page.screenshot({ path: path.join(output, `web-options-${width}.png`), animations: "disabled" });
      const modelList = page.locator('[role="listbox"]:visible').last();
      await expect(modelList).toBeVisible();
      await modelList.screenshot({ path: path.join(output, `web-new-session-model-list-${width}.png`), animations: "disabled" });
      if (width === 1440) {
        await rejected.screenshot({ path: path.join(output, "web-rejected-row-zoom-1440.png"), animations: "disabled" });
      }
      await page.keyboard.press("Escape");
      const agent = modal.getByRole("combobox", { name: "에이전트 선택", exact: true });
      await agent.click();
      const agentPositioner = page.locator('[data-slot="select-positioner"]:visible').last();
      await expect(agentPositioner).toBeVisible();
      const agentLayout = await agentPositioner.evaluate(element => {
        const rect = () => {
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right };
        };
        const withWidthLimit = rect();
        element.classList.remove("max-w-(--available-width)");
        void element.getBoundingClientRect();
        const withoutWidthLimit = rect();
        element.classList.add("max-w-(--available-width)");
        void element.getBoundingClientRect();
        return { withWidthLimit, withoutWidthLimit, restored: rect() };
      });
      expect(agentLayout.withWidthLimit).toEqual(agentLayout.withoutWidthLimit);
      expect(agentLayout.restored).toEqual(agentLayout.withWidthLimit);
      writeFileSync(path.join(output, `web-agent-select-${width}.json`), JSON.stringify(agentLayout, null, 2));
      await page.screenshot({ path: path.join(output, `web-agent-list-${width}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await model.click();
    }
    await page.screenshot({ path: path.join(output, `options-${width}-${explicit}.png`), animations: "disabled" });
    if (explicit) await exhausted.click(); else await page.keyboard.press("Escape");
    await expect(model).toContainText(preset.label);
    await expect(model.getByText(preset.label, { exact: true })).toHaveCSS("color", dangerColor);
    await expect(model).not.toHaveAttribute("aria-invalid", "true");
    expect(await model.boundingBox()).toEqual(before);
    await modal.getByRole("textbox", { name: "초기 지시" }).fill("사용량 0%에서도 크레딧으로 시작");
    const start = modal.getByRole("button", { name: "세션 시작", exact: true });
    await expect(start).toBeEnabled();
    await page.screenshot({ path: path.join(output, `selected-${width}-${explicit}.png`), animations: "disabled" });
    await start.click();
    await expect(modal).toBeHidden();
    expect(payloads.at(-1)).toMatchObject({ model_preset: preset.id });
    writeFileSync(path.join(output, `submission-${width}-${explicit}.json`),
      JSON.stringify({ viewport: width, explicit, dangerColor, before, after: before, payload: payloads.at(-1) }, null, 2));
  });
}

test("app production execution picker rendered through React Native Web", async ({ page }) => {
  const bundle = path.resolve("dist/assets/ios-components");
  test.skip(!existsSync(path.join(bundle, "index.html")), "Run soul-app export:components for the native component preview.");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true } }));
  await page.route("**/assets/ios-components/**", route => {
    const asset = new URL(route.request().url()).pathname.replace("/assets/ios-components/", "");
    return route.fulfill({ path: path.join(bundle, asset) });
  });
  await page.goto("/assets/ios-components/index.html?section=dialogues&sample=execution-picker&theme=dark");
  const model = page.getByTestId("execution-model-public-exhausted-model");
  await expect(model).toBeEnabled();
  const rejected = page.getByTestId("execution-model-public-rejected-model");
  await expect(rejected).toBeDisabled();
  await expect(rejected).toContainText("5시간 한도 거부 중");
  await expect(rejected).toContainText(/\d{2}:\d{2} 해제/);
  const weeklyRejected = page.getByTestId("execution-model-public-rejected-weekly-model");
  await expect(weeklyRejected).toBeDisabled();
  await expect(weeklyRejected).toContainText(/7일 한도 거부 중.*\d{1,2}\/\d{1,2} \d{2}:\d{2} 해제/);
  const name = model.getByText("사용량 소진 예시 모델", { exact: true });
  const color = await name.evaluate(el => getComputedStyle(el).color);
  expect(color).not.toBe(await page.getByText("사용 가능한 예시 모델", { exact: true }).evaluate(el => getComputedStyle(el).color));

  const capturePicker = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.getByTestId("execution-model-public-rejected-model")
      .evaluate(element => element.getBoundingClientRect().height)).toBe(width === 390 ? 64 : 68);
    const metrics = await page.evaluate(() => {
      const rect = (element: Element | null) => {
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return { x: +value.x.toFixed(1), y: +value.y.toFixed(1), width: +value.width.toFixed(1), height: +value.height.toFixed(1), bottom: +value.bottom.toFixed(1) };
      };
      const sectionMetrics = (sectionId: string, prefix: string) => {
        const section = document.querySelector(`[data-testid="${sectionId}"]`);
        const rows = [...(section?.querySelectorAll(`[data-testid^="execution-${prefix}-"]`) ?? [])]
          .filter(row => !row.getAttribute("data-testid")?.endsWith("-visual"));
        return {
          section: rect(section),
          rows: rows.map(row => {
            const visual = row.querySelector('[data-testid$="-visual"]');
            const textBoxes = [...row.querySelectorAll('div[dir="auto"]')];
            return {
              id: row.getAttribute("data-testid"),
              frame: rect(row),
              surface: rect(visual),
              surfaceStyle: visual ? {
                minHeight: getComputedStyle(visual).minHeight,
                height: getComputedStyle(visual).height,
                paddingTop: getComputedStyle(visual).paddingTop,
                paddingBottom: getComputedStyle(visual).paddingBottom,
                gap: getComputedStyle(visual).gap,
              } : null,
              texts: textBoxes.map(element => ({
                text: element.textContent,
                ...rect(element),
                fontSize: getComputedStyle(element).fontSize,
                lineHeight: getComputedStyle(element).lineHeight,
              })),
            };
          }),
          dividers: [...(section?.querySelectorAll('[data-testid="grouped-glass-divider"]') ?? [])].map(rect),
        };
      };
      return {
        viewport: window.innerWidth,
        agents: sectionMetrics("execution-agents", "agent"),
        nodes: sectionMetrics("execution-nodes", "node"),
        models: sectionMetrics("execution-models", "model"),
      };
    });
    await page.screenshot({ path: path.join(output, `execution-picker-${width}.png`) });
    await page.getByTestId("execution-models").screenshot({ path: path.join(output, `execution-models-${width}.png`) });
    writeFileSync(path.join(output, `execution-picker-metrics-${width}.json`), JSON.stringify(metrics, null, 2));
  };
  await capturePicker(390);
  await capturePicker(820);
  await capturePicker(390);

  const surface = page.getByTestId("execution-model-public-exhausted-model-visual");
  const unselectedColor = await surface.evaluate(el => getComputedStyle(el).backgroundColor);
  await model.click();
  await expect.poll(() => surface.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(unselectedColor);
  const confirm = page.getByRole("button", { name: "실행 대상 확인", exact: true });
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: path.join(output, "app-rnweb-selected-390.png") });
  await confirm.click();
  await expect(page.getByTestId("review-dialogue-result")).toContainText("메모리 실행:");

  await page.goto("/assets/ios-components/index.html?section=pasSettings&safeArea=fixture&theme=dark");
  const accountModelTab = page.getByText("계정과 모델", { exact: true }).first();
  await expect(accountModelTab).toBeVisible({ timeout: 30_000 });
  await accountModelTab.click();
  await expect(page.getByText("거부 중 예시 모델", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, "persistent-settings-account-model-390.png") });

  await page.goto("/assets/ios-components/index.html?section=dialogues&sample=settings-target&theme=dark");
  await expect(page.getByText("public-node-1", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(output, "settings-target-390.png") });
});

test("main handoff keeps the exhausted model selected and submits it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({
      folderId: "folder-amber", nodeId: "eiaserinnys", agentId: "roselin_codex", modelPreset: "",
    }));
  });
  const payloads: Record<string, unknown>[] = [];
  await installV3VisualQaRoutes(page, { unifiedFolderView: true,
    onSessionCreate: payload => payloads.push(payload) });
  await page.route("**/api/nodes/*/agents", route => route.fulfill({ json: { agents: [{
    id: "roselin_codex", name: "로젤린", backend: "codex", default_preset: preset.id, portraitUrl: null,
  }] } }));
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: {
    model_presets: [preset, rejectedPreset, weeklyRejectedPreset, normalPreset, unavailablePreset],
  } }));
  await page.goto("/");
  const composer = page.locator(".v3-card-handoff");
  const execution = composer.getByRole("button", { name: "실행 조합 선택", exact: true });
  await expect(composer).toBeVisible();
  await expect(execution).toBeVisible();
  await execution.click();
  const rejected = page.locator(".v3-card-execution-picker").getByRole("button").filter({ hasText: rejectedPreset.label });
  await expect(rejected).toBeDisabled();
  await expect(rejected).toContainText("5시간 한도 거부 중");
  await expect(rejected).toContainText(/\d{2}:\d{2} 해제/);
  await expect(rejected).not.toHaveAttribute("title");
  const option = page.locator(".v3-card-execution-picker").getByRole("button", { name: preset.label, exact: true });
  await expect(option).toBeEnabled();
  await option.click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: path.join(output, "main-handoff-execution-picker-1440.png") });
  await page.locator(".v3-card-execution-picker").getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.locator(".v3-card-execution-picker")).toBeHidden();
  await expect(composer.getByText(preset.label, { exact: true })).toHaveClass("text-destructive");
  await composer.getByRole("textbox", { name: "세션 첫 메시지" }).fill("소진 모델을 선택해 시작");
  await expect(composer.getByRole("button", { name: "세션 시작", exact: true })).toBeEnabled();
  await expect(composer.getByRole("button", { name: "실행 조합 선택", exact: true })).toContainText("로젤린");
  await expect(composer.getByText(preset.label, { exact: true })).toHaveClass("text-destructive");
  await page.screenshot({ path: path.join(output, "main-selected-1440.png") });
  await composer.getByRole("button", { name: "세션 시작", exact: true }).click();
  await expect.poll(() => payloads.length).toBe(1);
  expect(payloads[0]).toMatchObject({ model_preset: preset.id });
  writeFileSync(path.join(output, "main-submission.json"), JSON.stringify(payloads[0], null, 2));
});

test("main execution picker applies a draft only on confirm and discards it on dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({
      folderId: "folder-amber", nodeId: "eiaserinnys", agentId: "roselin_codex", modelPreset: "codex-6.1-sol",
    }));
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  await page.route("**/api/nodes/*/agents", route => route.fulfill({ json: { agents: [{
    id: "roselin_codex", name: "로젤린", backend: "codex", default_preset: preset.id, portraitUrl: null,
  }] } }));
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: {
    model_presets: [preset, rejectedPreset, weeklyRejectedPreset, normalPreset, unavailablePreset],
  } }));
  await page.goto("/");
  await expect(page.locator(".v3-shell[data-mobile-tab]")).toBeVisible({ timeout: 30_000 });
  const composer = page.locator(".v3-card-handoff");
  const execution = composer.getByRole("button", { name: "실행 조합 선택", exact: true });
  const picker = page.locator(".v3-card-execution-picker");
  await execution.click();
  const normal = picker.getByRole("button").filter({ hasText: normalPreset.label });
  await normal.click();
  await expect(normal).toHaveAttribute("aria-pressed", "true");
  await expect(execution).toContainText(preset.label);
  await expect(execution).not.toContainText(normalPreset.label);
  await page.screenshot({ path: path.join(output, "main-execution-picker-1440.png"), animations: "disabled" });
  const pickerMetrics = await picker.evaluate(element => {
    const rect = (target: Element | null) => {
      if (!target) return null;
      const box = target.getBoundingClientRect();
      return { x: +box.x.toFixed(1), y: +box.y.toFixed(1), width: +box.width.toFixed(1), height: +box.height.toFixed(1), bottom: +box.bottom.toFixed(1) };
    };
    const columns = element.querySelector(".v3-card-execution-columns");
    const actions = element.querySelector(".v3-card-execution-actions");
    const oneLine = element.querySelector('section[aria-label="모델"] > button:not(.v3-card-execution-option--reason)');
    const twoLine = element.querySelector('section[aria-label="모델"] > button.v3-card-execution-option--reason');
    const actionStyle = actions ? getComputedStyle(actions) : null;
    return {
      picker: rect(element),
      columns: rect(columns),
      columnWidths: [...(columns?.querySelectorAll("section") ?? [])].map(section => +section.getBoundingClientRect().width.toFixed(1)),
      oneLineModelRow: rect(oneLine),
      twoLineModelRow: rect(twoLine),
      actions: {
        box: rect(actions),
        marginTop: actionStyle?.marginTop,
        paddingTop: actionStyle?.paddingTop,
        borderTopWidth: actionStyle?.borderTopWidth,
        buttonHeight: actions ? rect(actions.querySelector("button"))?.height : null,
        totalHeightWithMargin: actions ? +(actions.getBoundingClientRect().height + parseFloat(actionStyle!.marginTop)).toFixed(1) : null,
      },
    };
  });
  expect(pickerMetrics.picker?.width).toBe(584);
  expect(pickerMetrics.oneLineModelRow?.height).toBe(32);
  expect(pickerMetrics.twoLineModelRow?.height).toBe(50);
  writeFileSync(path.join(output, "main-picker-metrics-1440.json"), JSON.stringify(pickerMetrics, null, 2));
  await picker.getByRole("button", { name: "확인", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(execution).toContainText(normalPreset.label);
  await expect(execution).toBeFocused();

  await execution.click();
  await picker.getByRole("button").filter({ hasText: preset.label }).click();
  await picker.getByRole("button", { name: "취소", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(execution).toContainText(normalPreset.label);
  await expect(execution).toBeFocused();

  await execution.click();
  await picker.getByRole("button").filter({ hasText: preset.label }).click();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(execution).toContainText(normalPreset.label);
  await expect(execution).toBeFocused();

  await execution.click();
  await picker.getByRole("button").filter({ hasText: preset.label }).click();
  await page.mouse.click(10, 10);
  await expect(picker).toBeHidden();
  await expect(execution).toContainText(normalPreset.label);
  await expect(execution).toBeFocused();
});

test("main handoff marks a saved rejected model and disables confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({
      folderId: "folder-amber", nodeId: "eiaserinnys", agentId: "roselin_codex", modelPreset: "claude-opus-rejected",
    }));
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  await page.route("**/api/nodes/*/agents", route => route.fulfill({ json: { agents: [{
    id: "roselin_codex", name: "로젤린", backend: "codex", default_preset: preset.id, portraitUrl: null,
  }] } }));
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: {
    model_presets: [preset, rejectedPreset, weeklyRejectedPreset, normalPreset, unavailablePreset],
  } }));
  await page.goto("/");
  const composer = page.locator(".v3-card-handoff");
  const execution = composer.getByRole("button", { name: "실행 조합 선택", exact: true });
  const notice = page.locator(".v3-card-handoff-error");
  await expect(execution).toHaveAttribute("data-invalid", "true");
  await expect(notice).toContainText(rejectedPreset.label);
  await expect(notice).toContainText(rejectedPreset.reason_label);
  await expect(notice).toContainText("해제");
  const noticeMetrics = await notice.evaluate(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: style.fontWeight,
      marginTop: style.marginTop,
      box: { x: +box.x.toFixed(1), y: +box.y.toFixed(1), width: +box.width.toFixed(1), height: +box.height.toFixed(1) },
    };
  });
  expect(noticeMetrics).toMatchObject({ fontSize: "12px", lineHeight: "18px", fontWeight: "600", marginTop: "2px" });
  writeFileSync(path.join(output, "main-saved-rejected-notice-metrics-1440.json"), JSON.stringify(noticeMetrics, null, 2));
  await page.screenshot({ path: path.join(output, "main-saved-model-rejected-1440.png"), animations: "disabled" });

  await execution.click();
  const picker = page.locator(".v3-card-execution-picker");
  const rejected = picker.getByRole("button").filter({ hasText: rejectedPreset.label });
  await expect(rejected).toBeDisabled();
  await expect(rejected.locator(".v3-card-execution-reason")).toContainText(rejectedPreset.reason_label);
  await expect(picker.getByRole("button", { name: "확인", exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(output, "main-saved-model-rejected-picker-1440.png"), animations: "disabled" });
});

test("mobile execution picker keeps its action row fixed while the long list scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({
      folderId: "folder-amber", nodeId: "eiaserinnys", agentId: "roselin_codex", modelPreset: "codex-6.1-sol",
    }));
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  const manyAgents = Array.from({ length: 12 }, (_, index) => ({
    id: index === 0 ? "roselin_codex" : `agent-${index + 1}`,
    name: index === 0 ? "로젤린" : `에이전트 ${index + 1}`,
    backend: "codex",
    default_preset: preset.id,
    portraitUrl: null,
  }));
  await page.route("**/api/nodes/*/agents", route => route.fulfill({ json: { agents: manyAgents } }));
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: {
    model_presets: [preset, rejectedPreset, weeklyRejectedPreset, normalPreset, unavailablePreset],
  } }));
  await page.goto("/");
  await expect(page.locator(".v3-shell[data-mobile-tab]")).toBeVisible({ timeout: 30_000 });
  const execution = page.locator(".v3-card-handoff").getByRole("button", { name: "실행 조합 선택", exact: true });
  await execution.click();
  const picker = page.locator(".v3-card-execution-picker");
  const columns = picker.locator(".v3-card-execution-columns");
  const confirm = picker.getByRole("button", { name: "확인", exact: true });
  const lastModel = columns.locator("section[aria-label=모델]").getByRole("button").last();
  await expect(lastModel).toContainText(unavailablePreset.label);
  await expect(confirm).toBeEnabled();
  const confirmBefore = await confirm.boundingBox();
  expect(confirmBefore).not.toBeNull();
  await page.screenshot({ path: path.join(output, "main-picker-long-start-390.png"), animations: "disabled" });
  await columns.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(lastModel).toBeInViewport();
  const confirmAfter = await confirm.boundingBox();
  expect(confirmAfter).not.toBeNull();
  expect(Math.abs(confirmAfter!.y - confirmBefore!.y)).toBeLessThan(1);
  await page.screenshot({ path: path.join(output, "main-picker-long-end-390.png"), animations: "disabled" });
});

test("component review shows the default and saved rejected handoff states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  await page.goto("/components");
  const sample = page.getByTestId("card-handoff-review-sample");
  await expect(sample).toBeVisible({ timeout: 30_000 });
  await sample.scrollIntoViewIfNeeded();
  const execution = sample.getByRole("button", { name: "실행 조합 선택", exact: true });
  await expect(execution).not.toHaveAttribute("data-invalid");
  await expect(sample.getByRole("alert")).toHaveCount(0);

  await sample.getByRole("button", { name: "저장 모델 거부 중", exact: true }).click();
  await expect(execution).toHaveAttribute("data-invalid", "true");
  await expect(sample.getByRole("alert")).toContainText("Claude - Opus");
  await expect(sample.getByRole("alert")).toContainText("5시간 한도 거부 중");
  await execution.click();
  const picker = page.locator(".v3-card-execution-picker");
  await expect(picker.getByRole("button", { name: "확인", exact: true })).toBeDisabled();
  await sample.screenshot({ path: path.join(output, "component-review-saved-rejected-1440.png"), animations: "disabled" });
});

async function stableHandoff(page: Page, rejected = false) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(modelPreset => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({
      folderId: "folder-amber", nodeId: "eiaserinnys", agentId: "roselin_codex", modelPreset,
    }));
  }, rejected ? rejectedPreset.id : preset.id);
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, successionPickerRuns: true });
  await page.route("**/api/nodes/*/agents", async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ json: { agents: [
      { id: "roselin_codex", name: "로젤린", backend: "codex", default_preset: preset.id, portraitUrl: null },
      { id: "other", name: "다른 에이전트", backend: "codex", default_preset: preset.id, portraitUrl: null },
    ] } });
  });
  await page.route("**/api/nodes/*/model-presets", async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ json: { model_presets: [preset, rejectedPreset, normalPreset] } });
  });
  await page.goto("/");
  const composer = page.locator(".v3-card-handoff");
  const execution = composer.getByRole("button", { name: "실행 조합 선택", exact: true });
  await expect(execution).toContainText("로젤린");
  await expect(execution).toContainText(rejected ? rejectedPreset.label : preset.label);
  await composer.getByRole("textbox", { name: "세션 첫 메시지" }).fill("안정성 확인");
  const send = composer.getByRole("button", { name: "세션 시작", exact: true });
  if (rejected) await expect(send).toBeDisabled();
  else await expect(send).toBeEnabled();
  return { composer, execution, picker: page.locator(".v3-card-execution-picker") };
}

async function startHandoffTrace(page: Page) {
  await page.evaluate(() => {
    const records: Record<string, unknown>[] = [];
    const sample = () => {
      const chip = document.querySelector(".v3-card-handoff-execution")!;
      const input = document.querySelector('.v3-card-handoff textarea')!;
      const send = document.querySelector<HTMLButtonElement>('.v3-card-handoff button[aria-label="세션 시작"]')!;
      records.push({ time: performance.now(), notice: !!document.querySelector(".v3-card-handoff-error"),
        invalid: chip.hasAttribute("data-invalid"), y: input.getBoundingClientRect().y,
        label: chip.textContent, enabled: !send.disabled });
    };
    let frame = 0;
    const loop = () => { sample(); frame = requestAnimationFrame(loop); };
    const observer = new MutationObserver(sample);
    observer.observe(document.querySelector(".v3-card-handoff")!.parentElement!.parentElement!,
      { childList: true, subtree: true, attributes: true, characterData: true });
    loop();
    (window as any).stopHandoffTrace = () => { cancelAnimationFrame(frame); observer.disconnect(); sample(); return records; };
  });
}

async function finishHandoffTrace(page: Page, name: string, changedLabel?: string) {
  const records = await page.evaluate(() => (window as any).stopHandoffTrace()) as Record<string, unknown>[];
  writeFileSync(path.join(output, `${name}.json`), JSON.stringify(records, null, 2));
  expect(records.length).toBeGreaterThan(10);
  const { time: _time, ...baseline } = records[0];
  // Every observed frame/mutation must preserve all five user-facing fields.
  for (const { time: _sampleTime, ...state } of records) {
    const { label, ...fields } = state;
    const { label: originalLabel, ...expected } = baseline;
    expect(fields).toEqual(expected);
    expect(changedLabel ? [originalLabel, changedLabel] : [originalLabel]).toContain(label);
  }
}

for (const rejected of [true, false]) test(`handoff stays stable through delayed picker remounts rejected=${rejected}`, async ({ page }) => {
  const { execution, picker, composer } = await stableHandoff(page, rejected);
  if (rejected) await expect(page.locator(".v3-card-handoff-error")).toContainText(rejectedPreset.reason_label);
  await startHandoffTrace(page);
  for (let index = 0; index < 3; index++) {
    await execution.click();
    await expect(picker.getByRole("button", { name: preset.label, exact: true })).toBeVisible();
    if (index === 1) await page.keyboard.press("Escape");
    else await picker.getByRole("button", { name: "취소", exact: true }).click();
    await expect(picker).toBeHidden();
    // Include the delayed responses and closing animation in the observation interval.
    await page.waitForTimeout(500);
  }
  await finishHandoffTrace(page, `handoff-stability-${rejected ? "rejected" : "normal"}`);
  if (!rejected) {
    await execution.click();
    await picker.getByRole("button", { name: normalPreset.label, exact: true }).click();
    const changedLabel = (await execution.textContent())!.replace(preset.label, normalPreset.label);
    await startHandoffTrace(page);
    await picker.getByRole("button", { name: "확인", exact: true }).click();
    await expect(execution).toContainText(normalPreset.label);
    await expect(composer.getByRole("button", { name: "세션 시작", exact: true })).toBeEnabled();
    await page.waitForTimeout(500);
    await finishHandoffTrace(page, "handoff-stability-after-confirm", changedLabel);
  }
});

test("execution popup initially focuses itself then tabs through columns and actions", async ({ page }) => {
  const { execution, picker } = await stableHandoff(page);
  await execution.focus();
  await execution.press("Enter");
  await expect(picker).toBeFocused();
  await page.screenshot({ path: path.join(output, "keyboard-open-1440.png"), animations: "disabled" });
  const order: string[] = [];
  const labels = ["로젤린", "다른 에이전트", "eiaserinnys", "qa-node", preset.label, normalPreset.label, "취소", "확인"];
  for (const label of labels) {
    await page.keyboard.press("Tab");
    await expect(picker.getByRole("button", { name: label })).toBeFocused();
    order.push(await page.evaluate(() => document.activeElement?.textContent ?? ""));
  }
  writeFileSync(path.join(output, "keyboard-focus.json"), JSON.stringify({ initial: "popup", order }, null, 2));
});

test("choosing another agent preserves the draft node until confirmation", async ({ page }) => {
  const { execution, picker } = await stableHandoff(page);
  await execution.click();
  const nodeB = picker.getByRole("button", { name: "qa-node", exact: true });
  await nodeB.click();
  await picker.getByRole("button", { name: "다른 에이전트" }).click();
  await expect(nodeB).toHaveAttribute("aria-pressed", "true");
  await expect(execution).toContainText("eiaserinnys");
  await expect(picker.getByRole("button", { name: "확인", exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(output, "draft-node-b-after-agent-1440.png"), animations: "disabled" });
  await picker.getByRole("button", { name: "확인", exact: true }).click();
  await expect(execution).toContainText("다른 에이전트 · qa-node");
});
