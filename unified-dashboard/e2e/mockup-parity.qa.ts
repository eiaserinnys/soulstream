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
const TIME = new Date("2026-10-01T00:00:00Z");
type Theme = "light" | "dark";

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
