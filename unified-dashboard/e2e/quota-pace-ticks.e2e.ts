/**
 * 카드 #1510 시각 검수: 7일 사용량 바의 칸막이 여섯 개와 지난 자리 커서.
 *
 * 웹 /components 의 Claude 계정 풀 샘플과, 내보낸 소울 앱 검수 번들(아이폰 폭)을
 * 넓은 폭과 360px 에서 열어 칸막이 자리와 커서 x 를 잰다. 시안은
 * .local/card1510-mockup/ 이고 캡처는 .local/card1510-captures/ 에 남긴다.
 */
import { expect, test, type Page } from "./test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// 캡처는 워크트리 .local/card1510-captures/ 아래에 남긴다(카드 #1510 발주).
const output = path.resolve("..", ".local/card1510-captures");
mkdirSync(output, { recursive: true });

type BarMetric = {
  account: string;
  label: string;
  usedPercent: number;
  mask: string;
  track: { x: number; y: number; width: number; height: number };
  elapsed: number | null;
  cursor: { centerX: number; centerY: number; width: number; height: number } | null;
  tickPercents: number[];
  transparentStops: number;
};

async function measureWebBars(page: Page): Promise<BarMetric[]> {
  return page.evaluate(() => {
    const bars = Array.from(document.querySelectorAll<HTMLElement>(".c724-quota-bar"));
    return bars.map((bar) => {
      const cell = bar.closest<HTMLElement>(".c724-quota-cell");
      const row = bar.closest<HTMLElement>(".c724-account-row");
      const track = bar.querySelector<HTMLElement>(".c724-quota-track--week");
      if (!cell || !track) throw new Error("7일 바의 셀과 트랙을 찾지 못했습니다.");
      const box = track.getBoundingClientRect();
      const style = getComputedStyle(track);
      const mask = style.maskImage !== "none" ? style.maskImage : style.getPropertyValue("-webkit-mask-image");
      const elapsed = Number.parseFloat(bar.style.getPropertyValue("--c724-quota-elapsed"));
      const cursorElement = bar.querySelector<HTMLElement>(".c724-quota-pace-cursor");
      const cursorBox = cursorElement?.getBoundingClientRect() ?? null;
      return {
        account: row?.querySelector(".c724-account-email")?.textContent
          ?? row?.getAttribute("data-provider-id") ?? "",
        label: cell.querySelector(".c724-quota-name")?.textContent ?? "",
        usedPercent: Number.parseFloat(cell.querySelector(".c724-quota-pct")?.textContent ?? "NaN"),
        mask,
        track: { x: box.x, y: box.y, width: box.width, height: box.height },
        elapsed: Number.isFinite(elapsed) ? elapsed : null,
        cursor: cursorBox ? {
          centerX: cursorBox.x + cursorBox.width / 2,
          centerY: cursorBox.y + cursorBox.height / 2,
          width: cursorBox.width,
          height: cursorBox.height,
        } : null,
        tickPercents: [...mask.matchAll(/([\d.]+)%/g)].map((match) => Number(match[1])),
        transparentStops: (mask.match(/transparent|rgba\(0, 0, 0, 0\)/g) ?? []).length,
      };
    });
  });
}

const WEEK_TICKS = [1, 2, 3, 4, 5, 6].map((k) => (k * 100) / 7);

function checkWeekBar(bar: BarMetric) {
  // 칸막이 여섯 개가 k/7 에 서고, 트랙과 채움을 함께 투명하게 오려 낸다.
  // 칸막이 하나는 투명 정지점 두 개(시작·끝)로 그려진다.
  expect(bar.transparentStops / 2, `${bar.account} ${bar.label}: 투명 칸막이 여섯 개`).toBe(6);
  const stops = WEEK_TICKS.map((expected) => Math.min(
    ...bar.tickPercents.map((percent) => Math.abs(percent - expected)),
  ));
  for (const [index, distance] of stops.entries()) {
    expect(distance, `${bar.account} ${bar.label}: ${index + 1}/7 칸막이`).toBeLessThan(0.05);
  }
  if (bar.cursor === null) {
    expect(bar.elapsed, `${bar.account} ${bar.label}: 커서가 없으면 지난 비율도 없다`).toBeNull();
    return;
  }
  expect(bar.elapsed).not.toBeNull();
  const expectedX = bar.track.x + bar.elapsed! * bar.track.width;
  expect(Math.abs(bar.cursor.centerX - expectedX),
    `${bar.account} ${bar.label}: 커서 x`).toBeLessThan(1);
  expect(bar.cursor.width).toBeGreaterThanOrEqual(1.5);
  expect(bar.cursor.width).toBeLessThanOrEqual(2.5);
  expect(bar.cursor.height).toBeGreaterThanOrEqual(11);
  expect(bar.cursor.height).toBeLessThanOrEqual(13);
  expect(Math.abs(bar.cursor.centerY - (bar.track.y + bar.track.height / 2)),
    `${bar.account} ${bar.label}: 커서 세로 가운데`).toBeLessThan(0.6);
}

