import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { reviewCard, reviewDetail } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/20261005-card-color-web");
const reviewOutput = path.resolve("../.local/artifacts/20261005-ux-color-review");
mkdirSync(output, { recursive: true });
mkdirSync(reviewOutput, { recursive: true });

async function prepare(page: Page, width: number, rejectNextWrite = false) {
  const card: CardRow = {
    ...reviewCard,
    id: "card-color-qa",
    folderId: "folder-amber",
    title: "포스트잇 색상 검증",
    status: "review",
    assigneeSessionId: "run-alpha-1",
    color: "yellow",
    version: 1,
  };
  const detail: CardDetail = { ...reviewDetail, card, reports: [], comments: [], questions: [], sessions: [] };
  const writes: Array<{ color: unknown; expectedVersion: unknown; idempotencyKey: unknown }> = [];
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "light");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, postitCards: [card] });
  await page.route(/\/api\/cards\/card-color-qa(?:\/.*)?$/, async route => {
    const url = new URL(route.request().url());
    const suffix = url.pathname.slice("/api/cards/card-color-qa".length);
    const method = route.request().method();
    if (method === "GET" && suffix === "") {
      await route.fulfill({ json: detail });
      return;
    }
    if (method === "PATCH" && suffix === "") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ color: payload.color, expectedVersion: payload.expectedVersion, idempotencyKey: payload.idempotencyKey });
      if (rejectNextWrite) {
        rejectNextWrite = false;
        await route.fulfill({ status: 409, json: { message: "다른 화면에서 카드가 변경되어 색상을 저장하지 못했습니다. 최신 내용을 다시 불러온 다음 원하는 색상을 다시 선택해 주세요. 최신 카드의 버전을 확인하고 다시 시도해 주세요. ".repeat(3) } });
        return;
      }
      if (payload.expectedVersion !== card.version) {
        await route.fulfill({ status: 409, json: { error: "version mismatch" } });
        return;
      }
      card.color = payload.color as CardRow["color"];
      card.version += 1;
      detail.card = card;
      await route.fulfill({ json: detail });
      return;
    }
    await route.fulfill({ status: 405, json: { error: "unhandled fixture operation" } });
  });
  await page.goto("/");
  const paper = page.locator('article.v3-postit-card[data-card-id="card-color-qa"]');
  await expect(paper).toBeVisible();
  return { paper, card, writes };
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}

async function captureReview(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(reviewOutput, `${name}.png`), animations: "disabled" });
}

async function expectPickerInsideViewport(page: Page, width: number) {
  const picker = page.locator("[data-card-status-picker][data-open]");
  await expect(picker).toBeVisible();
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  return picker;
}

