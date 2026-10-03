import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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
    await installV3VisualQaRoutes(page, { successionPickerRuns: true,
      onSessionCreate: payload => payloads.push(payload) });
    await page.route("**/api/nodes/*/agents", route => route.fulfill({ json: {
      agents: [{ id: "roselin_codex", name: "로젤린", backend: "codex",
        default_preset: preset.id, portraitUrl: null }] } }));
    await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: {
      model_presets: [preset, { ...preset, id: "no-auth", label: "인증 필요 모델",
        available: false, reason: "not_authenticated", reason_label: "미인증", resets_at: null }] } }));
    await page.goto("/v3");
    await page.getByTestId("v3-task-task-alpha").click();
    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const modal = page.locator(".v3-succession-modal");
    await expect(modal).toBeVisible();
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
    const start = modal.getByRole("button", { name: "시작", exact: true });
    await expect(start).toBeEnabled();
    await page.screenshot({ path: path.join(output, `selected-${width}-${explicit}.png`), animations: "disabled" });
    await start.click();
    await expect(modal).toBeHidden();
    expect(payloads.at(-1)).toMatchObject({ model_preset: preset.id });
    writeFileSync(path.join(output, `submission-${width}-${explicit}.json`),
      JSON.stringify({ viewport: width, explicit, dangerColor, before, after: before, payload: payloads.at(-1) }, null, 2));
  });
}
