import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/card-checkitems-261005/web-captures");
const baseURL = process.env.CARD_CHECK_ITEMS_BASE_URL;
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

const selectors = [".v3-card-check-item-meta", ".v3-card-check-item-target", ".v3-card-check-item-no-image", ".v3-card-detail-tab[aria-selected=false]", ".v3-card-now-turn--user strong", ".v3-card-check-item-links a"];
for (const width of [1440, 1920]) for (const webgl of [false, true]) {
  test(`followup ABC ${width} glass ${webgl ? "on" : "off"}`, async ({ page }) => {
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
