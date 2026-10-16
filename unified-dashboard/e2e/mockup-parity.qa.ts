import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// 운영 빌드의 검수 창(/components)과 같은 본문을 올린 시안 묶음을 같은 조건에서 찍는다.
// 화소 비교는 찍힌 PNG 쌍으로 한다(mockups/compare-captures.py).
const output = process.env.MOCKUP_PARITY_OUTPUT;
if (!output) throw new Error("MOCKUP_PARITY_OUTPUT is required");
const REAL = "http://127.0.0.1:4391/components";
const MOCK = "http://127.0.0.1:4392/proof-343/frame.html";
const HOST = "http://127.0.0.1:4392/proof-343/index.html";
const TIME = new Date("2026-10-01T00:00:00Z");
type Theme = "light" | "dark";
type PressedColors = {
  selectedLabel: string;
  accent: string;
  selectedColor: string;
  unselectedColor: string;
  selectedBackground: string;
  unselectedBackground: string;
  hostBackground: string;
};

function expectPressedAccent(colors: PressedColors) {
  expect(colors.selectedColor).toBe(colors.accent);
  expect(colors.unselectedColor).not.toBe(colors.accent);
  expect(colors.selectedBackground).not.toBe("transparent");
  expect(colors.selectedBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.selectedBackground).not.toBe(colors.hostBackground);
  expect(colors.selectedBackground).not.toBe(colors.unselectedBackground);
}

