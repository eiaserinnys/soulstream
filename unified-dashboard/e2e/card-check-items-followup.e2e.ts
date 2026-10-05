import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/card-checkitems-261005/web-captures");
const baseURL = process.env.CARD_CHECK_ITEMS_BASE_URL;
const smallOutput = path.join(output, "small", process.env.CARD_SMALL_CAPTURE_PHASE ?? "after");
if (!baseURL) throw new Error("CARD_CHECK_ITEMS_BASE_URL is required");
mkdirSync(output, { recursive: true });

async function prepare(page: Page, width: number, webgl: boolean) {
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()) && !url.pathname.includes("ui-events")) writes.push(`${request.method()} ${url.pathname}`);
  });
  await page.setViewportSize({ width, height: width === 1920 ? 1080 : 810 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await page.addInitScript(on => {
    localStorage.setItem("soul-dashboard-theme", "dark");localStorage.setItem("ls.webglGlass", on ? "1" : "0");
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true, value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  }, webgl);
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.goto(new URL("/components", baseURL!).href);
  await expect(page.getByTestId("components-review")).toBeVisible();
  await page.locator(".v3-shell.v3-components-page").evaluate(el => (el as HTMLElement).style.setProperty("--v3-navigation-width", "336px"));
  await page.evaluate(() => document.fonts.ready);
  return { errors, writes, board: page.getByTestId("card-board-sample") };
}

test("small D: past hint and all tabs fit the dragged card pane", async ({ page }) => {
  mkdirSync(smallOutput, { recursive: true });
  const { board, errors, writes } = await prepare(page, 1440, false);
  await board.getByTestId("postit-size-comparison").locator(".v3-postit-open").first().click();
  const detail = page.getByTestId("card-detail"), workspace = page.getByTestId("v3-card-workspace");
  const records = [];
  for (const width of [466, 316, 268]) {
    const handle = page.getByTestId("v3-card-workspace-divider").locator(".cursor-col-resize");
    const box = (await handle.boundingBox())!;
    const current = Number(await workspace.getAttribute("data-card-width-px"));
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + width - current, box.y + 80);
    await page.mouse.up();
    await expect(workspace).toHaveAttribute("data-card-width-px", String(width));
    await detail.locator(".v3-card-panel-scroll").evaluate(el => { el.scrollTop = 0; });
    const panel = detail.getByTestId("card-now-panel");
    const geometry = () => detail.evaluate(el => ({
      height: el.querySelector('[data-testid="card-now-panel"]')!.getBoundingClientRect().height,
      itemY: el.querySelector('[data-testid="card-check-items"]')!.getBoundingClientRect().y,
    }));
    const latest = await geometry();
    await panel.getByRole("button", { name: "이전 상황" }).click();
    await page.waitForTimeout(250);
    const past = await geometry();
    const layout = await detail.evaluate(el => {
      const hint = el.querySelector(".v3-card-now-past-hint")!;
      const button = hint.querySelector("button")!, span = hint.querySelector("span")!;
      const tabs = el.querySelector<HTMLElement>('[role="tablist"]')!;
      const range = document.createRange(); range.selectNodeContents(button);
      const r = button.getBoundingClientRect(), t = tabs.getBoundingClientRect();
      return { buttonHeight: r.height, lineHeight: parseFloat(getComputedStyle(button).lineHeight),
        buttonLines: range.getClientRects().length, overlap: span.getBoundingClientRect().right > r.left,
        tabWidth: tabs.clientWidth, tabScrollWidth: tabs.scrollWidth, tabsTop: t.top, tabsBottom: t.bottom,
        tabBoxes: [...tabs.querySelectorAll('[role="tab"]')].map(tab => { const b = tab.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }),
        tabsLeft: t.left, tabsRight: t.right,
        panelTop: el.querySelector(".v3-card-panel-scroll")!.getBoundingClientRect().top };
    });
    await page.screenshot({ path: path.join(smallOutput, `D-${width}-past-tabs.png`), animations: "disabled" });
    expect.soft(layout.buttonLines).toBe(1);
    expect.soft(layout.buttonHeight).toBeCloseTo(layout.lineHeight, 0);
    expect.soft(layout.overlap).toBe(false);
    expect.soft(past.height).toBeCloseTo(latest.height, 0);
    expect.soft(past.itemY).toBeCloseTo(latest.itemY, 0);
    expect.soft(layout.tabScrollWidth).toBeLessThanOrEqual(layout.tabWidth);
    expect.soft(layout.panelTop).toBeGreaterThanOrEqual(layout.tabsBottom);
    for (const tab of layout.tabBoxes) {
      expect.soft(tab.left).toBeGreaterThanOrEqual(layout.tabsLeft - 1);
      expect.soft(tab.right).toBeLessThanOrEqual(layout.tabsRight + 1);
      expect.soft(tab.bottom).toBeLessThanOrEqual(layout.tabsBottom);
    }
    if (width === 466) expect.soft(new Set(layout.tabBoxes.map(b => b.top)).size).toBe(1);
    for (const name of [/^노트/, /^세션/, /^커멘트/, /^확인 항목/]) {
      const tab = detail.getByRole("tab", { name });
      await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true");
    }
    records.push({ width, latest, past, layout });
    await panel.getByRole("button", { name: "최신으로", exact: true }).click();
  }
  writeFileSync(path.join(smallOutput, "D-metrics.json"), JSON.stringify(records, null, 2));
  expect(errors).toEqual([]); expect(writes).toEqual([]);
});

