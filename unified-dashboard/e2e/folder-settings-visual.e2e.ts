/**
 * Visual and interaction check for the folder settings dialog, the folder context summary,
 * the reference picker and the new session dialog (card #1975).
 *
 *   FOLDER_SETTINGS_OUT=/abs/dir corepack pnpm -C unified-dashboard exec playwright test --config playwright.folder-settings.config.ts
 *
 * Captures go to FOLDER_SETTINGS_OUT/*.png and measurements to FOLDER_SETTINGS_OUT/measurements.json.
 */
import { expect, test, type Locator, type Page } from "./test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const out = process.env.FOLDER_SETTINGS_OUT ?? "";
if (!path.isAbsolute(out)) throw new Error("FOLDER_SETTINGS_OUT must be an absolute path");
mkdirSync(out, { recursive: true });
const measurementsFile = path.join(out, "measurements.json");

const LONG_NODE = "프로젝트 컨텍스트에서 아주 긴 노드 제목이 말줄임으로 끊기는지 확인하는 참고 자료 제목";
const atomChildren = (prefix: string) => [
  { id: `${prefix}-long`, card_id: `${prefix}-long-card`, card: { title: LONG_NODE, card_type: "knowledge" } },
  ...["시스템 아키텍처", "세션", "API 레퍼런스", "프론트엔드 아키텍처", "개발 가이드"].map((title, index) => ({
    id: `${prefix}-${index}`, card_id: `${prefix}-${index}-card`, card: { title, card_type: "knowledge" },
  })),
];

type Theme = "dark" | "light";
interface Check { name: string; ok: boolean; detail?: unknown }

async function prep(page: Page, width: number, height: number, theme: Theme) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((value) => {
    localStorage.setItem("soul-dashboard-theme", value);
    localStorage.setItem("ls.webglGlass", "0");
    if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, "register", { configurable: true, value: async () => ({ update: async () => {}, active: null, addEventListener: () => {} }) });
  }, theme);
  await installV3VisualQaRoutes(page);
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/status", (route) => route.fulfill({ json: { atom_enabled: true, is_draining: false } }));
  await page.route("**/api/atom/nodes**", (route) => {
    const match = new URL(route.request().url()).pathname.match(/nodes\/([^/]+)\/children/);
    return route.fulfill({ json: { children: atomChildren(match ? match[1]! : "root") } });
  });
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `${name}.png`), animations: "disabled" });
}

const popup = (page: Page) => page.locator('[data-slot="dialog-popup"]').last();
async function scrollDialogToEnd(page: Page) {
  await popup(page).evaluate((element) => {
    for (const candidate of element.querySelectorAll<HTMLElement>("*")) {
      if (candidate.scrollHeight > candidate.clientHeight + 1 && getComputedStyle(candidate).overflowY !== "visible") candidate.scrollTop = candidate.scrollHeight;
    }
  });
}
const footer = (page: Page) => popup(page).locator(".v3-succession-footer");

async function horizontalFit(page: Page, scope?: Locator) {
  const document = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  const box = scope ? await scope.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const overflowing = [...element.querySelectorAll<HTMLElement>("*")].filter((child) => {
      const childRect = child.getBoundingClientRect();
      return childRect.width > 0 && (childRect.right > rect.right + 1 || childRect.left < rect.left - 1);
    }).map((child) => `${child.tagName}.${child.className}`.slice(0, 80));
    return { left: rect.left, right: rect.right, innerWidth, overflowing };
  }) : null;
  return { ...document, box };
}