async function countBarsOutsideWeekly(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const offenders: string[] = [];
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>(".c724-quota-cell"))) {
      const label = cell.querySelector(".c724-quota-name")?.textContent ?? "";
      if (label === "7일" || label === "Fable") continue;
      if (cell.querySelector(".c724-quota-bar, .c724-quota-pace-cursor")) offenders.push(label);
    }
    return offenders;
  });
}

async function prepareComponents(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1100 });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
  await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
}

for (const width of [1440, 360]) {
  test(`weekly quota bars keep six dividers and the elapsed cursor at ${width}px`, async ({ page }, testInfo) => {
    await prepareComponents(page, width);
    await page.goto("/components?sample=claude-accounts&state=pool");
    const sample = page.getByTestId("claude-account-review-sample");
    await expect(sample).toBeVisible({ timeout: 30_000 });
    // 노드 카드를 펼쳐야 공급자 패널이 나온다. 계정 목록과 요약이 비동기로 붙는다.
    await page.getByTestId("node-card").getByText("sample-provider-pool", { exact: true }).click();
    await expect(page.locator(".c724-quota-bar")).toHaveCount(5, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);

    // 풀 접힘 줄: 7일과 Fable 두 바가 커서와 함께 선다.
    const folded = await measureWebBars(page);
    expect(folded.map((bar) => bar.label).sort()).toEqual(["7일", "7일", "7일", "7일", "Fable"].sort());
    for (const bar of folded) checkWeekBar(bar);
    expect(await countBarsOutsideWeekly(page)).toEqual([]);

    // 계정을 펼쳐 검수 상태 네 가지를 잰다.
    await page.getByRole("button", { name: "계정 펼치기", exact: true }).first().click();
    await expect(page.getByTestId("claude-pool-row").getByRole("button", { name: "계정 접기", exact: true }).first()).toBeVisible();
    await expect(page.locator(".c724-quota-bar")).toHaveCount(7, { timeout: 10_000 });
    const expanded = await measureWebBars(page);
    expect(expanded).toHaveLength(7);
    for (const bar of expanded) checkWeekBar(bar);
    expect(await countBarsOutsideWeekly(page)).toEqual([]);

    const find = (account: string, label: string) => {
      const bar = expanded.find((entry) => entry.account === account && entry.label === label);
      expect(bar, `${account} ${label}`).toBeTruthy();
      return bar!;
    };
    const fast = find("director@example.com", "7일");
    expect(fast.usedPercent).toBe(72);
    expect(Math.abs(fast.elapsed! - 0.5)).toBeLessThan(0.005);
    const easy = find("director@example.com", "Fable");
    expect(easy.usedPercent).toBe(20);
    expect(Math.abs(easy.elapsed! - 0.6)).toBeLessThan(0.005);
    const onPace = find("director.sub@example.com", "7일");
    expect(onPace.usedPercent).toBe(48);
    expect(Math.abs(onPace.elapsed! - 0.5)).toBeLessThan(0.005);
    const unknownReset = find("director.sub@example.com", "Fable");
    expect(unknownReset.usedPercent).toBe(46);
    expect(unknownReset.cursor).toBeNull();
    expect(unknownReset.transparentStops / 2).toBe(6);

    // 조작 항목: 14 초점, 15 탭, 16 좁은 폭, 18 창 크기.
    const toggle = page.getByRole("button", { name: "계정 접기", exact: true }).first();
    await toggle.focus();
    await page.keyboard.press("Tab");
    const focusAfterTab = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "",
      isBar: Boolean(document.activeElement?.closest(".c724-quota-bar")),
    }));
    expect(focusAfterTab.isBar).toBe(false);
    const focusables = await page.evaluate(() => document.querySelectorAll(
      ".c724-quota-bar [tabindex], .c724-quota-pace-cursor[tabindex], .c724-quota-bar button, .c724-quota-bar a",
    ).length);
    expect(focusables).toBe(0);
    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);

    // 넓은 폭으로 돌아가도 커서 자리가 그대로다(창 크기 바꾸기).
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => document.fonts.ready);
    const resized = await measureWebBars(page);
    for (const before of expanded) {
      const after = resized.find((bar) => bar.account === before.account && bar.label === before.label);
      expect(after, `${before.account} ${before.label} after resize`).toBeTruthy();
      if (before.elapsed === null) expect(after!.elapsed).toBeNull();
      else expect(Math.abs(after!.elapsed! - before.elapsed)).toBeLessThan(0.005);
      expect(after!.cursor === null).toBe(before.cursor === null);
    }
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(() => document.fonts.ready);

    await sample.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `web-pace-${width}.png`), animations: "disabled" });
    if (width === 1440) {
      const rows = page.locator('[data-review-state="pool"]');
      await rows.screenshot({ path: path.join(output, "web-review-four-states.png"), animations: "disabled" });
    }
    writeFileSync(path.join(output, `web-pace-metrics-${width}.json`), JSON.stringify({
      viewport: width,
      folded,
      expanded,
      focusAfterTab,
      overflow,
    }, null, 2));
    testInfo.annotations.push({ type: "capture", description: path.join(output, `web-pace-${width}.png`) });
  });
}

