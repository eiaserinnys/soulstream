import { expect, test, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// 실제 설정창 검수 시나리오를 리포 시험으로 옮긴다. 모든 응답은 로컬 fixture다.
const output = path.resolve("../../../.local/tmp/card1836/pas-defaults-web/shots");
const presets = [
  { id: "alpha", label: "모델 알파", supported_efforts: ["low", "high"] },
  { id: "beta", label: "모델 베타", supported_efforts: ["medium", "high"] },
  { id: "gamma", label: "모델 감마", supported_efforts: ["high"] },
  { id: "delta", label: "모델 델타", supported_efforts: [] },
].map(preset => ({ ...preset, backend: "sample", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false }));
const settingsValue = () => ({ model_preset: "alpha", fallback_models: [
  { model_preset: "beta", reasoning_effort: "medium" },
  { model_preset: "gamma", reasoning_effort: "high" },
  { model_preset: "delta", reasoning_effort: null },
] });
type Value = ReturnType<typeof settingsValue>;
async function measure(form: Locator) {
  return form.evaluate(element => {
    const fields = [...element.querySelectorAll("fieldset")];
    const box = (item: Element) => item.getBoundingClientRect();
    const controls = fields[0]!.querySelector('[aria-label="대체 1 아래로"]')!.parentElement!;
    return {
      rows: fields.map(field => [...field.querySelectorAll("button")].slice(-3).map(button => box(button).top)),
      inner: box(controls).top - Math.max(box(fields[0]!.querySelector('[aria-label="대체 1 모델"]')!).bottom, box(fields[0]!.querySelector('[aria-label="대체 1 노력"]')!).bottom),
      between: box(fields[1]!).top - box(fields[0]!).bottom,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    };
  });
}

test("실제 설정창의 로딩, 편집, 실패와 반응형 배치", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", route => route.fulfill({ json: { preferences: { chatFontSize: 17 }, hasBackground: false } }));
  await page.route("**/api/config/settings", route => route.fulfill({ json: { categories: [] } }));
  await page.route("**/api/persistent-sessions", route => route.fulfill({ json: { sessions: [], total: 0, create_defaults: { node_id: "primary-node" } } }));
  await page.route("**/api/nodes/primary-node/model-presets", route => route.fulfill({ json: { model_presets: presets } }));

  let value: Value = { model_preset: "alpha", fallback_models: [] }, source = "catalog", version = 1;
  let getStatus = 200, putStatus = 200, holdGet = true, releaseGet!: () => void;
  const gate = new Promise<void>(resolve => { releaseGet = resolve; });
  await page.route("**/api/admin/settings/persistent-defaults", async route => {
    if (route.request().method() === "PUT") {
      if (putStatus === 409) return route.fulfill({ status: 409, json: { message: "version conflict" } });
      if (putStatus === 422) return route.fulfill({ status: 422, json: { detail: { error: { message: "대체 모델 값이 잘못되었습니다." } } } });
      value = route.request().postDataJSON().value as Value; source = "settings"; version += 1;
      return route.fulfill({ json: { value, source, version } });
    }
    if (holdGet) await gate;
    if (getStatus !== 200) return route.fulfill({ status: getStatus, body: "upstream unavailable" });
    return route.fulfill({ json: { value, source, version } });
  });
  const form = page.getByRole("form", { name: "영구 세션 기본 모델" });
  const dialog = page.locator(".config-dialog:visible").first();
  async function shot(name: string) {
    await expect(page.getByText("Failed to fetch settings")).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await dialog.screenshot({ path: path.join(output, name), animations: "disabled" });
  }
  async function reload() {
    await form.getByRole("button", { name: "다시 불러오기" }).click();
  }
  await page.goto("/");
  await page.getByRole("button", { name: "서버 설정", exact: true }).click();
  await page.getByRole("button", { name: "영구 세션 기본 모델", exact: true }).click();
  await expect(form.getByText("불러오는 중…")).toBeVisible();
  await expect(form.getByRole("button", { name: "다시 불러오기" })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "기본 모델 저장" })).toHaveCount(0);
  await shot("loading.png");
  holdGet = false; releaseGet();
  await expect(form.getByText("카탈로그 기본값을 쓰는 중")).toBeVisible();
  await expect(dialog.getByText("새 영구 세션이 쓸 기본 모델과 대체 순서를 정합니다. 이미 있는 세션은 바뀌지 않습니다.")).toBeVisible();
  await shot("wide-catalog.png");

  value = settingsValue(); source = "settings";
  await reload();
  await expect(form.getByText("저장한 설정을 쓰는 중")).toBeVisible();
  await expect(form.locator("fieldset")).toHaveCount(3);
  await expect(form.getByRole("button", { name: "대체 모델 추가" })).toBeDisabled();
  const widths = await Promise.all([form.getByLabel("기본 모델").boundingBox(), form.getByLabel("대체 1 모델").boundingBox()]);
  expect(Math.abs(widths[0]!.x - widths[1]!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(widths[0]!.width - widths[1]!.width)).toBeLessThanOrEqual(1);
  const wideGeometry = await measure(form);
  expect(wideGeometry.inner).toBeLessThan(wideGeometry.between);
  await shot("wide-settings.png");

  await form.getByRole("button", { name: "대체 2 위로" }).click();
  await form.getByRole("button", { name: "기본 모델 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했습니다.");
  await form.getByRole("button", { name: "기본 모델 저장" }).scrollIntoViewIfNeeded();
  await shot("saved.png");
  await form.getByRole("button", { name: "대체 1 제거" }).click();
  await expect(form.getByRole("status")).toHaveCount(0);
  putStatus = 409;
  await form.getByRole("button", { name: "기본 모델 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 먼저 바뀌었습니다");
  await expect(form.getByRole("button", { name: "기본 모델 저장" })).toBeDisabled();
  await form.getByRole("button", { name: "기본 모델 저장" }).scrollIntoViewIfNeeded();
  await shot("conflict.png");
  putStatus = 422; await reload();
  await form.getByRole("button", { name: "대체 1 제거" }).click();
  await form.getByRole("button", { name: "기본 모델 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("대체 모델 값이 잘못되었습니다.");

  getStatus = 503; await reload();
  await expect(form.getByRole("alert")).toHaveText("기본 모델 설정을 불러오지 못했습니다 (503)");
  await expect(form.getByRole("button", { name: "기본 모델 저장" })).toBeDisabled();
  await shot("load-failed.png");
  getStatus = 200; putStatus = 200; value = { ...settingsValue(), model_preset: "retired-model-2025" };
  await reload();
  await expect(form.getByLabel("기본 모델")).toHaveText("retired-model-2025");
  await expect(form.getByText("이 노드 목록에 없음")).toHaveCount(1);
  await expect(form.getByLabel("기본 모델")).not.toContainText("이 노드 목록에 없음");
  await shot("missing-model.png");

  value = settingsValue(); await reload();
  await page.setViewportSize({ width: 360, height: 1800 });
  await expect(form.getByText("저장한 설정을 쓰는 중")).toBeVisible();
  const geometry = await measure(form);
  for (const row of geometry.rows) expect(Math.max(...row) - Math.min(...row)).toBeLessThanOrEqual(1);
  expect(geometry.inner).toBeLessThan(geometry.between);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  await shot("narrow-settings.png");
  const model = form.getByLabel("기본 모델");
  await model.focus(); await model.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(model).toBeFocused();
  await page.keyboard.press("Tab"); await expect(form.getByLabel("대체 1 모델")).toBeFocused();
  await form.getByRole("button", { name: "대체 2 위로" }).click();
  await page.setViewportSize({ width: 1280, height: 1500 });
  await expect(form.getByLabel("대체 1 모델")).toContainText("모델 감마");
  await page.setViewportSize({ width: 360, height: 1800 });
  await expect(form.getByLabel("대체 1 모델")).toContainText("모델 감마");
  writeFileSync(path.join(output, "operations.md"), `# 실제 설정창 조작 결과\n\n| 항목 | 결과 | 근거 |\n| --- | --- | --- |\n| 14 | 통과 | 선택기를 Esc로 닫은 뒤 연 단추로 초점이 돌아왔다. |\n| 15 | 통과 | 모델 선택기 다음 Tab은 대체 1 모델이며 Esc로 목록을 닫았다. |\n| 16 | 통과 | 360px 단추 top ${JSON.stringify(geometry.rows)}, 가로 폭 ${geometry.scrollWidth}/${geometry.clientWidth}px. |\n| 17 | 통과 | 409, 422, 503 오류와 다시 불러오기를 확인했다. |\n| 18 | 통과 | 순서를 바꾼 뒤 360→1280→360px 전환에도 초안이 유지됐다. |\n\n| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |\n| --- | --- | --- | --- | --- | --- |\n| 모델 선택 | 선택 단추 | 열린 목록 | 열기 | 닫기 | 선택 단추 |\n\n간격: 넓은 폭 묶음 안 ${wideGeometry.inner}px, 묶음 사이 ${wideGeometry.between}px; 360px 묶음 안 ${geometry.inner}px, 묶음 사이 ${geometry.between}px.\n\n명령: corepack pnpm -C unified-dashboard exec playwright test --config playwright.pas-defaults.config.ts\n`);
});
