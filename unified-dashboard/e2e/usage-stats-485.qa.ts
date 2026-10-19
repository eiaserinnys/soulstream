import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const captureDir = resolve(process.env.USAGE_STATS_CAPTURE_DIR ?? "../.local/artifacts/usage-stats-485");

test("settings statistics support date, filters, detail, keyboard, and narrow layout", async ({ page }) => {
  mkdirSync(captureDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/frame.html?state=normal&theme=light&glass=css");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "세션 통계" })).toBeVisible();
  await expect(page.getByText("10월 12일 ~ 18일")).toBeVisible();
  await expect(page.locator(".config-footer").getByRole("button")).toHaveCount(1);
  await expect(page.locator(".config-footer").getByRole("button", { name: "완료" })).toBeVisible();
  await expect(page.locator(".config-save-state")).toBeEmpty();

  const modelField = page.getByRole("combobox", { name: "모델" });
  await modelField.click();
  await page.getByRole("option", { name: "Kimi", exact: true }).click();
  await page.getByRole("group", { name: "표시 값" }).getByRole("button", { name: "정가" }).click();
  await expect(page.getByText("정가 미확인").first()).toBeVisible();
  await modelField.click();
  await page.getByRole("option", { name: "모든 모델", exact: true }).click();

  const friday = page.locator(".usage-stats-chart-column[aria-label*='10월 16일']").first();
  await friday.click();
  await expect(page.locator(".usage-stats-date-chip")).toHaveText("10월 16일 (금)");
  await expect(page.getByText("툴 호출 312회")).toBeVisible();
  await expect(page.getByText("하네스 내부 입력")).toBeVisible();
  await expect(page.getByText("1,132,000자")).toBeVisible();
  await expect(page.getByText("관측 안 됨").first()).toBeVisible();
  const visibleSegment = page.locator(".usage-stats-stack-segment").first();
  await expect(visibleSegment).toBeVisible();
  const segmentStyle = await visibleSegment.evaluate(element => ({
    height: element.getBoundingClientRect().height,
    background: getComputedStyle(element).backgroundColor,
  }));
  expect(segmentStyle.height).toBeGreaterThan(0);
  expect(segmentStyle.background).not.toBe("rgba(0, 0, 0, 0)");

  await friday.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".usage-stats-date-chip")).toHaveText("10월 17일 (토)");
  await expect(page.locator(".usage-stats-input-total")).toHaveText("관측 안 됨");
  await page.keyboard.press("Escape");
  await expect(page.locator(".usage-stats-date-chip")).toHaveCount(0);

  const monday = page.locator(".usage-stats-chart-column[aria-label*='10월 12일']").first();
  const dragFriday = page.locator(".usage-stats-chart-column[aria-label*='10월 16일']").first();
  const mondayBounds = await monday.boundingBox();
  const fridayBounds = await dragFriday.boundingBox();
  if (!mondayBounds || !fridayBounds) throw new Error("날짜 막대를 찾지 못했습니다.");
  const plotY = mondayBounds.y + mondayBounds.height / 2;
  await page.mouse.move(mondayBounds.x + mondayBounds.width / 2, plotY);
  await page.mouse.down();
  await page.mouse.move(fridayBounds.x + fridayBounds.width / 2, plotY, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".usage-stats-date-chip")).toHaveText("10월 16일 (금)");
  await page.locator(".usage-stats-date-chip").click();

  const projectField = page.getByRole("combobox", { name: "프로젝트" });
  await projectField.click();
  await page.getByRole("option", { name: "웹 대시보드", exact: true }).click();
  await expect(projectField).toHaveText("웹 대시보드");
  await expect(page.getByRole("button", { name: /^Kimi / })).toContainText("미기록");
  await projectField.click();
  await page.getByRole("option", { name: "모든 프로젝트", exact: true }).click();

  await page.getByRole("group", { name: "통계 기간" }).getByRole("button", { name: "전체" }).click();
  await page.getByRole("button", { name: /2026년 9월,/ }).first().click();
  await expect(page.getByRole("group", { name: "통계 기간" }).getByRole("button", { name: "월간" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2026년 9월")).toBeVisible();
  await page.getByRole("button", { name: "다음 기간" }).click();
  await expect(page.getByText("2026년 10월")).toBeVisible();

  await page.getByRole("group", { name: "통계 기간" }).getByRole("button", { name: "주간" }).click();
  const selectedFriday = page.locator(".usage-stats-chart-column[aria-label*='10월 16일']").first();
  await selectedFriday.click();
  await expect(page.getByText("하네스 내부 입력")).toBeVisible();
  await page.screenshot({ path: resolve(captureDir, "usage-stats-web-wide.png"), fullPage: true });
  await page.locator(".usage-stats-input-material").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(captureDir, "usage-stats-web-wide-input.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".usage-stats-chart-plot").first().scrollIntoViewIfNeeded();
  const scrollSurface = page.locator('[data-slot="dialog-panel-scroll"]');
  const previousScroll = await scrollSurface.evaluate(element => element.scrollTop);
  const plotBounds = await page.locator(".usage-stats-chart-plot").first().boundingBox();
  if (!plotBounds) throw new Error("통계 그래프가 화면에 없습니다.");
  await page.mouse.move(plotBounds.x + plotBounds.width / 2, plotBounds.y + plotBounds.height / 2);
  await page.mouse.wheel(0, 320);
  await expect.poll(() => scrollSurface.evaluate(element => element.scrollTop)).toBeGreaterThan(previousScroll);
  await page.getByText("하네스 내부 입력").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(captureDir, "usage-stats-web-narrow.png"), fullPage: true });
  const modal = page.locator(".config-dialog");
  const bounds = await modal.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  expect(bounds?.x).toBeGreaterThanOrEqual(0);

  const unmocked = await page.evaluate(() => (window as Window & { __mockupUnmocked: string[] }).__mockupUnmocked);
  expect(unmocked).toEqual([]);
});