async function expandDisclosures(page: Page) {
  const summaries = popup(page).locator("details > summary");
  for (let index = 0; index < await summaries.count(); index++) {
    if (!await summaries.nth(index).evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await summaries.nth(index).click();
  }
}

function record(key: string, checks: Check[], extra: Record<string, unknown> = {}) {
  const current = existsSync(measurementsFile) ? JSON.parse(readFileSync(measurementsFile, "utf8")) as Record<string, unknown> : {};
  current[key] = { checks, ...extra };
  writeFileSync(measurementsFile, `${JSON.stringify(current, null, 2)}\n`);
}

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of [[1440, 1000], [360, 780]] as const) {
    const suffix = `${width}-${theme}`;

    test(`folder page summary and settings ${suffix}`, async ({ page }) => {
      const checks: Check[] = [];
      await prep(page, width, height, theme);
      await page.goto("/?folder=folder-amber");
      const summary = page.getByTestId("v3-project-context");
      await expect(summary.locator("dt")).toHaveCount(3, { timeout: 30_000 });
      await summary.scrollIntoViewIfNeeded();
      await summary.screenshot({ path: path.join(out, `summary-folder-amber-${suffix}.png`) });
      checks.push({ name: "summary rows are instructions, references, environment", ok: (await summary.locator("dt").allTextContents()).join("|") === "지침|참고 자료|기본 실행 환경" });
      await expect(summary).toContainText("로젤린 · eiaserinnys");
      checks.push({ name: "summary shows display names", ok: !(await summary.textContent())!.includes("roselin_codex") });
      checks.push({ name: "summary has a single settings button", ok: await summary.locator("button").count() === 1 });
      const summaryFit = await horizontalFit(page, summary);
      checks.push({ name: "16 summary has no horizontal overflow", ok: summaryFit.scrollWidth <= summaryFit.innerWidth && summaryFit.box!.overflowing.length === 0, detail: summaryFit });

      await page.goto("/?folder=rb-alpha");
      const childSummary = page.getByTestId("v3-project-context");
      await expect(childSummary.locator("dt")).toHaveCount(3, { timeout: 30_000 });
      await childSummary.scrollIntoViewIfNeeded();
      await childSummary.screenshot({ path: path.join(out, `summary-rb-alpha-${suffix}.png`) });

      const settings = childSummary.getByRole("button", { name: "설정" });
      await settings.click();
      await expect(popup(page).getByRole("heading", { name: "폴더 설정" })).toBeVisible();
      await expect(popup(page).locator('[data-section="references"]')).toContainText("soulstream");
      await shot(page, `settings-rb-alpha-${suffix}`);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      checks.push({ name: "14 opening settings focuses the name field", ok: focused === "이름", detail: focused });
      const settingsFit = await horizontalFit(page, popup(page));
      checks.push({ name: "16 settings dialog fits the width", ok: settingsFit.scrollWidth <= settingsFit.innerWidth && settingsFit.box!.left >= 0 && settingsFit.box!.right <= settingsFit.innerWidth && settingsFit.box!.overflowing.length === 0, detail: settingsFit });
      const sectionEdges = await popup(page).locator("fieldset[data-testid='v3-project-dialog-form'] > *").evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.right)];
      }));
      checks.push({ name: "12 form blocks share left and right edges", ok: new Set(sectionEdges.map((edge) => edge.join(","))).size === 1, detail: sectionEdges });
      const toggleRow = await popup(page).locator('[data-section="guidance"] .v3-context-section-head').evaluate((head) => {
        const [label, group] = [...head.children].map((child) => child.getBoundingClientRect());
        return { labelCenter: label!.top + label!.height / 2, groupCenter: group!.top + group!.height / 2 };
      });
      checks.push({ name: "4 section label and source toggle are vertically centred", ok: Math.abs(toggleRow.labelCenter - toggleRow.groupCenter) <= 1, detail: toggleRow });
      await scrollDialogToEnd(page);
      await shot(page, `settings-rb-alpha-bottom-${suffix}`);

      const add = popup(page).locator('[data-section="references"]').getByRole("button", { name: "추가" });
      await add.click();
      await expect(popup(page).getByRole("heading", { name: "참고 자료 추가" })).toBeVisible();
      await expect(popup(page).getByRole("button", { name: LONG_NODE })).toBeVisible();
      await shot(page, `picker-browse-${suffix}`);
      checks.push({ name: "picker has no native select, checkbox or number field", ok: await popup(page).locator("select, input[type=number], input[type=checkbox]:not([aria-hidden=true])").count() === 0 });
      await page.keyboard.press("Escape");
      checks.push({ name: "15 Esc closes the node list first and keeps the picker", ok: await popup(page).getByRole("heading", { name: "참고 자료 추가" }).isVisible() && await popup(page).getByRole("button", { name: LONG_NODE }).count() === 0 });
      await page.keyboard.press("Escape");
      await expect(popup(page).getByRole("heading", { name: "폴더 설정" })).toBeVisible();
      checks.push({ name: "14 cancelling the picker returns focus to its add button", ok: await add.evaluate((element) => element === document.activeElement) });

      await add.click();
      await popup(page).getByRole("button", { name: LONG_NODE }).click();
      await popup(page).locator(".v3-reference-picker").getByRole("button", { name: "2", exact: true }).click();
      await popup(page).locator(".v3-reference-picker [role=switch]").click();
      await shot(page, `picker-chosen-${suffix}`);
      await footer(page).getByRole("button", { name: "추가" }).click();
      const longRow = popup(page).getByRole("button", { name: `${LONG_NODE} 고치기` });
      await expect(longRow).toBeVisible();
      await longRow.scrollIntoViewIfNeeded();
      await shot(page, `settings-long-reference-${suffix}`);
      const rowFit = await longRow.evaluate((button) => {
        const title = button.querySelector("span")!;
        const row = button.closest("li")!.getBoundingClientRect();
        const remove = button.parentElement!.querySelector('button[aria-label$="빼기"]')!.getBoundingClientRect();
        return { ellipsis: getComputedStyle(title).textOverflow, truncated: title.scrollWidth > title.clientWidth, titleWidth: title.clientWidth,
          removeInside: remove.right <= row.right + 0.5 && remove.left >= row.left, metaLines: button.querySelector("small")!.getClientRects().length };
      });
      checks.push({ name: "16 long reference title truncates with an ellipsis and keeps the remove button", ok: rowFit.ellipsis === "ellipsis" && rowFit.titleWidth > 40 && rowFit.removeInside && rowFit.metaLines === 1, detail: rowFit });

      await page.keyboard.press("Escape");
      await expect(popup(page)).toHaveCount(0);
      checks.push({ name: "14 closing settings returns focus to the settings button", ok: await settings.evaluate((element) => element === document.activeElement) });
      record(`folder-${suffix}`, checks);
      expect(checks.filter((check) => !check.ok)).toEqual([]);
    });

    test(`new folder dialogs ${suffix}`, async ({ page }) => {
      await prep(page, width, height, theme);
      for (const sample of ["project-create", "project-create-child"] as const) {
        await page.goto(`/dialogues?sample=${sample}`);
        await page.getByTestId("dialogue-sample").waitFor({ timeout: 30_000 });
        await expect(popup(page).getByRole("heading", { name: "새 폴더" })).toBeVisible();
        await shot(page, `${sample}-${suffix}`);
        await scrollDialogToEnd(page);
        await shot(page, `${sample}-bottom-${suffix}`);
      }
      await expect(popup(page).locator('[data-section="guidance"]')).toContainText("검수 폴더");
    });

    test(`new session ${suffix}`, async ({ page }) => {
      const checks: Check[] = [];
      await prep(page, width, height, theme);
      await page.goto("/?folder=folder-amber");
      await page.getByRole("button", { name: "새 세션", exact: true }).first().click({ timeout: 30_000 });
      await expect(popup(page).getByRole("heading", { name: "새 세션" })).toBeVisible();
      await expect(popup(page).locator("summary").first()).toContainText("로젤린");
      await shot(page, `new-session-${suffix}`);
      await expandDisclosures(page);
      await shot(page, `new-session-expanded-${suffix}`);
      await scrollDialogToEnd(page);
      await shot(page, `new-session-bottom-${suffix}`);
      const summaryText = await popup(page).locator("summary").first().textContent();
      checks.push({ name: "environment line uses display names", ok: summaryText!.includes("로젤린 · eiaserinnys · QA 표준 모델"), detail: summaryText });
      checks.push({ name: "no nested assignment grid", ok: await popup(page).locator(".v3-succession-assignment .v3-succession-assignment").count() === 0 });
      const fit = await horizontalFit(page, popup(page));
      checks.push({ name: "16 new session fits the width", ok: fit.scrollWidth <= fit.innerWidth && fit.box!.overflowing.length === 0, detail: fit });
      record(`session-${suffix}`, checks);
      expect(checks.filter((check) => !check.ok)).toEqual([]);
    });
  }
}