async function common(page: Page, width: number, theme: Theme, log: string[]) {
  page.on("pageerror", error => log.push(`pageerror ${error.message}`));
  page.on("requestfailed", request => log.push(`requestfailed ${request.method()} ${new URL(request.url()).pathname}`));
  page.on("response", response => {
    if (response.status() >= 400) log.push(`http ${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.clock.install({ time: TIME });
}

async function openReal(page: Page, width: number, theme: Theme, log: string[]) {
  await common(page, width, theme, log);
  await page.addInitScript(value => {
    localStorage.setItem("soul-dashboard-theme", value);
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  }, theme);
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: "기존 본문" });
  await page.route("**/api/cards?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ cards: [] }) }));
  // 서버가 주는 그림은 시안 묶음이 싣는 것과 같은 파일로 맞춘다. 견주는 것은 데이터가 아니라 모습이다.
  await page.route("**/api/nodes/*/agents/*/portrait", route => route.fulfill({ path: "public/system-portrait.png" }));
  await page.route("**/api/attachments/files**", route => route.request().method() === "GET"
    ? route.fulfill({ path: "public/icon-512.png" })
    : route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "mockup: no fixture" }) }));
  await page.goto(REAL);
}

async function openMock(page: Page, width: number, theme: Theme, log: string[]) {
  await common(page, width, theme, log);
  await page.goto(`${MOCK}?theme=${theme}&glass=css`);
}

async function settle(page: Page) {
  await expect(page.getByTestId("components-review")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
}

const main = (page: Page) => page.locator("main.v3-components-main");

const only = process.env.MOCKUP_PARITY_ONLY;
for (const [width, theme] of ([[1440, "light"], [1440, "dark"], [390, "light"]] as const).filter(([w, t]) => !only || only === `${w}-${t}`)) {
  test(`mockup bundle matches the production build ${width} ${theme}`, async ({ browser }) => {
    const dir = path.join(output, `${width}-${theme}`);
    mkdirSync(dir, { recursive: true });
    const realLog: string[] = [], mockLog: string[] = [];
    const real = await (await browser.newContext()).newPage();
    const mock = await (await browser.newContext()).newPage();
    await openReal(real, width, theme, realLog);
    await openMock(mock, width, theme, mockLog);
    await settle(real); await settle(mock);

    const heights = await Promise.all([real, mock].map(page => main(page).evaluate(el => el.scrollHeight)));
    const samples = await Promise.all([real, mock].map(page => page.locator(".v3-components-sample").count()));
    const steps = Math.ceil(Math.max(...heights) / 900);
    for (let step = 0; step < steps; step += 1) {
      for (const [name, page] of [["real", real], ["mock", mock]] as const) {
        await main(page).evaluate((el, top) => { el.scrollTop = top; }, step * 900);
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(dir, `${String(step).padStart(2, "0")}-${name}.png`), animations: "disabled" });
      }
    }
    // 견본마다 높이와, 안쪽 요소의 자리와 글자 모양을 적어 어긋난 곳을 찾는다.
    const fingerprint = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".v3-components-sample")].map(sample => ({
      label: sample.querySelector(".v3-components-label")?.textContent ?? "",
      height: sample.offsetHeight, width: sample.offsetWidth,
      parts: [...sample.querySelectorAll<HTMLElement>("*")].map(element => {
        const rect = element.getBoundingClientRect(), base = sample.getBoundingClientRect(), style = getComputedStyle(element);
        return [element.tagName.toLowerCase() + (typeof element.className === "string" && element.className ? "." + element.className.split(/\s+/).slice(0, 3).join(".") : ""),
          Math.round(rect.x - base.x), Math.round(rect.y - base.y), Math.round(rect.width), Math.round(rect.height),
          style.fontSize, style.lineHeight, style.display].join("|");
      }),
    })));
    writeFileSync(path.join(dir, "layout-real.json"), JSON.stringify(await fingerprint(real)));
    writeFileSync(path.join(dir, "layout-mock.json"), JSON.stringify(await fingerprint(mock)));
    const unmocked = await mock.evaluate(() => (window as unknown as { __mockupUnmocked?: string[] }).__mockupUnmocked ?? []);
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
      width, theme, scrollHeight: { real: heights[0], mock: heights[1] },
      samples: { real: samples[0], mock: samples[1] }, steps,
      realLog: [...new Set(realLog)], mockLog: [...new Set(mockLog)], unmocked: [...new Set(unmocked)],
    }, null, 2));
    expect(samples[1]).toBe(samples[0]);
  });
}

for (const [width, theme] of ([[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const)) {
  test(`mockup host renders and responds at ${width} ${theme}`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(`${HOST}?theme=${theme}&w=fit&glass=css`);
    mkdirSync(output, { recursive: true });
    const frame = page.locator(".mockup-host-frame");
    await expect(page.locator(".mockup-host-title")).toHaveText("실제 컴포넌트로 만든 시안 확인");
    await expect(page.getByRole("group", { name: "테마" })).toBeVisible();
    await expect(page.getByRole("group", { name: "화면 폭" })).toBeVisible();
    await expect(page.frameLocator(".mockup-host-frame").locator(".v3-components-page")).toBeVisible();
    const readPressedColors = (name: string) => page.getByRole("group", { name }).evaluate((group, label): PressedColors => {
      const selected = group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      const unselected = group.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
      if (!selected || !unselected) throw new Error(`${label} must have selected and unselected buttons`);
      const probe = document.createElement("span");
      probe.style.color = "var(--v3-accent)";
      group.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const host = document.querySelector<HTMLElement>(".mockup-host");
      if (!host) throw new Error("mockup host is missing");
      return {
        selectedLabel: selected.textContent?.trim() ?? "",
        accent,
        selectedColor: getComputedStyle(selected).color,
        unselectedColor: getComputedStyle(unselected).color,
        selectedBackground: getComputedStyle(selected).backgroundColor,
        unselectedBackground: getComputedStyle(unselected).backgroundColor,
        hostBackground: getComputedStyle(host).backgroundColor,
      };
    }, name);

    const initialThemeColors = await readPressedColors("테마");
    const initialWidthColors = await readPressedColors("화면 폭");
    expect(initialThemeColors.selectedLabel).toBe(theme === "light" ? "밝게" : "어둡게");
    expect(initialWidthColors.selectedLabel).toBe("맞춤");
    expectPressedAccent(initialThemeColors);
    expectPressedAccent(initialWidthColors);

    const headerLayout = await page.locator(".mockup-host-header").evaluate(header => {
      const rectCenter = (selector: string) => {
        const element = header.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`${selector} is missing`);
        const rect = element.getBoundingClientRect();
        return Math.round(rect.top + rect.height / 2);
      };
      const title = header.querySelector<HTMLElement>(".mockup-host-title");
      if (!title) throw new Error("mockup host title is missing");
      const rows = new Set([
        rectCenter(".mockup-host-title"),
        rectCenter('[role="group"][aria-label="테마"]'),
        rectCenter('[role="group"][aria-label="화면 폭"]'),
      ]);
      return {
        rows: rows.size,
        height: header.offsetHeight,
        titleClientWidth: title.clientWidth,
        titleScrollWidth: title.scrollWidth,
      };
    });
    expect(headerLayout.rows).toBe(width === 390 ? 2 : 1);
    writeFileSync(path.join(output, `host-${width}-${theme}-layout.json`), JSON.stringify(headerLayout, null, 2));

    const header = await page.locator(".mockup-host-header").evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const buttons = await page.locator(".mockup-host-header button").evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    );
    expect(buttons).toHaveLength(6);
    expect(buttons.every(rect =>
      rect.left >= header.left && rect.right <= header.right
      && rect.top >= header.top && rect.bottom <= header.bottom
      && rect.left >= 0 && rect.right <= width,
    )).toBe(true);
    expect(buttons.some((rect, index) => buttons.slice(index + 1).some(other =>
      rect.left < other.right && other.left < rect.right
      && rect.top < other.bottom && other.top < rect.bottom,
    ))).toBe(false);
    const titleStyle = await page.locator(".mockup-host-title").evaluate(element => {
      const style = getComputedStyle(element);
      return {
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    });
    expect(titleStyle).toEqual({
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      fontWeight: "650", fontSize: "16px", lineHeight: "24px",
    });

    await page.screenshot({
      path: path.join(output, `host-${width}-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });

    if (width === 1440 && theme === "light") {
      await page.setViewportSize({ width: 820, height: 1000 });
      await page.waitForTimeout(150);
      const currentTitleAt820 = await page.locator(".mockup-host-header").evaluate(header => {
        const parts = [
          header.querySelector<HTMLElement>(".mockup-host-title"),
          header.querySelector<HTMLElement>('[role="group"][aria-label="테마"]'),
          header.querySelector<HTMLElement>('[role="group"][aria-label="화면 폭"]'),
        ];
        if (parts.some(part => !part)) throw new Error("mockup host header parts are missing");
        const centers = parts.map(part => {
          const rect = part!.getBoundingClientRect();
          return Math.round(rect.top + rect.height / 2);
        });
        return { rows: new Set(centers).size, height: header.offsetHeight };
      });
      expect(currentTitleAt820.rows).toBe(1);
      writeFileSync(path.join(output, "host-current-title-820-layout.json"), JSON.stringify({
        title: await page.locator(".mockup-host-title").innerText(),
        ...currentTitleAt820,
      }, null, 2));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForTimeout(150);
    }

    if (width === 1440) {
      const hoveredLabel = theme === "light" ? "어둡게" : "밝게";
      const hovered = page.getByRole("group", { name: "테마" }).getByRole("button", { name: hoveredLabel });
      await hovered.hover();
      const hoveredBackground = await hovered.evaluate(element => getComputedStyle(element).backgroundColor);
      await page.getByRole("group", { name: "테마" }).screenshot({
        path: path.join(output, `selected-hover-${theme}.png`),
        animations: "disabled",
      });
      writeFileSync(path.join(output, `selected-hover-${theme}.json`), JSON.stringify({
        selected: initialThemeColors.selectedBackground,
        hovered: hoveredBackground,
        unselected: initialThemeColors.unselectedBackground,
      }, null, 2));

      const sample = page.frameLocator(".mockup-host-frame").locator('[data-testid="card-board-sample"]');
      await sample.getByRole("button", { name: "일반 보기", exact: true }).click();
      await sample.getByRole("switch", { name: "완료·취소 숨김" }).click();
      const periods = sample.getByRole("group", { name: "완료 기간" });
      await expect(periods).toBeVisible();
      const periodColors = await periods.evaluate(group => {
        const selected = group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
        const unselected = group.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
        if (!selected || !unselected) throw new Error("completed-periods buttons are missing");
        return {
          selectedLabel: selected.textContent?.trim() ?? "",
          selectedBackground: getComputedStyle(selected).backgroundColor,
          unselectedBackground: getComputedStyle(unselected).backgroundColor,
        };
      });
      writeFileSync(path.join(output, `completed-periods-after-${theme}.json`), JSON.stringify(periodColors, null, 2));
      await sample.locator(".v3-completed-controls").screenshot({
        path: path.join(output, `completed-periods-after-${theme}.png`),
        animations: "disabled",
      });
    }

    const nextTheme = theme === "light" ? "dark" : "light";
    await page.getByRole("button", { name: nextTheme === "dark" ? "어둡게" : "밝게" }).click();
    await expect.poll(() => page.locator("html").evaluate(element => element.classList.contains("dark")))
      .toBe(nextTheme === "dark");
    await expect.poll(() => frame.evaluate(element =>
      Boolean((element as HTMLIFrameElement).contentDocument?.documentElement.classList.contains("dark")),
    )).toBe(nextTheme === "dark");
    expect(new URL(page.url()).searchParams.get("theme")).toBe(nextTheme);
    const afterThemeColors = await readPressedColors("테마");
    expect(afterThemeColors.selectedLabel).toBe(nextTheme === "light" ? "밝게" : "어둡게");
    expectPressedAccent(afterThemeColors);

    let afterPhoneColors: PressedColors | null = null;
    for (const [label, id, expectedWidth] of [
      ["맞춤", "fit", null],
      ["휴대폰", "phone", "390px"],
      ["태블릿", "tablet", "820px"],
      ["데스크톱", "desktop", "1440px"],
    ] as const) {
      await page.getByRole("button", { name: label }).click();
      if (expectedWidth === null) {
        const stageWidth = await page.locator(".mockup-host-stage").evaluate(element => element.clientWidth);
        await expect.poll(() => frame.evaluate(element => (element as HTMLIFrameElement).style.width))
          .toBe(`${stageWidth}px`);
      } else {
        await expect.poll(() => frame.evaluate(element => (element as HTMLIFrameElement).style.width))
          .toBe(expectedWidth);
      }
      expect(new URL(page.url()).searchParams.get("w")).toBe(id);
      await expect(page.getByRole("group", { name: "화면 폭" }).getByRole("button", { name: label }))
        .toHaveAttribute("aria-pressed", "true");
      if (label === "휴대폰") afterPhoneColors = await readPressedColors("화면 폭");
    }
    expect(afterPhoneColors).not.toBeNull();
    expect(afterPhoneColors!.selectedLabel).toBe("휴대폰");
    expectPressedAccent(afterPhoneColors!);
    const transform = await frame.evaluate(element => (element as HTMLIFrameElement).style.transform);
    if (width === 390) expect(transform.startsWith("scale(")).toBe(true);
    else expect(transform).toBe("");
    writeFileSync(path.join(output, `host-${width}-${theme}-colors.json`), JSON.stringify({
      initialTheme: initialThemeColors,
      initialWidth: initialWidthColors,
      afterTheme: afterThemeColors,
      afterPhoneWidth: afterPhoneColors,
    }, null, 2));

    if (width === 1440 && theme === "light") {
      const currentTitle = "실제 컴포넌트로 만든 시안 확인";
      const longTitle = "긴 제목 테스트 ".repeat(12).slice(0, 98);
      const context = await browser.newContext();
      const longPage = await context.newPage();
      await longPage.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await longPage.goto(`${HOST}?theme=light&w=fit&glass=css`);
      await expect(longPage.frameLocator(".mockup-host-frame").locator(".v3-components-page")).toBeVisible();
      await longPage.evaluate(() => document.fonts.ready);
      const readTitleLayout = () => longPage.locator(".mockup-host-header").evaluate(header => {
        const title = header.querySelector<HTMLElement>(".mockup-host-title")!;
        const parts = [title,
          header.querySelector<HTMLElement>('[role="group"][aria-label="테마"]')!,
          header.querySelector<HTMLElement>('[role="group"][aria-label="화면 폭"]')!,
        ];
        const positions = parts.map(element => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        const centers = positions.map(rect => Math.round(rect.y + rect.height / 2));
        const lines = [...new Set(centers)].sort((a, b) => a - b);
        const style = getComputedStyle(title);
        return {
          rows: lines.length, height: header.offsetHeight,
          titleClientWidth: title.clientWidth, titleScrollWidth: title.scrollWidth,
          titleTruncated: title.scrollWidth > title.clientWidth,
          titleLine: lines.indexOf(centers[0]) + 1,
          themeLine: lines.indexOf(centers[1]) + 1,
          widthLine: lines.indexOf(centers[2]) + 1,
          positions,
          titleStyle: { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace },
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const titleLayouts = [];
      for (const titleWidth of [320, 360, 390, 412, 430, 480, 540, 572, 600, 820, 1440]) {
        await longPage.setViewportSize({ width: titleWidth, height: 1000 });
        const pair = [];
        for (const [name, title] of [["current", currentTitle], ["long", longTitle]] as const) {
          await longPage.evaluate(value => { document.title = value; }, title);
          // document.title은 상태가 아니므로 테마를 바꿔 실제 host를 다시 그린다.
          await longPage.getByRole("button", { name: name === "current" ? "어둡게" : "밝게" }).click();
          await expect(longPage.locator(".mockup-host-title")).toHaveText(title);
          const metrics = await readTitleLayout();
          expect(metrics.horizontalOverflow).toBe(false);
          if (titleWidth >= 360) expect(metrics.titleClientWidth).toBeGreaterThanOrEqual(160);
          expect(metrics.titleStyle).toEqual({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
          if (name === "long") expect(metrics.titleTruncated).toBe(true);
          pair.push(metrics);
          titleLayouts.push({ width: titleWidth, title: name, titleLength: title.length, ...metrics });
          if ((name === "current" && [412, 430, 480, 540].includes(titleWidth))
            || (name === "long" && [430, 820].includes(titleWidth))) {
            await longPage.screenshot({
              path: path.join(output, `host-title-${name}-${titleWidth}.png`),
              animations: "disabled",
            });
          }
        }
        expect(pair[1].rows).toBe(pair[0].rows);
        expect(pair[1].height).toBe(pair[0].height);
        expect(pair[1].positions).toEqual(pair[0].positions);
      }
      writeFileSync(path.join(output, "host-title-widths.json"), JSON.stringify({ currentTitle, longTitle, layouts: titleLayouts }, null, 2));
      // 이전 결함을 주입하면 같은 폭 검사가 실제 렌더에서 실패하는지 확인한다.
      await longPage.setViewportSize({ width: 412, height: 1000 });
      await longPage.locator(".mockup-host-title").evaluate(element => { (element as HTMLElement).style.minWidth = "0"; });
      const broken = await readTitleLayout();
      expect(broken.titleClientWidth).toBeLessThan(160);
      expect(() => expect(broken.titleClientWidth).toBeGreaterThanOrEqual(160)).toThrow();
      writeFileSync(path.join(output, "host-title-regression.json"), JSON.stringify(broken, null, 2));
      await context.close();
    }
  });
}