for (const width of [390, 1440]) test(`stored card colors from list and detail at ${width}px`, async ({ page }) => {
  const state = await prepare(page, width);
  const { paper, writes } = state;
  if (width === 1440) {
    await paper.locator(".v3-postit-open").click({ button: "right" });
    await page.getByRole("menuitem", { name: "카드 색상 변경", exact: true }).click();
  } else {
    await paper.getByRole("button", { name: "카드 상태 변경" }).click();
    await page.locator("[data-card-status-picker]").getByRole("button", { name: "카드 색상: 노랑", exact: true }).click();
  }
  let picker = await expectPickerInsideViewport(page, width);
  await expect(picker.getByRole("button", { name: "연분홍", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(picker.getByRole("button", { name: "민트", exact: true })).toBeVisible();
  await expect(picker.getByRole("button", { name: "하늘", exact: true })).toBeVisible();
  await expect(picker.getByRole("button", { name: "연보라", exact: true })).toBeVisible();
  await capture(page, `list-color-picker-${width}`);
  await picker.getByRole("button", { name: "연분홍", exact: true }).click();
  await expect(paper).toHaveAttribute("data-card-color", "pink");
  expect(await paper.evaluate(node => getComputedStyle(node).getPropertyValue("--postit-paper").trim())).toBe("#ffede8");
  expect(writes[0]).toMatchObject({ color: "pink", expectedVersion: 1 });
  expect(writes[0].idempotencyKey).toEqual(expect.any(String));

  await paper.locator(".v3-postit-open").click();
  const detailPane = page.getByTestId("card-detail");
  await expect(detailPane).toBeVisible();
  await detailPane.getByRole("button", { name: "카드 상태 변경" }).click();
  await page.locator("[data-card-status-picker]").getByRole("button", { name: "카드 색상: 연분홍", exact: true }).click();
  picker = await expectPickerInsideViewport(page, width);
  await expect(picker.getByRole("button", { name: "연분홍", exact: true })).toHaveAttribute("aria-pressed", "true");
  await capture(page, `detail-color-picker-${width}`);
  await picker.getByRole("button", { name: "민트", exact: true }).click();
  await expect(paper).toHaveAttribute("data-card-color", "mint");
  expect(writes[1]).toMatchObject({ color: "mint", expectedVersion: 2 });

  await detailPane.getByRole("button", { name: "카드 상태 변경" }).click();
  await expect(page.locator("[data-card-status-picker]").getByRole("button", { name: "카드 색상: 민트", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "카드 닫기", exact: true }).click();
  await expect(paper).toHaveAttribute("data-card-color", "mint");
  await paper.locator(".v3-postit-open").click();
  await expect(page.getByTestId("card-detail")).toBeVisible();
  await page.getByTestId("card-detail").getByRole("button", { name: "카드 상태 변경" }).click();
  await expect(page.locator("[data-card-status-picker]").getByRole("button", { name: "카드 색상: 민트", exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  if (width === 1440) {
    await page.goto("/components");
    const samples = page.getByTestId("postit-card-samples");
    await samples.scrollIntoViewIfNeeded();
    const colors = await samples.locator("article.v3-postit-card").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.cardColor));
    expect(new Set(colors)).toEqual(new Set(["yellow", "pink", "mint", "blue", "lavender"]));
    await capture(page, "review-sample-1440");
    const sample = samples.locator("article.v3-postit-card").first();
    await sample.getByRole("button", { name: "카드 상태 변경" }).click();
    await page.locator("[data-card-status-picker]").getByRole("button", { name: "카드 색상: 노랑", exact: true }).click();
    await page.locator("[data-card-status-picker]").getByRole("button", { name: "연보라", exact: true }).click();
    await expect(sample).toHaveAttribute("data-card-color", "lavender");
  }
});

for (const width of [390, 1440]) test(`color picker focus and selection indicator at ${width}px`, async ({ page }) => {
  const { paper } = await prepare(page, width);
  let picker;
  if (width === 1440) {
    await paper.locator(".v3-postit-open").click({ button: "right" });
    await page.getByRole("menuitem", { name: "카드 색상 변경", exact: true }).click();
    picker = page.locator("[data-card-status-picker][data-open]");
  } else {
    await paper.getByRole("button", { name: "카드 상태 변경" }).click();
    const colorEntry = page.locator("[data-card-status-picker]").getByRole("button", { name: "카드 색상: 노랑", exact: true });
    await colorEntry.focus();
    await page.keyboard.press("Enter");
    picker = page.locator("[data-card-status-picker][data-open]");
  }
  await expect(picker).toBeVisible();
  const yellow = picker.getByRole("button", { name: "노랑", exact: true });
  await expect(yellow).toHaveAttribute("aria-pressed", "true");
  await expect(yellow).toBeFocused();
  await expect(yellow.locator("svg[aria-hidden=true]")).toHaveCount(1);
  await expect(picker).toHaveClass(/glass-strong/);
  await expect(picker).toHaveClass(/glass-chrome/);
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1001);
  await captureReview(page, `color-focus-${width}`);
  if (width === 390) {
    for (const label of ["연분홍", "민트", "하늘", "연보라", "돌아가기"]) {
      await page.keyboard.press("Tab");
      await expect(picker.getByRole("button", { name: label, exact: true })).toBeFocused();
    }
  } else {
    await page.goto("/components");
    const sample = page.getByTestId("postit-card-samples").locator("article.v3-postit-card").first();
    await sample.getByRole("button", { name: "카드 상태 변경" }).click();
    await page.locator("[data-card-status-picker][data-open]").getByRole("button", { name: "카드 색상: 노랑", exact: true }).click();
    const samplePicker = page.locator("[data-card-status-picker][data-open]");
    const selectedSampleColor = samplePicker.getByRole("button", { name: "노랑", exact: true });
    await expect(selectedSampleColor).toBeFocused();
    await expect(selectedSampleColor.locator("svg[aria-hidden=true]")).toHaveCount(1);
    await expect(samplePicker).toHaveClass(/glass-strong/);
    await captureReview(page, "components-review-color-picker-1440");
  }
});

test("detail conflict keeps the color picker readable at 390px", async ({ page }) => {
  const { paper } = await prepare(page, 390, true);
  await paper.locator(".v3-postit-open").click();
  const detailPane = page.getByTestId("card-detail");
  await expect(detailPane).toBeVisible();
  await detailPane.getByRole("button", { name: "카드 상태 변경" }).click();
  const statusPopup = page.locator("[data-card-status-picker][data-open]");
  await statusPopup.getByRole("button", { name: "카드 색상: 노랑", exact: true }).click();
  const picker = page.locator("[data-card-status-picker][data-open]");
  await picker.getByRole("button", { name: "민트", exact: true }).click();
  await expect(picker.getByRole("alert")).toBeVisible();
  await expect(picker.getByRole("button", { name: "민트", exact: true })).toBeDisabled();
  await expect(picker.getByRole("button", { name: "갱신 후 재시도", exact: true })).toBeVisible();
  await expect(picker).toHaveClass(/glass-strong/);
  await expect(picker).toHaveClass(/glass-chrome/);
  const surfaces = await picker.evaluate(node => {
    const style = getComputedStyle(node);
    const resolveColor = (value: string) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    };
    return {
      background: style.backgroundColor,
      strong: resolveColor(style.getPropertyValue("--glass-surface-strong")),
      dense: resolveColor(style.getPropertyValue("--v3-glass-dense")),
      cardSurface: resolveColor(style.getPropertyValue("--lg-card")),
    };
  });
  expect(surfaces.background).toBe(surfaces.cardSurface);
  expect(surfaces.strong).toBe(surfaces.dense);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => {
    const box = await picker.boundingBox();
    return box !== null && box.x >= 0 && box.x + box.width <= 391 && box.y >= 0 && box.y + box.height <= 1001;
  }).toBe(true);
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  await captureReview(page, "color-error-surface-390");
});
