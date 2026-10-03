import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/20261003-quota-session-start");
mkdirSync(output, { recursive: true });
const preset = { id: "codex-6.1-sol", label: "Codex - 6.1 Sol", backend: "codex",
  available: true, reason: "quota_exhausted", reason_label: "7일 사용량 제한",
  resets_at: "2030-01-02T03:04:00.000Z", usage_warning: false };

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
      model_presets: [preset, { ...preset, id: "no-auth", label: "인증 필요 모델",
        available: false, reason: "not_authenticated", reason_label: "미인증", resets_at: null }] } }));
    await page.goto("/");
    if (width < 760) {
      await page.getByTestId("v3-mobile-tab-projects").click();
      await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click();
    } else {
      await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
    }
    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const modal = page.locator(".v3-succession-modal");
    await expect(modal).toBeVisible();
    const environment = modal.locator("details").filter({ has: page.locator("summary strong").filter({ hasText: "실행 환경" }) });
    if (await environment.getAttribute("open") === null) await environment.locator("summary").click();
    const model = modal.getByRole("combobox", { name: "모델 선택" });
    await expect(model).toContainText(preset.label);
    const before = await model.boundingBox();
    await model.click();
    const exhausted = page.locator('[data-slot="select-item"]').filter({ hasText: preset.label });
    await expect(exhausted).not.toHaveAttribute("data-disabled");
    const name = exhausted.getByText(preset.label, { exact: true });
    const dangerColor = await name.evaluate(el => getComputedStyle(el).color);
    expect(dangerColor).not.toBe(await exhausted.evaluate(el => getComputedStyle(el).color));
    await expect(page.locator('[data-slot="select-item"]').filter({ hasText: "인증 필요 모델" })).toHaveAttribute("data-disabled");
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
  const name = model.getByText("사용량 소진 예시 모델", { exact: true });
  const color = await name.evaluate(el => getComputedStyle(el).color);
  expect(color).not.toBe(await page.getByText("사용 가능한 예시 모델", { exact: true }).evaluate(el => getComputedStyle(el).color));
  await page.screenshot({ path: path.join(output, "app-rnweb-options-390.png") });
  const surface = page.getByTestId("execution-model-public-exhausted-model-visual");
  const unselectedColor = await surface.evaluate(el => getComputedStyle(el).backgroundColor);
  await model.click();
  await expect.poll(() => surface.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(unselectedColor);
  const confirm = page.getByRole("button", { name: "실행 대상 확인", exact: true });
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: path.join(output, "app-rnweb-selected-390.png") });
  await confirm.click();
  await expect(page.getByTestId("review-dialogue-result")).toContainText("메모리 실행:");
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
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: { model_presets: [preset] } }));
  await page.goto("/");
  const composer = page.locator(".v3-card-handoff");
  await composer.getByRole("button", { name: "실행 조합 선택", exact: true }).click();
  const option = page.locator(".v3-card-execution-picker").getByRole("button", { name: preset.label, exact: true });
  await expect(option).toBeEnabled();
  await option.click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: path.join(output, "main-execution-picker-1440.png") });
  await page.keyboard.press("Escape");
  await expect(composer.getByText(preset.label, { exact: true })).toHaveClass("text-destructive");
  await composer.getByRole("textbox", { name: "세션 첫 메시지" }).fill("소진 모델을 선택해 시작");
  await expect(composer.getByRole("button", { name: "세션 시작", exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(output, "main-selected-1440.png") });
  await composer.getByRole("button", { name: "세션 시작", exact: true }).click();
  await expect.poll(() => payloads.length).toBe(1);
  expect(payloads[0]).toMatchObject({ model_preset: preset.id });
  writeFileSync(path.join(output, "main-submission.json"), JSON.stringify(payloads[0], null, 2));
});