test("small E: title block encloses the visible focused title", async ({ page, browserName }) => {
  mkdirSync(smallOutput, { recursive: true });
  const { board } = await prepare(page, 1440, false);
  await board.getByTestId("postit-size-comparison").locator(".v3-postit-open").first().click();
  const detail = page.getByTestId("card-detail"), title = detail.locator(".v3-card-title-button");
  const focusTitle = async () => {
    await detail.getByRole("button", { name: "카드 닫기", exact: true }).focus();
    for (let i = 0; i < 12 && !(await title.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(title).toBeFocused();
  };
  const records = [];
  for (const width of [466, 316, 268]) {
    const workspace = page.getByTestId("v3-card-workspace");
    const handle = page.getByTestId("v3-card-workspace-divider").locator(".cursor-col-resize");
    const box = (await handle.boundingBox())!, current = Number(await workspace.getAttribute("data-card-width-px"));
    await page.mouse.move(box.x + box.width / 2, box.y + 80); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + width - current, box.y + 80); await page.mouse.up();
    await expect(workspace).toHaveAttribute("data-card-width-px", String(width));
    await focusTitle();
    const info = await title.evaluate(el => {
      const h1 = el.closest("h1")!, s = getComputedStyle(el), h = getComputedStyle(h1), block = h1.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(el);
      // A clipped fourth line can overlap the block by a few pixels. Count
      // glyph rows whose centers are inside the visible title block.
      const visibleLines = [...range.getClientRects()].filter(r => (r.top + r.bottom) / 2 >= block.top && (r.top + r.bottom) / 2 <= block.bottom)
        .map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
      const offset = parseFloat(h.outlineOffset), thickness = parseFloat(h.outlineWidth);
      const header = h1.closest(".v3-folder-header")!;
      return { display: s.display, outline: s.outlineStyle, shadow: s.boxShadow,
        block: { left: block.left, right: block.right, top: block.top, bottom: block.bottom },
        ring: { left: block.left - offset - thickness, right: block.right + offset + thickness,
          top: block.top - offset - thickness, bottom: block.bottom + offset + thickness },
        blockBoxes: h1.getClientRects().length, blockOutline: h.outlineStyle, blockOutlineWidth: h.outlineWidth,
        blockOverflow: h.overflow, blockClamp: h.webkitLineClamp, offset, visibleLines,
        previousRight: header.querySelector(".dashboard-icon-cap")!.getBoundingClientRect().right,
        nextLeft: header.querySelector(".v3-folder-header-actions")!.getBoundingClientRect().left };
    });
    await page.screenshot({ path: path.join(smallOutput, `E-${width}-${browserName}.png`), animations: "disabled" });
    expect.soft(info.display).toBe("inline"); expect.soft(info.outline).toBe("none"); expect.soft(info.shadow).toBe("none");
    expect.soft(info.blockBoxes).toBe(1); expect.soft(info.blockOutline).toBe("solid"); expect.soft(info.blockOutlineWidth).toBe("2px");
    expect.soft(info.blockOverflow).toBe("hidden"); expect.soft(info.blockClamp).toBe("3");
    expect.soft(info.visibleLines).toHaveLength(3);
    for (const line of info.visibleLines) {
      expect.soft(line.left).toBeGreaterThanOrEqual(info.block.left - 1);
      expect.soft(line.right).toBeLessThanOrEqual(info.block.right + 1);
      expect.soft(line.top).toBeGreaterThanOrEqual(info.block.top - 1);
      expect.soft(line.bottom).toBeLessThanOrEqual(info.block.bottom + 1);
    }
    expect.soft(info.ring.left).toBeGreaterThan(info.previousRight);
    expect.soft(info.ring.right).toBeLessThan(info.nextLeft);
    records.push({ width, ...info });
  }
  // Text-only stress fixture: retain the real inline button and its parent flow.
  await title.evaluate(el => { el.textContent = "짧은 제목"; });
  await page.screenshot({ path: path.join(smallOutput, `E-title-one-line-${browserName}.png`), animations: "disabled" });
  writeFileSync(path.join(smallOutput, `E-${browserName}-metrics.json`), JSON.stringify(records, null, 2));
});

test("small F: default ask uses two lines and compact keeps one", async ({ page, browserName }) => {
  mkdirSync(smallOutput, { recursive: true });
  const { board, errors, writes } = await prepare(page, 1440, false);
  const comparison = board.getByTestId("postit-size-comparison");
  await comparison.scrollIntoViewIfNeeded();
  const legacy = board.locator('[data-card-id="board-0-1"]');
  await legacy.screenshot({ path: path.join(smallOutput, `F-legacy-${browserName}.png`) });
  await comparison.screenshot({ path: path.join(smallOutput, `F-original-${browserName}.png`) });
  // Replace only fixture copy to exercise the longest approved track combination.
  await comparison.locator(".v3-postit-turn-text").evaluateAll(elements => elements.forEach(el => {
    el.lastChild!.textContent = "보고된 결과를 확인하고 좁은 화면의 제목과 버튼 정렬도 함께 확인해 주세요. ".repeat(3);
  }));
  await comparison.locator(".v3-postit-body").evaluateAll(elements => elements.forEach(el => {
    el.textContent = "요청된 카드 화면을 확인하고 있습니다. 긴 상황 글도 줄 단위로 줄어듭니다. ".repeat(5);
  }));
  const records = await comparison.locator(".v3-postit-card").evaluateAll(cards => cards.map(card => {
    const turn = card.querySelector<HTMLElement>(".v3-postit-turn")!, body = card.querySelector<HTMLElement>(".v3-postit-body")!;
    const inner = turn.querySelector<HTMLElement>(".v3-postit-turn-text")!;
    const s = getComputedStyle(turn), b = getComputedStyle(body), t = getComputedStyle(inner);
    const turnRect = turn.getBoundingClientRect(), bodyRect = body.getBoundingClientRect();
    // Unrotated layout offsets avoid rotation's axis-aligned bounding boxes.
    return { compact: card.classList.contains("v3-postit-card--compact"), height: turn.offsetHeight,
      lineHeight: parseFloat(s.lineHeight), padding: parseFloat(s.paddingTop) + parseFloat(s.paddingBottom),
      clamp: t.webkitLineClamp, innerOverflow: t.overflow, innerPadding: t.padding, innerHeight: inner.offsetHeight,
      bodyClamp: Number(b.webkitLineClamp), bodyLines: body.offsetHeight / parseFloat(b.lineHeight),
      bodyBottom: body.offsetTop + body.offsetHeight, turnTop: turn.offsetTop,
      turnBottom: turn.offsetTop + turn.offsetHeight, footerTop: (card.querySelector(".v3-postit-footer") as HTMLElement).offsetTop,
      cardHeight: (card as HTMLElement).offsetHeight, bodyRect, turnRect };
  }));
  await comparison.screenshot({ path: path.join(smallOutput, `F-long-ask-postits-${browserName}.png`) });
  for (const record of records) {
    expect.soft(Math.abs(record.height - (record.lineHeight * (record.compact ? 1 : 2) + record.padding))).toBeLessThan(1);
    expect.soft(record.height).toBe(record.compact ? 30 : 46);
    expect.soft(record.innerPadding).toBe("0px"); expect.soft(record.innerOverflow).toBe("hidden");
    expect.soft(Math.abs(record.innerHeight - record.lineHeight * (record.compact ? 1 : 2))).toBeLessThan(1);
    expect.soft(record.bodyBottom).toBeLessThanOrEqual(record.turnTop + 1);
    expect.soft(record.turnBottom).toBeLessThanOrEqual(record.footerTop);
    expect.soft(record.bodyLines).toBeCloseTo(Math.round(record.bodyLines), 0);
    expect.soft(record.bodyClamp).toBe(record.compact ? 1 : 2);
    expect.soft(Math.round(record.bodyLines)).toBe(record.bodyClamp);
  }
  await board.getByTestId("card-check-scenarios").getByRole("button", { name: "에이전트 차례 띠", exact: true }).click();
  await expect(comparison.locator(".v3-postit-turn")).toHaveCount(0);
  await comparison.locator(".v3-postit-body").evaluateAll(elements => elements.forEach(el => {
    el.textContent = "요청된 카드 화면을 확인하고 있습니다. 긴 상황 글도 마지막 줄에서 말줄임되어야 합니다. ".repeat(2).slice(0, 60);
  }));
  const withoutTurn = await comparison.locator(".v3-postit-card").evaluateAll(cards => cards.map(card => {
    const body = card.querySelector<HTMLElement>(".v3-postit-body")!, style = getComputedStyle(body);
    return { compact: card.classList.contains("v3-postit-card--compact"), bodyClamp: Number(style.webkitLineClamp),
      bodyLines: body.offsetHeight / parseFloat(style.lineHeight), bodyBottom: body.offsetTop + body.offsetHeight,
      footerTop: (card.querySelector(".v3-postit-footer") as HTMLElement).offsetTop };
  }));
  await comparison.screenshot({ path: path.join(smallOutput, `F-no-ask-postits-${browserName}.png`) });
  for (const record of withoutTurn) {
    expect.soft(record.bodyClamp).toBe(record.compact ? 1 : 3);
    expect.soft(Math.round(record.bodyLines)).toBe(record.bodyClamp);
    expect.soft(record.bodyLines).toBeCloseTo(record.bodyClamp, 0);
    expect.soft(record.bodyBottom).toBeLessThanOrEqual(record.footerTop);
  }
  writeFileSync(path.join(smallOutput, `F-${browserName}-metrics.json`), JSON.stringify({ withTurn: records, withoutTurn }, null, 2));
  expect(errors).toEqual([]); expect(writes).toEqual([]);
});


const selectors = [".v3-card-check-item-meta", ".v3-card-check-item-target", ".v3-card-check-item-no-image", ".v3-card-detail-tab[aria-selected=false]", ".v3-card-now-turn--user strong", ".v3-card-check-item-links a"];
for (const width of [1440, 1920]) for (const webgl of [false, true]) {
  test(`followup ABC ${width} glass ${webgl ? "on" : "off"}`, async ({ page }) => {
    // Software WebGL needs multiple real frames for the six contrast captures.
    if (webgl) test.setTimeout(90_000);
    const { board, errors, writes } = await prepare(page, width, false);
    await board.scrollIntoViewIfNeeded();
    const postits = board.getByTestId("postit-size-comparison");
    const colors = await postits.locator(".v3-postit-open").first().evaluate(el => [...el.querySelectorAll<HTMLElement>(".v3-card-progress-dot")].map(dot => ({ className: dot.className, color: getComputedStyle(dot).backgroundColor })));
    const ink = await postits.locator(".v3-postit-title").first().evaluate(el => getComputedStyle(el).color);
    expect(colors.find(dot => dot.className.endsWith("--todo"))!.color).toBe(ink);
    for (const state of ["doing", "reported", "changed", "fix"]) {
      const dot = colors.find(dot => dot.className.endsWith(`--${state}`))!;
      const rowColor = await page.locator(`#components-rows .v3-card-progress-dot--${state}`).first().evaluate(el => getComputedStyle(el).backgroundColor);
      expect(dot.color).toBe(rowColor);
      expect(dot.color).not.toBe(colors.find(dot => dot.className.endsWith("--todo"))!.color);
    }
    const prefix = `followup-${width}-${webgl ? "webgl" : "css"}`;
    await postits.screenshot({ path: path.join(output, `${prefix}-B-postits.png`) });
    await postits.locator(".v3-postit-open").first().click();
    const detail = page.getByTestId("card-detail");
    await expect(detail).toBeVisible();
    if (webgl) await page.evaluate(() => {
      localStorage.setItem("ls.webglGlass", "1");
      window.dispatchEvent(new Event("ls.webglGlass:change"));
    });
    if (webgl) await expect(detail).toHaveAttribute("data-liquid-glass-webgl", "true");
    else await expect(detail).not.toHaveAttribute("data-liquid-glass-webgl", "true");
    await page.waitForTimeout(1000);
    const surface = await detail.evaluate(d => {
      const chat = document.querySelector('[data-testid="v3-card-session-chat"]')!;
      const style = (el: Element) => ({ tint: getComputedStyle(el).getPropertyValue("--glass-chrome-surface-strong").trim(), before: getComputedStyle(el, "::before").backgroundColor, opacity: getComputedStyle(el, "::before").opacity, background: getComputedStyle(el).backgroundColor });
      return { detail: style(d), chat: style(chat), webgl: d.getAttribute("data-liquid-glass-webgl") };
    });
    expect(surface.detail.tint).toBe(surface.chat.tint);
    if (webgl) expect(surface.detail.opacity).toBe("1");
    const link = detail.locator(".v3-card-check-item-links a").first();
    const linkColors = await link.evaluate(el => ({ name: getComputedStyle(el).color, icon: getComputedStyle(el.querySelector("svg")!).color }));
    expect(linkColors.name).not.toBe(linkColors.icon);
    const scroll = detail.locator(".v3-card-panel-scroll");
    for (const [position, offset] of [["top", 0], ["mid", 330], ["bottom", -1]] as const) {
      await scroll.evaluate((el, y) => { el.scrollTop = y < 0 ? el.scrollHeight : y; }, offset);
      await page.waitForTimeout(200);
      const records = await detail.evaluate((d, selectors) => {
        const clip = d.querySelector(".v3-card-panel-scroll")!.getBoundingClientRect(), dock = d.querySelector(".v3-card-composer-slot")!.getBoundingClientRect();
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;canvas.width = canvas.height = 1;
        return selectors.flatMap(selector => [...d.querySelectorAll<HTMLElement>(selector)].flatMap(el => {
          if (!el.offsetParent) return [];
          const range = document.createRange();range.selectNodeContents(el);const r = range.getBoundingClientRect();
          if (r.width < 6 || r.height < 6 || (el.closest(".v3-card-panel-scroll") && (r.top < clip.top + 2 || r.bottom > dock.top - 26))) return [];
          const style = getComputedStyle(el);context.clearRect(0, 0, 1, 1);context.fillStyle = style.color;context.fillRect(0, 0, 1, 1);
          return [{ selector, text: el.textContent?.trim(), rgba: [...context.getImageData(0, 0, 1, 1).data], box: [r.left, r.top, r.right, r.bottom] }];
        }));
      }, selectors);
      const name = `${prefix}-A-${position}`;
      await page.screenshot({ path: path.join(output, `${name}.png`), timeout: 15_000 });
      const hidden = await page.addStyleTag({ content: selectors.map(selector => `${selector},${selector} *`).join(",") + "{color:transparent!important;text-shadow:none!important}" });
      await page.screenshot({ path: path.join(output, `${name}-background.png`), timeout: 15_000 });
      await hidden.evaluate(el => el.remove());
      writeFileSync(path.join(output, `${name}.json`), JSON.stringify(records, null, 2));
    }
    writeFileSync(path.join(output, `${prefix}-surface.json`), JSON.stringify({ surface, colors, linkColors, errors, writes }, null, 2));
    // WebGL evidence already contains the visible chips. Capture the dedicated
    // chip in CSS mode, where scrolling does not wait on the software renderer.
    if (!webgl) {
      await link.scrollIntoViewIfNeeded();
      await link.screenshot({ path: path.join(output, `${prefix}-C-link.png`) });
    }
    expect(errors).toEqual([]);expect(writes).toEqual([]);
  });
}
