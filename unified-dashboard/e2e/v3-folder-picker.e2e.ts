import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4187";
const output = path.resolve(process.env.FOLDER_PICKER_OUTPUT ?? ".local/artifacts/folder-picker-260930");
const before = process.env.FOLDER_PICKER_PHASE === "before";
mkdirSync(output, { recursive: true });

test("session move waits for confirmation", async ({ page }) => {
  await prepare(page);
  const writes: unknown[] = [];
  await page.route("**/api/board-items/**/folder", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, boardItem: { id: "session:run-alpha-1", folderId: body.folderId } }) });
  });
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "소울스트림 펼치기" }).click();
  await page.getByTestId("v3-starred-tasks").getByRole("button", { name: fixtureTitles.primaryTask, exact: true }).click();
  const session = page.locator('.v3-detail-scroll [data-session-id="run-alpha-1"]');
  await session.click({ button: "right" });
  await page.getByRole("menuitem", { name: "다른 폴더로 이동" }).click();
  const dialog = page.getByRole("dialog", { name: "다른 폴더로 이동" });
  await verifyPicker(page, dialog, "session");
  if (before) return;
  await dialog.getByRole("tab", { name: "전체", exact: true }).click();
  await dialog.getByRole("button", { name: "Soulstream 운영", exact: true }).click();
  await expect(dialog.locator('[data-folder-id="folder-ops"]')).toHaveAttribute("aria-selected", "true");
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "이동", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ folderId: "folder-ops" });
  await expect(session).toHaveCount(0);
});

test("parent move disables current parent, self and descendants", async ({ page }) => {
  await prepare(page);
  const writes: unknown[] = [];
  await page.route("**/api/folders/folder-dashboard", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const body = route.request().postDataJSON();
    writes.push(body);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ folder: {
      id: "folder-dashboard", name: "대시보드", projectPageId: "project-dashboard", parentFolderId: body.parentFolderId,
      status: "open", archived: false, sortOrder: 0, version: 2,
    }, idempotent: false }) });
  });
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "소울스트림 펼치기" }).click();
  await page.getByTestId("v3-project-row-folder-amber").getByRole("button", { name: "소울스트림", exact: true }).click();
  const child = page.getByTestId("v3-child-folder-folder-dashboard");
  await child.locator('button[aria-label$="관리 메뉴"]').click();
  await page.getByRole("menuitem", { name: "다른 폴더로 이동" }).click();
  const dialog = page.getByRole("dialog", { name: "다른 프로젝트로 이동" });
  await verifyPicker(page, dialog, "parent");
  if (before) return;
  await dialog.getByRole("tab", { name: "전체", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "소울스트림", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "소울스트림 펼치기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "대시보드", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "대시보드 펼치기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: fixtureTitles.secondaryTask, exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Soulstream 운영", exact: true }).click();
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "이동", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ parentFolderId: "folder-ops", expectedVersion: 1 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

async function prepare(page: Page) {
  page.on("pageerror", (error) => { console.error("PAGE ERROR", error.message); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, nestedSubfolder: true });
}

async function verifyPicker(page: Page, dialog: Locator, kind: string) {
  await expect(dialog).toBeVisible();
  if (before) {
    await page.screenshot({ path: path.join(output, `${kind}-before-wide.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, `${kind}-before-narrow.png`), animations: "disabled" });
    return;
  }
  await expect(dialog.getByRole("tab", { name: "별표", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("treeitem")).toHaveCount(1);
  await page.screenshot({ path: path.join(output, `${kind}-starred-wide.png`), animations: "disabled" });
  await dialog.getByRole("tab", { name: "전체", exact: true }).click();
  await expect(dialog.getByRole("treeitem")).toHaveCount(2);
  await page.screenshot({ path: path.join(output, `${kind}-all-collapsed-wide.png`), animations: "disabled" });
  await dialog.getByRole("searchbox").fill("대시보드");
  await expect(dialog.getByRole("treeitem")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "소울스트림 접기" })).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: path.join(output, `${kind}-search-wide.png`), animations: "disabled" });
  const metrics = await page.evaluate(() => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
    const popup = document.querySelector('[role="dialog"]')!;
    return {
      navigation: [...document.querySelectorAll('#root .v3-navigation .v3-project-nav-row')].map(rect),
      navigationLabels: [...document.querySelectorAll('#root .v3-navigation .v3-project-nav-link')].map(rect),
      picker: [...popup.querySelectorAll('.v3-folder-picker-row')].map(rect),
      pickerLabels: [...popup.querySelectorAll('.v3-project-nav-link')].map(rect),
      edges: [popup.querySelector('.v3-folder-picker-tabs')!, popup.querySelector('[data-slot="input-control"]')!, popup.querySelector('.v3-folder-picker-scroll')!].map(rect),
    };
  });
  expect(metrics.picker.every((row) => Math.abs(row.height - metrics.navigation[0]!.height) <= 1)).toBe(true);
  expect(metrics.picker[1]!.x - metrics.picker[0]!.x).toBe(0);
  expect(metrics.pickerLabels[1]!.x - metrics.pickerLabels[0]!.x).toBe(20);
  expect(metrics.pickerLabels[0]!.x - metrics.picker[0]!.x)
    .toBe(metrics.navigationLabels[0]!.x - metrics.navigation[0]!.x);
  expect(Math.max(...metrics.edges.map((r) => r.x)) - Math.min(...metrics.edges.map((r) => r.x))).toBeLessThanOrEqual(1);
  expect(Math.max(...metrics.edges.map((r) => r.right)) - Math.min(...metrics.edges.map((r) => r.right))).toBeLessThanOrEqual(1);
  writeFileSync(path.join(output, `${kind}-metrics.json`), JSON.stringify(metrics, null, 2));
  await dialog.getByRole("searchbox").fill("");
  await expect(dialog.getByRole("treeitem")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: path.join(output, `${kind}-after-narrow.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
}
