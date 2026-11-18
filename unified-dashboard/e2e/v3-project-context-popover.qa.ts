import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = process.env.V3_PROJECT_CONTEXT_OUT;
if (!output || !path.isAbsolute(output)) throw new Error("V3_PROJECT_CONTEXT_OUT must be an absolute path");
const recordOnly = process.env.V3_QA_RECORD_ONLY === "1";
const base = process.env.V3_QA_BASE_URL!;
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const metrics: Record<string, unknown> = {};
mkdirSync(output, { recursive: true });
function check(name: string, ok: boolean, detail?: unknown) { checks.push({ name, ok, detail }); }
const children = (depth: number) => Array.from({ length: depth < 3 ? 25 : 0 }, (_, i) => ({
  id: `${depth}-${i}`, card_id: `card-${depth}-${i}`,
  card: { title: i === 0 ? "프로젝트 컨텍스트에서 긴 노드 제목의 말줄임과 선택을 확인하기 위한 아주 긴 한글 제목입니다" : `프로젝트 지식 노드 ${depth}-${i}`, card_type: "knowledge" },
}));
async function setup(browser: Browser, width: number, height: number, theme = "dark", glass = true) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme as "dark" | "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(({ theme, glass }) => {
    localStorage.setItem("soul-dashboard-theme", theme);
    localStorage.setItem("ls.webglGlass", glass ? "1" : "0");
    if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, "register", { configurable: true, value: async () => ({ update: async () => {}, active: null, addEventListener: () => {} }) });
  }, { theme, glass });
  await page.addInitScript({ content: `
    const NativeResponse = window.Response;
    window.Response = class extends NativeResponse {
      constructor(body, init) {
        if (typeof body === "string" && body.includes('"sample-atom-card"')) {
          body = JSON.stringify({children: ${JSON.stringify(children(0))}});
        }
        super(body, init);
      }
    };
  ` });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/atom/nodes**", route => {
    const match = new URL(route.request().url()).pathname.match(/nodes\/(\d+)-\d+\/children/);
    return route.fulfill({ json: { children: children(match ? Number(match[1]) + 1 : 0) } });
  });
  await page.route("**/api/status", route => route.fulfill({ json: { atom_enabled: true, is_draining: false } }));
  return page;
}
async function measure(page: Page, name: string) {
  await page.waitForTimeout(350);
  const data = await page.evaluate(() => {
    const popup = document.querySelector(".v3-project-context-popover");
    const viewport = popup?.querySelector('[data-slot="popover-viewport"]');
    const panel = popup?.querySelector('[data-slot="atom-node-selector-panel"]') ?? document.querySelector('[data-slot="popover-popup"] [title="자식 보기"]')?.closest('[data-slot="popover-popup"]');
    const actions = popup?.querySelector(".v3-project-context-editor-actions");
    const label = [...(popup?.querySelectorAll("label") ?? [])].find(el => el.textContent?.trim().startsWith("깊이"));
    return { popup: popup?.getBoundingClientRect().toJSON() ?? null, panel: panel?.getBoundingClientRect().toJSON() ?? null, label: label?.getBoundingClientRect().toJSON() ?? null, actions: actions?.getBoundingClientRect().toJSON() ?? null, buttons: [...(actions?.querySelectorAll("button") ?? [])].map(el => ({ text: el.textContent, rect: el.getBoundingClientRect().toJSON() })), width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, active: document.activeElement?.outerHTML.slice(0, 350), viewport: viewport?.getBoundingClientRect().toJSON() ?? null, viewportScrollHeight: viewport?.scrollHeight, viewportClientHeight: viewport?.clientHeight, availableHeight: popup && getComputedStyle(popup).getPropertyValue("--available-height") };
  });
  metrics[name] = data;
  const p = data.popup, a = data.actions;
  check(`${name}: popup viewport`, !!p && p.x >= -1 && p.y >= -1 && p.right <= data.width + 1 && p.bottom <= data.height + 1, p);
  check(`${name}: actions visible`, !!p && !!a && a.y >= p.y - 1 && a.bottom <= p.bottom + 1 && a.bottom <= data.height + 1, a);
  check(`${name}: no horizontal scroll`, data.scrollWidth <= data.width, data.scrollWidth);
  if (data.panel) {
    const b = data.panel;
    check(`${name}: panel contained`, !!p && b.x >= p.x - 1 && b.right <= p.right + 1 && b.y >= p.y - 1 && b.bottom <= p.bottom + 1, b);
    check(`${name}: panel before depth`, !!data.label && b.bottom <= data.label.y + 1, data.label);
  }
  await page.screenshot({ path: path.join(output!, `${name}.png`), animations: "disabled" });
}
async function run(browser: Browser) {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    for (const variant of width === 390 ? [{ theme: "dark", glass: true }, { theme: "light", glass: true }, { theme: "dark", glass: false }] : [{ theme: "dark", glass: true }]) {
      const page = await setup(browser, width, height, variant.theme, variant.glass);
      const suffix = `${width}-${variant.theme}-${variant.glass ? "glass" : "plain"}`;
      await page.goto(`${base}/dialogues?sample=atom-add`);
      await page.getByTestId("v3-project-context").waitFor();
      await page.waitForTimeout(1500);
      await page.locator(".v3-project-context-popover").waitFor();
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
      await page.locator(".v3-project-context-popover").waitFor({ state: "hidden" });
      if (width === 390) await page.getByTestId("v3-project-context").evaluate(el => { (el as HTMLElement).style.marginTop = "400px"; });
      const trigger = page.getByRole("button", { name: "atom 추가" });
      await trigger.click();
      await page.locator(".v3-project-context-popover").waitFor({ state: "visible" });
      await page.getByText("프로젝트 지식 노드 0-1", { exact: true }).waitFor();
      const focusedInside = await page.locator(".v3-project-context-popover").evaluate(el => el.contains(document.activeElement));
      check(`${suffix}: initial focus`, focusedInside);
      const save = page.locator(".v3-project-context-editor-actions").getByRole("button", { name: "저장" });
      check(`${suffix}: save disabled while open`, await save.isDisabled());
      const panel = page.locator('[data-slot="atom-node-selector-panel"]');
      if (await panel.count()) await panel.scrollIntoViewIfNeeded();
      await measure(page, `atom-add-open-${suffix}`);
      await page.getByText("프로젝트 지식 노드 0-1", { exact: true }).click({ force: true });
      await measure(page, `atom-add-selected-${suffix}`);
      check(`${suffix}: save enabled after selection`, await save.isEnabled());
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        check(`${suffix}: closed panel tab ${i}`, await page.locator('[data-slot="atom-node-selector-panel"] :focus').count() === 0);
        if (!await page.evaluate(() => document.querySelector(".v3-project-context-popover")?.contains(document.activeElement) ?? false)) break;
      }
      if (!await page.locator(".v3-project-context-popover:visible").count()) await trigger.click();
      await page.locator(".v3-project-context-popover button").first().focus();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      check(`${suffix}: escape and focus`, await page.locator(".v3-project-context-popover:visible").count() === 0 && await trigger.evaluate(el => el === document.activeElement));
      if (variant.theme === "dark" && variant.glass) {
        await page.goto(`${base}/dialogues?sample=atom-edit`);
        await page.locator(".v3-project-context-popover").waitFor();
        const panel = page.locator('[data-slot="atom-node-selector-panel"]');
        if (await panel.count()) await panel.scrollIntoViewIfNeeded();
        await measure(page, `atom-edit-${suffix}`);
      }
      await page.context().close();
    }
    const page = await setup(browser, width, height);
    await page.goto(`${base}/dialogues?sample=defaults-add`);
    await page.getByTestId("v3-project-context").waitFor();
    await page.waitForTimeout(1500);
    await page.locator(".v3-project-context-popover").waitFor();
    await measure(page, `defaults-add-${width}`);
    await page.context().close();
  }
  const page = await setup(browser, 1440, 900);
  await page.goto(`${base}/dialogues?sample=atom-add`);
  await page.getByTestId("v3-project-context").waitFor();
  await page.waitForTimeout(1500);
  await page.locator(".v3-project-context-popover").waitFor();
  await page.getByText("프로젝트 지식 노드 0-1", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const resizePanel = page.locator('[data-slot="atom-node-selector-panel"]');
  if (await resizePanel.count()) await resizePanel.scrollIntoViewIfNeeded();
  await measure(page, "resize-1440-to-390");
  await page.context().close();
  const folder = await setup(browser, 1440, 900);
  await folder.goto(`${base}/dialogues?sample=folder-settings`);
  await folder.getByText("atom 트리 주입").waitFor();
  await folder.getByRole("button", { name: /노드 선택/ }).click();
  await folder.getByText("프로젝트 지식 노드 0-1", { exact: true }).waitFor();
  await folder.screenshot({ path: path.join(output!, "folder-settings-1440.png"), timeout: 30000 });
  check("folder settings: popup", await folder.locator('[data-slot="popover-popup"] [title="자식 보기"]').count() > 0);
  await folder.context().close();
}
try {
  await runPlaywrightLifecycle({ lockName: "card1643-context-popover", timeoutMs: 300_000, launchOptions: { headless: true, args: ["--disable-webgl"], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }, async ({ browser }: { browser: Browser }) => run(browser));
} catch (error) { check("script execution", false, String(error)); }
writeFileSync(path.join(output, "metrics.json"), JSON.stringify({ checks, metrics }, null, 2));
console.table(checks.filter(c => !c.ok));
console.log(`${checks.filter(c => c.ok).length}/${checks.length} checks passed; ${output}`);
if (!recordOnly && checks.some(c => !c.ok)) process.exitCode = 1;