test("app component review account pool shows the same weekly bars at iPhone width", async ({ page }, testInfo) => {
  const bundle = path.resolve("dist/assets/ios-components");
  test.skip(!existsSync(path.join(bundle, "index.html")), "Run soul-app export:components for the native component preview.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true } }));
  await page.route("**/assets/ios-components/**", route => {
    const asset = new URL(route.request().url()).pathname.replace("/assets/ios-components/", "");
    return route.fulfill({ path: path.join(bundle, asset) });
  });
  await page.goto("/assets/ios-components/index.html?section=claudePool&theme=light");
  const toggle = page.getByTestId("claude-provider-toggle");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();

  const weekBar = (account: string, index: number) => page.getByTestId(`claude-quota-${account}-bar-${index}`);
  const cursor = (account: string, index: number) => page.getByTestId(`claude-quota-${account}-cursor-${index}`);

  for (const [account, index] of [["review-one", 1], ["review-one", 2], ["review-two", 1], ["review-two", 2]] as const) {
    const bar = weekBar(account, index);
    await expect(bar).toBeVisible();
    // 칸막이 여섯 개 = 일곱 조각.
    expect(await bar.locator(":scope > *").count()).toBe(7);
  }
  const unknownReset = cursor("review-two", 2);
  await expect(unknownReset).toHaveCount(0);
  for (const [account, index] of [["review-one", 1], ["review-one", 2], ["review-two", 1]] as const) {
    const marker = cursor(account, index);
    await expect(marker).toBeVisible();
    const geometry = await page.evaluate(({ barId, cursorId }) => {
      const bar = document.querySelector<HTMLElement>(`[data-testid="${barId}"]`)!;
      const dot = document.querySelector<HTMLElement>(`[data-testid="${cursorId}"]`)!;
      const barBox = bar.getBoundingClientRect();
      const dotBox = dot.getBoundingClientRect();
      return {
        bar: { x: barBox.x, width: barBox.width, y: barBox.y, height: barBox.height },
        cursor: { centerX: dotBox.x + dotBox.width / 2, centerY: dotBox.y + dotBox.height / 2, width: dotBox.width, height: dotBox.height },
        left: dot.style.left,
      };
    }, { barId: `claude-quota-${account}-bar-${index}`, cursorId: `claude-quota-${account}-cursor-${index}` });
    // 커서는 지난 비율 자리에 선다(7일 48%·72%는 0.5, Fable 20%는 0.6).
    const elapsed = Number.parseFloat(geometry.left) / 100;
    expect(Number.isFinite(elapsed), `${account}-${index} cursor left`).toBe(true);
    expect(Math.abs(geometry.cursor.centerX - (geometry.bar.x + elapsed * geometry.bar.width)),
      `${account}-${index} cursor x`).toBeLessThan(1);
    expect(geometry.cursor.width).toBeGreaterThanOrEqual(1.5);
    expect(geometry.cursor.width).toBeLessThanOrEqual(2.5);
    expect(geometry.cursor.height).toBeGreaterThanOrEqual(11);
    expect(Math.abs(geometry.cursor.centerY - (geometry.bar.y + geometry.bar.height / 2))).toBeLessThan(0.6);
  }
  const fiveHour = page.getByTestId("claude-quota-review-one-bar-0");
  expect(await fiveHour.locator(":scope > *").count()).toBe(1);
  expect(await cursor("review-one", 0).count()).toBe(0);

  const pool = page.getByTestId("claude-quota-review-one-bar-1");
  await pool.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, "app-iphone-390.png"), animations: "disabled" });
  testInfo.annotations.push({ type: "capture", description: path.join(output, "app-iphone-390.png") });
});
