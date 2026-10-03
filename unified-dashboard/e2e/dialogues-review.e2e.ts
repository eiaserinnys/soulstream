import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { dialoguesInventory } from "../client/v3/dialogues-inventory";
const output = path.resolve("../../../.local/artifacts/20261003-dialogues-web");
async function prepare(page: Page, width: number) {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page);
  const errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The recorder watches every API write, including telemetry. All API requests are mocked.
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
      writes.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/config")
      return route.fulfill({ json: { authEnabled: true, devModeEnabled: false } });
    if (url.pathname === "/api/auth/status")
      return route.fulfill({
        json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } },
      });
    if (url.pathname === "/api/ui-events/config")
      return route.fulfill({
        json: {
          enabled: true,
          flushIntervalMs: 1000,
          maxBatchSize: 1,
          maxQueueSize: 500,
          schemaVersion: "soulstream.ui_event.v1",
        },
      });
    return route.fallback();
  });
  return { errors, writes };
}
async function open(page: Page, id: string) {
  await page.locator(`[data-dialogue="${id}"]`).getByRole("button", { name: /열기$/ }).click();
}
async function measure(page: Page) {
  return page.locator("main").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      documentWidth: document.documentElement.scrollWidth,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
}
for (const width of [1440, 390]) {
  test(`gallery direct entry, inventory open/close and layout ${width}`, async ({ page }) => {
    const state = await prepare(page, width);
    await page.goto("/dialogues/");
    await expect(page.getByTestId("dialogues-review")).toBeVisible();
    await page.reload();
    await expect(page.locator("[data-dialogue]")).toHaveCount(dialoguesInventory.length);
    const gallery = await measure(page);
    expect(gallery.documentWidth).toBe(width);
    expect(gallery.scrollWidth).toBe(gallery.clientWidth);
    const tested: string[] = [];
    for (const item of dialoguesInventory) {
      console.log(`opening ${width}: ${item.id}`);
      if (item.id.startsWith("confirm-")) {
        page.once("dialog", (dialog) => dialog.dismiss());
        await open(page, item.id);
      } else {
        await open(page, item.id);
        await expect(page.getByTestId("dialogue-sample")).toBeAttached();
        // Wait for the real surface, not merely the gallery host.
        const surface =
          item.id === "folder-sheet" && width === 1440
            ? page
                .locator("div.fixed.z-50")
                .filter({ has: page.getByRole("button", { name: "이름 변경", exact: true }) })
            : page.locator(
                '[role="dialog"], [data-slot="popover-popup"], .v3-workspace-scrim, .v3-card-board-overlay, [role="menu"]',
              );
        await expect(surface.first()).toBeVisible();
        if (["project-create", "new-session", "settings", "card-detail", "document-overlay"].includes(item.id)) {
          await page.screenshot({ path: path.join(output, `${item.id}-${width}.png`), animations: "disabled" });
        }
        // Use the production close/cancel operation. Nested user forms close before ConfigModal.
        if (item.id.startsWith("user-")) await page.getByRole("button", { name: "취소", exact: true }).last().click();
        if (item.id === "folder-sheet" && width === 1440) {
          await surface.first().hover();
          await page.mouse.move(1435, 995);
        }
        const cancel = page
          .getByRole("button", { name: /^(취소|닫기|확인|카드 닫기|문서 편집기 닫기|확대 닫기)$/ })
          .last();
        if (await cancel.isVisible()) await cancel.click();
        else await page.keyboard.press("Escape");
        // Embedded popovers and expanded boards retain their original parent after closing.
        await page.keyboard.press("Escape");
        const reset = page.getByRole("button", { name: "샘플 닫기", exact: true });
        if (await reset.isVisible()) await reset.click();
      }
      tested.push(item.id);
    }
    await page.screenshot({ path: path.join(output, `gallery-${width}.png`), animations: "disabled" });
    expect(state.errors).toEqual([]);
    expect(state.writes).toEqual([]);
    // Same real page shell as /components. New gallery link is the only intended components addition.
    const galleryWrites = [...state.writes];
    await page.goto("/components");
    await expect(page.getByTestId("components-review")).toBeVisible();
    const components = await measure(page);
    expect(components).toEqual(gallery);
    await expect(page.getByRole("link", { name: "다이얼로그 비교" })).toBeVisible();
    await page.screenshot({ path: path.join(output, `components-${width}.png`), animations: "disabled" });
    writeFileSync(
      path.join(output, `inventory-${width}.json`),
      JSON.stringify(
        {
          tested,
          gallery,
          components,
          writes: galleryWrites,
          componentsWrites: state.writes.slice(galleryWrites.length),
          errors: state.errors,
        },
        null,
        2,
      ),
    );
  });
}