test("settings load failure and resize (1440 dark)", async ({ page }) => {
  const checks: Check[] = [];
  await prep(page, 1440, 1000, "dark");
  await page.goto("/?folder=rb-alpha");
  const settings = page.getByTestId("v3-project-context").getByRole("button", { name: "설정" });
  await settings.waitFor({ timeout: 30_000 });
  const settingsLoad = (url: URL) => url.pathname === "/api/pages/task-alpha" && url.searchParams.has("include_blocks");
  await page.route(settingsLoad, (route) => route.fulfill({ status: 503, json: { detail: "unavailable" } }));
  await settings.click();
  await expect(popup(page).getByRole("alert")).toContainText("폴더 설정을 불러오지 못했습니다");
  await shot(page, "settings-load-error-1440-dark");
  checks.push({ name: "17 failed load shows an alert and keeps save disabled", ok: await footer(page).getByRole("button", { name: "저장" }).isDisabled() });
  await page.keyboard.press("Escape");
  await page.unroute(settingsLoad);

  await settings.click();
  const description = popup(page).getByRole("textbox", { name: "설명" });
  await description.fill("창 크기를 바꿔도 남아야 하는 설명");
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  await shot(page, "settings-resized-360-dark");
  const fit = await horizontalFit(page, popup(page));
  checks.push({ name: "18 resized dialog fits the narrow width and keeps typed text", ok: fit.box!.right <= 360 && fit.box!.left >= 0 && await description.inputValue() === "창 크기를 바꿔도 남아야 하는 설명", detail: fit });
  record("load-error-resize", checks);
  expect(checks.filter((check) => !check.ok)).toEqual([]);
});
