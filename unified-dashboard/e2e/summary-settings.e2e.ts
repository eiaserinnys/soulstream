import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// 실제 설정창의 「요약」 탭을 목 API로 띄워 기본 꺼짐과 운영 기대값 두 장면을 캡처하고 조작을 잰다.
const output = path.resolve("../.local/summary-settings");
const preset = (id: string, label: string, backend: string, supported_efforts?: string[]) => ({
  id, label, backend, available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
  ...(supported_efforts ? { supported_efforts } : {}),
});
const presets = [
  preset("claude-haiku", "Claude - Haiku", "claude"),
  preset("claude-sonnet", "Claude - Sonnet", "claude", ["low", "medium", "high", "xhigh", "max"]),
  preset("claude-opus", "Claude - Opus", "claude", ["low", "medium", "high", "xhigh", "max"]),
  preset("kimi-2", "Kimi - 2", "claude"),
  preset("codex-5.6-luna", "Codex - 5.6 Luna", "codex", ["low", "medium", "high", "xhigh", "max"]),
  preset("codex-5.6-terra", "Codex - 5.6 Terra", "codex", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  preset("gemini-4-hydrogen", "Gemini - 4 Hydrogen", "antigravity", ["low", "medium", "high", "xhigh"]),
  preset("opencode-deepseek-v4.1-flash-free", "OpenCode - DeepSeek V4.1 Flash Free", "opencode"),
];
const selectable_preset_ids = ["claude-haiku", "claude-sonnet", "claude-opus", "codex-5.6-luna", "codex-5.6-terra", "gemini-4-hydrogen"];
const OFF = { turn: { enabled: false, model_presets: [] as string[] }, session: { enabled: false, model_presets: [] as string[] } };
const OPERATING = {
  turn: { enabled: true, model_presets: ["claude-sonnet", "gemini-4-hydrogen", "codex-5.6-luna"] },
  session: { enabled: true, model_presets: ["claude-sonnet", "codex-5.6-terra"] },
};
type Value = typeof OFF;

async function openSummaries(page: Page, api: { get: () => Promise<{ status: number; json?: unknown; body?: string }>; put: (value: Value, version: number) => { status: number; json: unknown } }) {
  mkdirSync(output, { recursive: true });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", route => route.fulfill({ json: { preferences: { chatFontSize: 17 }, hasBackground: false } }));
  await page.route("**/api/health", route => route.fulfill({ json: { healthy: true, ready: true, draining: false, build_id: "dev" } }));
  await page.route("**/api/config/settings", route => route.fulfill({ json: { categories: [] } }));
  await page.route("**/api/persistent-sessions", route => route.fulfill({ json: { sessions: [], total: 0, create_defaults: { node_id: "primary-node" } } }));
  await page.route("**/api/nodes/primary-node/model-presets", route => route.fulfill({ json: { model_presets: presets } }));
  await page.route("**/api/admin/settings/summaries", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { value: Value; expectedVersion: number };
      const result = api.put(body.value, body.expectedVersion);
      return route.fulfill({ status: result.status, json: result.json });
    }
    const result = await api.get();
    return result.json === undefined ? route.fulfill({ status: result.status, body: result.body ?? "" }) : route.fulfill({ status: result.status, json: result.json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const index = page.getByRole("button", { name: "모든 설정" });
  if (await index.isVisible().catch(() => false)) await index.click();
  await page.getByRole("button", { name: "요약", exact: true }).click();
}
const payload = (value: Value, version: number) => ({
  value, version, source: version === 0 ? "default" : "settings",
  updated_at: version === 0 ? null : "2026-11-27T09:00:00.000Z", updated_by: version === 0 ? null : "admin@example.com", selectable_preset_ids,
});
/** 설정창은 본문이 안에서 스크롤되므로, 긴 장면은 캡처하는 동안만 창 높이를 내용에 맞춘다. */
async function shot(page: Page, name: string, fullContent = false) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.fonts.ready);
  const dialog = page.locator(".config-dialog:visible").first();
  if (fullContent) {
    await dialog.evaluate(element => {
      for (const node of [element, ...element.querySelectorAll("*")] as HTMLElement[]) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowY) || style.maxHeight !== "none") {
          node.style.overflowY = "visible"; node.style.maxHeight = "none"; node.style.height = "auto";
        }
      }
    });
  }
  await dialog.screenshot({ path: path.join(output, name), animations: "disabled" });
}
async function noHorizontalOverflow(form: Locator) {
  return await form.evaluate(element => {
    const outer = element.getBoundingClientRect();
    const escaped = [...element.querySelectorAll("button, [role=switch], select, [role=combobox]")].filter(control => {
      const bounds = control.getBoundingClientRect();
      return bounds.left < outer.left - 1 || bounds.right > outer.right + 1;
    }).map(control => control.getAttribute("aria-label") ?? control.textContent);
    return { escaped, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
}

test("기본 꺼짐: 행이 없으면 둘 다 꺼지고 빈 목록이며, 로딩 중에는 틀만 선다", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 1100 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await openSummaries(page, {
    get: async () => { await gate; return { status: 200, json: payload(OFF, 0) }; },
    put: () => ({ status: 500, json: {} }),
  });
  const form = page.getByRole("form", { name: "요약" });
  await expect(form.getByText("불러오는 중…")).toBeVisible();
  await expect(form.getByRole("button", { name: "요약 설정 저장" })).toHaveCount(0);
  release();
  await expect(form.getByRole("switch", { name: "턴 요약 사용" })).toHaveAttribute("aria-checked", "false");
  await expect(form.getByRole("switch", { name: "세션 요약 사용" })).toHaveAttribute("aria-checked", "false");
  await expect(form.locator("fieldset")).toHaveCount(0);
  await expect(form.getByText("턴 요약을 모아 세션 줄거리를 만듭니다. 턴 요약이 꺼져 있으면 새 재료가 쌓이지 않습니다.")).toBeVisible();
  await expect(form.getByRole("button", { name: "요약 설정 저장" })).toBeDisabled();
  await shot(page, "summary-settings-default-off.png");
});

test("운영 기대값: 순서를 읽고, 바꾸고, 저장하고, 충돌과 서버 거절을 보인다", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 1500 });
  let value: Value = OPERATING, version = 4, mode: "ok" | "conflict" | "invalid" = "ok";
  await openSummaries(page, {
    get: async () => ({ status: 200, json: payload(value, version) }),
    put: (next, expected) => {
      if (mode === "conflict") return { status: 409, json: { detail: { error: { message: "Summary settings changed; reload before saving" } } } };
      if (mode === "invalid") return { status: 400, json: { detail: { error: { code: "SUMMARY_SETTINGS_INVALID", message: "턴 요약: 같은 모델을 두 번 넣을 수 없습니다 (claude-sonnet)." } } } };
      value = next; version = expected + 1;
      return { status: 200, json: payload(value, version) };
    },
  });
  const form = page.getByRole("form", { name: "요약" });
  await expect(form.getByRole("switch", { name: "턴 요약 사용" })).toHaveAttribute("aria-checked", "true");
  await expect(form.getByRole("combobox", { name: "턴 요약 1번째 모델" })).toContainText("Claude - Sonnet");
  await expect(form.getByRole("combobox", { name: "턴 요약 2번째 모델" })).toContainText("Gemini - 4 Hydrogen");
  await expect(form.getByRole("combobox", { name: "턴 요약 3번째 모델" })).toContainText("Codex - 5.6 Luna");
  await expect(form.getByRole("combobox", { name: "세션 요약 1번째 모델" })).toContainText("Claude - Sonnet");
  await expect(form.getByRole("combobox", { name: "세션 요약 2번째 모델" })).toContainText("Codex - 5.6 Terra");
  await expect(form.locator("fieldset")).toHaveCount(5);
  await shot(page, "summary-settings-operating.png", true);

  // 고를 수 있는 목록에는 서버가 받는 것만 있다.
  await form.getByRole("combobox", { name: "세션 요약 2번째 모델" }).click();
  const names = await page.getByRole("option").allInnerTexts();
  expect(names.join("|")).toContain("Claude - Haiku");
  expect(names.join("|")).not.toContain("Kimi");
  expect(names.join("|")).not.toContain("OpenCode");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(form.getByRole("combobox", { name: "세션 요약 2번째 모델" })).toBeFocused();

  await form.getByRole("button", { name: "턴 요약 3번째 모델 위로" }).click();
  await form.getByRole("switch", { name: "세션 요약 사용" }).click();
  await form.getByRole("button", { name: "요약 설정 저장" }).click();
  await expect(form.getByRole("button", { name: "요약 설정 저장" })).toBeDisabled();
  await expect(form.getByRole("status")).toHaveText("저장했습니다.");
  expect(value.turn.model_presets).toEqual(["claude-sonnet", "codex-5.6-luna", "gemini-4-hydrogen"]);
  expect(value.session.enabled).toBe(false);
  expect(version).toBe(5);

  await form.getByRole("switch", { name: "세션 요약 사용" }).click();
  await form.getByRole("button", { name: "세션 요약 2번째 모델 제거" }).click();
  await form.getByRole("button", { name: "세션 요약 1번째 모델 제거" }).click();
  await form.getByRole("button", { name: "요약 설정 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("세션 요약: 켜려면 모델을 하나 이상 골라 주세요.");

  mode = "invalid";
  await form.getByRole("switch", { name: "세션 요약 사용" }).click();
  await form.getByRole("button", { name: "요약 설정 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("턴 요약: 같은 모델을 두 번 넣을 수 없습니다 (claude-sonnet).");
  await shot(page, "summary-settings-rejected.png");

  mode = "conflict";
  await form.getByRole("button", { name: "요약 설정 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 먼저 바뀌었습니다");
  mode = "ok";
  await form.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(form.getByRole("combobox", { name: "턴 요약 2번째 모델" })).toContainText("Codex - 5.6 Luna");
});

test("좁은 폭과 폭 바꾸기에서도 틀 밖으로 넘치지 않고 입력이 남는다", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 1900 });
  await openSummaries(page, { get: async () => ({ status: 200, json: payload(OPERATING, 4) }), put: () => ({ status: 500, json: {} }) });
  const form = page.getByRole("form", { name: "요약" });
  await expect(form.getByRole("combobox", { name: "턴 요약 1번째 모델" })).toBeVisible();
  expect(await noHorizontalOverflow(form)).toMatchObject({ escaped: [] });
  await form.getByRole("button", { name: "턴 요약 3번째 모델 제거" }).click();
  await shot(page, "summary-settings-narrow.png");
  await page.setViewportSize({ width: 1280, height: 1100 });
  await expect(form.locator("fieldset")).toHaveCount(4);
  await page.setViewportSize({ width: 360, height: 1900 });
  await expect(form.locator("fieldset")).toHaveCount(4);
  const narrow = await noHorizontalOverflow(form);
  expect(narrow.escaped).toEqual([]);
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth + 1);
});