test("empty, backfill, failed, forbidden, and loading responses stay distinct", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/frame.html?state=empty&theme=light&glass=css");
  await expect(page.getByText("이 기간에 기록이 없습니다").first()).toBeVisible();
  await expect(page.getByText("0", { exact: true }).first()).toBeVisible();

  await page.goto("/frame.html?state=backfilling&theme=light&glass=css");
  await expect(page.getByText("이전 기록 정리 중")).toBeVisible();

  await page.goto("/frame.html?state=error&theme=light&glass=css");
  await expect(page.getByText("통계를 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 불러오기" })).toBeVisible();

  await page.goto("/frame.html?state=forbidden&theme=light&glass=css");
  await expect(page.getByText("이 통계를 볼 권한이 없습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 불러오기" })).toHaveCount(0);

  await page.goto("/frame.html?state=loading&theme=light&glass=css");
  await expect(page.getByText("불러오는 중…").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Claude / }).first()).toBeVisible({ timeout: 15_000 });
});

test("repeated drag movement over one selected bucket keeps it selected", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/frame.html?state=normal&theme=light&glass=css");
  const friday = page.locator(".usage-stats-chart-plot").first().locator(".usage-stats-chart-column[aria-label*='10월 16일']");
  await friday.click();
  await expect(page.locator(".usage-stats-date-chip")).toHaveText("10월 16일 (금)");
  const bounds = await friday.boundingBox();
  if (!bounds) throw new Error("선택한 날짜 막대를 찾지 못했습니다.");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 7, y, { steps: 1 });
  for (let step = 1; step <= 4; step += 1) await page.mouse.move(x + 7 + step, y, { steps: 1 });
  await page.mouse.up();
  await expect(page.locator(".usage-stats-date-chip")).toHaveText("10월 16일 (금)");
});

test("unpriced points stay unknown and do not mark complete token totals partial", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/frame.html?state=normal&theme=light&glass=css");
  const modelField = page.getByRole("combobox", { name: "모델" });
  await modelField.click();
  await page.getByRole("option", { name: "Kimi", exact: true }).click();

  const tokenTotal = page.locator(".usage-stats-summary-metric").first().locator("strong");
  await expect(tokenTotal).not.toContainText("+");
  await page.getByRole("group", { name: "표시 값" }).getByRole("button", { name: "정가" }).click();
  const chart = page.locator(".usage-stats-chart").first();
  await expect(chart.locator(".usage-stats-chart-message")).toHaveText("정가 미확인");
  await expect(chart.getByText("이 기간에 기록이 없습니다")).toHaveCount(0);
  const friday = chart.locator(".usage-stats-chart-column[aria-label*='10월 16일']");
  await expect(friday).toHaveAttribute("aria-label", /정가 미확인/);
  await page.screenshot({ path: resolve(captureDir, "usage-stats-web-unpriced.png"), fullPage: true });
});

test("charts preserve unknown tokens and known zero cost", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/frame.html?state=unknown_tokens&theme=light&glass=css");
  const chart = page.locator(".usage-stats-chart").first();
  await expect(chart.locator(".usage-stats-chart-message")).toHaveText("미기록");
  await expect(chart.locator(".usage-stats-axis-label")).toHaveText("미기록");
  await expect(chart.locator(".usage-stats-chart-column[aria-label*='10월 16일']")).toHaveAttribute("aria-label", /미기록/);
  await expect(chart.locator(".usage-stats-stack")).toHaveCount(0);

  const modelField = page.getByRole("combobox", { name: "모델" });
  await modelField.click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await page.getByRole("group", { name: "표시 값" }).getByRole("button", { name: "정가" }).click();
  const zeroCostDay = chart.locator(".usage-stats-chart-column[aria-label*='10월 15일']");
  await expect(zeroCostDay).toHaveAttribute("aria-label", /\$0\.00/);
  await expect(zeroCostDay.locator(".usage-stats-stack")).toHaveCount(0);
  await expect(chart.locator(".usage-stats-chart-message")).toHaveCount(0);
});

test("monthly columns keep visible bars at a 390px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/frame.html?state=normal&theme=light&glass=css");
  await page.getByRole("group", { name: "통계 기간" }).getByRole("button", { name: "월간" }).click();
  const plot = page.locator(".usage-stats-chart-plot").first();
  await expect(plot.locator(".usage-stats-chart-column")).toHaveCount(31);
  const octoberTwelve = plot.locator(".usage-stats-chart-column[aria-label*='10월 12일']");
  const bar = octoberTwelve.locator(".usage-stats-stack");
  await expect(bar).toBeVisible();
  const bounds = await bar.boundingBox();
  expect(bounds?.width).toBeGreaterThan(0);
  await plot.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(captureDir, "usage-stats-web-month-390.png"), fullPage: true });
});

test("project row colors stay attached to the project across date detail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/frame.html?state=normal&theme=light&glass=css");
  const overviewRow = page.getByRole("button", { name: /^웹 대시보드/ });
  const overviewColor = await overviewRow.locator(".usage-stats-share-fill").evaluate(element => getComputedStyle(element).backgroundColor);
  const friday = page.locator(".usage-stats-chart-plot").first().locator(".usage-stats-chart-column[aria-label*='10월 16일']");
  await friday.click();
  const detailRow = page.getByRole("button", { name: /^웹 대시보드/ });
  await expect(detailRow).toBeVisible();
  const detailColor = await detailRow.locator(".usage-stats-share-fill").evaluate(element => getComputedStyle(element).backgroundColor);
  expect(detailColor).toBe(overviewColor);
});