test("desktop menu surfaces use their existing selectors and layout", async ({ page }) => {
  const state = await prepare(page, 1440);
  await page.goto("/dialogues");
  await expect(page.getByTestId("dialogues-review")).toBeVisible();
  for (const id of ["folder-sheet", "session-sheet"]) {
    await open(page, id);
    const menu =
      id === "folder-sheet"
        ? page.locator("div.fixed.z-50").filter({ has: page.getByRole("button", { name: "이름 변경", exact: true }) })
        : page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.screenshot({ path: path.join(output, `${id}-1440.png`), animations: "disabled" });
    await menu.hover();
    if (id === "folder-sheet") await page.mouse.move(1435, 995);
    else await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    const closeSample = page.getByRole("button", { name: "샘플 닫기", exact: true });
    if (await closeSample.isVisible()) await closeSample.click();
  }
  const gallery = await measure(page);
  await page.screenshot({ path: path.join(output, "gallery-1440.png"), animations: "disabled" });
  const galleryWrites = [...state.writes];
  await page.goto("/components");
  await expect(page.getByTestId("components-review")).toBeVisible();
  const components = await measure(page);
  expect(components).toEqual(gallery);
  await page.screenshot({ path: path.join(output, "components-1440.png"), animations: "disabled" });
  expect(state.errors).toEqual([]);
  writeFileSync(
    path.join(output, "desktop-menus.json"),
    JSON.stringify(
      {
        gallery,
        components,
        writes: galleryWrites,
        componentsWrites: state.writes.slice(galleryWrites.length),
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});

test("sample save/delete, all settings tabs and upload never write to backend", async ({ page }) => {
  const state = await prepare(page, 1440);
  await page.goto("/dialogues");
  await expect(page.getByTestId("dialogues-review")).toBeVisible();
  // Prove the recorder catches writes; this intentional test request is fully mocked.
  await page.evaluate(() => fetch("/api/recording-probe", { method: "POST" }));
  expect(state.writes).toEqual(["POST /api/recording-probe"]);
  state.writes.length = 0;
  await open(page, "settings");
  const config = page.getByRole("dialog", { name: "⚙️ 서버 설정" });
  await expect(config.getByRole("tab", { name: "실행 설정", exact: true })).toBeVisible();
  await config.getByRole("tab", { name: "실행 설정", exact: true }).click();
  await config.locator('input[type="text"]').last().fill("샘플 저장 값");
  await config.getByTestId("config-save-button").click();
  await expect(config.getByTestId("config-save-button")).toBeDisabled();
  const tabNames = await config.getByRole("tab").allTextContents();
  for (const name of tabNames) {
    console.log(`settings tab: ${name}`);
    await config.getByRole("tab", { name, exact: true }).click();
    await expect(config.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    if (name === "파일 저장소") {
      const storage = page.getByRole("region", { name: "보드 파일" });
      await storage.getByRole("button", { name: "저장", exact: true }).click();
      await expect(storage.getByRole("status")).toContainText("저장했습니다");
      await storage.getByRole("button", { name: "연결 확인", exact: true }).click();
      await expect(storage.getByRole("status")).toContainText("샘플 연결");
    }
    if (name === "카드 실행") {
      await config.getByLabel("기본값 동시 실행 상한").fill("3");
      await config.getByRole("button", { name: "저장", exact: true }).first().click();
      await expect(config.getByRole("status").first()).toContainText("저장했습니다");
    }
    if (name === "에이전트") {
      await config.getByRole("button", { name: "로젤린", exact: false }).first().click();
      await config.getByRole("button", { name: "프로필 저장", exact: true }).click();
    }
    if (name === "반복 작업") {
      await config.getByRole("button", { name: /검수 반복 작업/ }).click();
      await config.getByLabel("작업 이름", { exact: true }).fill("변경된 반복 작업");
      await config.getByRole("button", { name: "변경 저장", exact: true }).click();
      await expect(config.getByRole("button", { name: /변경된 반복 작업/ })).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await config.getByRole("button", { name: "보관", exact: true }).click();
      await expect(config.getByText("보관됨", { exact: true }).first()).toBeVisible();
    }
  }
  await config.getByRole("button", { name: "닫기", exact: true }).click();
  await open(page, "user-create");
  let editor = page.getByRole("dialog", { name: "사용자 추가", exact: true });
  await editor.getByLabel("이메일", { exact: true }).fill("created@example.invalid");
  await editor.getByLabel("이름", { exact: true }).fill("추가한 샘플 사용자");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(config.getByText("추가한 샘플 사용자", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await config.getByRole("button", { name: "Delete user", exact: true }).last().click();
  await expect(config.getByText("추가한 샘플 사용자", { exact: true })).toHaveCount(0);
  const closeConfig = config.getByRole("button", { name: "닫기", exact: true });
  if (await closeConfig.isVisible()) await closeConfig.click();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
  writeFileSync(
    path.join(output, "settings-mutations.json"),
    JSON.stringify({ tabNames, writes: state.writes, errors: state.errors }, null, 2),
  );
});

test("card, session and document mutations stay local", async ({ page }) => {
  const state = await prepare(page, 1440);
  await page.goto("/dialogues");
  await open(page, "new-session");
  await page
    .getByRole("dialog", { name: "새 세션", exact: true })
    .getByRole("button", { name: "시작", exact: true })
    .click();
  await expect(page.getByTestId("dialogue-sample")).toHaveCount(0);
  await open(page, "card-create");
  await page.getByLabel("카드 제목", { exact: true }).fill("추가한 샘플 카드");
  await page.getByLabel("요청 원문", { exact: true }).fill("운영 저장 없이 로컬 상태로 생성합니다.");
  await expect(page.getByRole("combobox", { name: "노드 선택", exact: true })).toHaveValue("sample-node");
  await expect(page.getByRole("combobox", { name: "에이전트 선택", exact: true })).toContainText("로젤린");
  await page.getByLabel("카드 저장", { exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("카드 저장");
  await open(page, "card-detail");
  await page
    .locator('[data-testid="card-detail"] input[type=file]')
    .setInputFiles({ name: "local.txt", mimeType: "text/plain", buffer: Buffer.from("로컬 파일") });
  await page.getByPlaceholder("커멘트", { exact: true }).fill("추가한 샘플 커멘트");
  await page.getByRole("button", { name: "커멘트 전송", exact: true }).click();
  await expect(page.getByText("추가한 샘플 커멘트", { exact: false }).first()).toBeVisible();
  const statusButton = page.getByRole("button", { name: "카드 상태 변경", exact: true });
  await statusButton.click();
  await page.locator('[aria-label="카드 상태 목록"]').getByRole("button", { name: "완료", exact: true }).click();
  await expect(statusButton).toContainText("완료");
  await statusButton.click();
  await page.locator('[aria-label="카드 상태 목록"]').getByRole("button", { name: "검수 대기", exact: true }).click();
  await expect(statusButton).toContainText("검수");
  await page.getByRole("button", { name: "카드 닫기", exact: true }).click();
  await open(page, "document-overlay");
  await page.screenshot({ path: path.join(output, "document-overlay-1440.png"), animations: "disabled" });
  await page.getByLabel("Document title", { exact: true }).fill("수정한 샘플 문서");
  await page.getByLabel("Document title", { exact: true }).blur();
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "문서 삭제", exact: true }).click();
  await expect(page.getByTestId("dialogue-sample")).toHaveCount(0);
  await page.waitForTimeout(1200);
  expect(state.errors).toEqual([]);
  expect(state.writes).toEqual([]);
  writeFileSync(
    path.join(output, "local-mutations.json"),
    JSON.stringify({ writes: state.writes, errors: state.errors }, null, 2),
  );
});

test("document overlay narrow width keeps the actual editor within its shell", async ({ page }) => {
  const state = await prepare(page, 390);
  await page.goto("/dialogues/");
  await open(page, "document-overlay");
  await expect(page.getByLabel("Document title", { exact: true })).toBeVisible();
  const bounds = await page.locator(".v3-folder-board-document-overlay").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  expect(bounds.documentWidth).toBe(390);
  await page.screenshot({ path: path.join(output, "document-overlay-390.png"), animations: "disabled" });
  await page.getByRole("button", { name: "문서 편집기 닫기", exact: true }).click();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
  writeFileSync(
    path.join(output, "document-overlay-390.json"),
    JSON.stringify({ bounds, writes: state.writes, errors: state.errors }, null, 2),
  );
});
