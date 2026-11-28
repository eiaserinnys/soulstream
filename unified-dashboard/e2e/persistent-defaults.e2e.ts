import { expect, test, type Page } from "./test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/tmp/card1836/pas-defaults-web/sample-shots");
const sampleSelector = '[data-component="PersistentDefaultsSettingsForm"]';
async function prepare(page: Page, width: number) {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", route => route.fulfill({ json: { preferences: { chatFontSize: 17 }, hasBackground: false } }));
}
async function capture(page: Page, name: string) {
  const sample = page.locator(sampleSelector);
  await sample.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await sample.screenshot({ path: path.join(output, name), animations: "disabled" });
}

test("wide sample: catalog, settings, ordering and conflict", async ({ page }) => {
  await prepare(page, 1280); await page.goto("/components");
  const sample = page.locator(sampleSelector);
  await expect(sample.getByText("카탈로그 기본값을 쓰는 중")).toBeVisible({ timeout: 20000 });
  await capture(page, "wide-catalog.png");
  await sample.getByRole("button", { name: "저장된 설정 견본" }).click();
  await expect(sample.getByText("저장한 설정을 쓰는 중")).toBeVisible();
  await expect(sample.getByRole("button", { name: "대체 모델 추가" })).toBeDisabled();
  await capture(page, "wide-settings.png");
  const form = sample.getByRole("form", { name: "영구 세션 기본 모델" });
  await form.getByRole("button", { name: "대체 2 위로" }).click();
  await expect(form.getByLabel("대체 1 모델")).toContainText("모델 감마");
  await form.getByRole("button", { name: "기본 모델 저장" }).click();
  await expect(form.getByRole("button", { name: "기본 모델 저장" })).toBeDisabled();
  await sample.getByRole("button", { name: "충돌 견본" }).click();
  await form.getByRole("button", { name: "대체 1 제거" }).click();
  await form.getByRole("button", { name: "기본 모델 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 먼저 바뀌었습니다");
  await capture(page, "conflict.png");
  await form.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(form.getByRole("alert")).toHaveCount(0);
});

test("narrow sample keeps fields and actions within the form", async ({ page }) => {
  await prepare(page, 390); await page.goto("/components");
  await page.setViewportSize({ width: 390, height: 1800 });
  const sample = page.locator(sampleSelector);
  await sample.getByRole("button", { name: "저장된 설정 견본" }).click();
  const form = sample.getByRole("form", { name: "영구 세션 기본 모델" });
  await expect(form.getByText("저장한 설정을 쓰는 중")).toBeVisible();
  const trigger = form.getByLabel("기본 모델");
  await trigger.focus(); await trigger.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByLabel("대체 1 모델")).toBeFocused();
  await capture(page, "narrow-settings.png");
  const overflow = await form.evaluate(element => {
    const outer = element.getBoundingClientRect();
    return [...element.querySelectorAll("button")].filter(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.left < outer.left - 1 || bounds.right > outer.right + 1;
    }).map(button => button.textContent);
  });
  expect(overflow).toEqual([]);
  await form.getByRole("button", { name: "대체 2 위로" }).click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect(form.getByLabel("대체 1 모델")).toContainText("모델 감마");
  await page.setViewportSize({ width: 360, height: 1000 });
  await expect(form.getByLabel("대체 1 모델")).toContainText("모델 감마");
  expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  writeFileSync(path.join(output, "operations.md"), `# 조작 결과\n\n| 항목 | 결과 | 근거 |\n| --- | --- | --- |\n| 14 | 통과 | 모델 선택기를 Esc로 닫은 뒤 선택 단추에 초점이 돌아왔다. |\n| 15 | 통과 | 기본 모델에서 Tab으로 첫 대체 모델에 이동하고 선택기는 Esc로 닫았다. |\n| 16 | 통과 | 390px에서 버튼 경계를 재고 360px에서 폼 가로 넘침을 확인했다. |\n| 17 | 통과 | 409 안내와 다시 불러오기를 조작하고 conflict.png에 남겼다. 목록 조회 503은 단위 시험에서 확인했다. |\n| 18 | 통과 | 순서를 바꾼 뒤 390→1280→360px로 바꾸어 입력 상태 보존을 확인했다. |\n\n| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |\n| --- | --- | --- | --- | --- | --- |\n| 모델 선택 | 선택 단추에서 Enter | 열린 목록 | 열기 | 닫기 | 선택 단추 |\n\n명령: corepack pnpm -C unified-dashboard exec playwright test --config playwright.persistent-defaults.config.ts\n산출물: ${output}\n`);
});

test("admin tab loads the default node and preserves an absent preset", async ({ page }) => {
  await prepare(page, 1280);
  await page.route("**/api/persistent-sessions", route => route.fulfill({ json: { sessions: [], total: 0, create_defaults: { node_id: "primary-node" } } }));
  await page.route("**/api/nodes/primary-node/model-presets", route => route.fulfill({ json: { model_presets: [
    { id: "known", label: "알려진 모델", backend: "sample", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false, supported_efforts: ["high"] },
  ] } }));
  let submitted: unknown;
  await page.route("**/api/admin/settings/persistent-defaults", async route => {
    if (route.request().method() === "PUT") {
      submitted = route.request().postDataJSON();
      const body = submitted as { value: object };
      await route.fulfill({ json: { value: body.value, version: 2, source: "settings" } });
    } else await route.fulfill({ json: { value: { model_preset: "missing-id", fallback_models: [{ model_preset: "known", reasoning_effort: null }] }, version: 1, source: "settings" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "영구 세션 기본 모델", exact: true }).click();
  const form = page.getByRole("form", { name: "영구 세션 기본 모델" });
  await expect(form.getByLabel("기본 모델")).toContainText("missing-id");
  await expect(form.getByText("이 노드 목록에 없음")).toHaveCount(1);
  await form.getByRole("button", { name: "대체 1 제거" }).click();
  await form.getByRole("button", { name: "기본 모델 저장" }).click();
  await expect.poll(() => submitted).toEqual({ expectedVersion: 1, value: { model_preset: "missing-id", fallback_models: [] } });
});
