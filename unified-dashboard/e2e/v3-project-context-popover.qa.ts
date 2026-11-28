import { koreanLocale } from "./korean-locale.mjs";
import type { Browser, Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme as "dark" | "light", reducedMotion: "reduce", locale: koreanLocale });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  // tsx가 함수 인자를 변환하며 남기는 __name 호출이 페이지에서 터지지 않게 한다.
  // 이 스크립트가 실패하면 아래 테마·Service Worker 스텁도 함께 실패해, 실제
  // dist/sw.js가 등록되어 페이지가 스스로 다시 뜬다(다른 카드 QA와 같은 보정).
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  await page.addInitScript(({ theme, glass }) => {
    localStorage.setItem("soul-dashboard-theme", theme);
    localStorage.setItem("ls.webglGlass", glass ? "1" : "0");
    if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, "register", { configurable: true, value: async () => ({ update: async () => {}, active: null, addEventListener: () => {} }) });
  }, { theme, glass });
  // 검수 창의 요청은 내부 응답이므로 실제 atom API와 같은 children 형식으로 대체한다.
  await page.addInitScript({ content: `
    const NativeResponse = window.Response;
    const nodeLevels = ${JSON.stringify([children(0), children(1), children(2)])};
    let nodeLevel = 0;
    window.Response = class extends NativeResponse {
      constructor(body, init) {
        if (typeof body === "string" && body.includes('"sample-atom-card"')) {
          body = JSON.stringify({children: nodeLevels[Math.min(nodeLevel++, 2)]});
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
function readMeasurements(page: Page) {
  return page.evaluate(() => {
    const popup = document.querySelector(".v3-project-context-popover");
    const viewport = popup?.querySelector('[data-slot="popover-viewport"]');
    const fields = popup?.querySelector(".v3-project-context-fields");
    const inlinePanel = popup?.querySelector('[data-slot="atom-node-selector-panel"]');
    const panel = inlinePanel ?? document.querySelector('[data-slot="popover-popup"] [title="자식 보기"]')?.closest('[data-slot="popover-popup"]');
    const actions = popup?.querySelector(".v3-project-context-editor-actions");
    const label = [...(popup?.querySelectorAll("label") ?? [])].find(el => el.textContent?.trim().startsWith("깊이"));
    return {
      popup: popup?.getBoundingClientRect().toJSON() ?? null,
      panel: panel?.getBoundingClientRect().toJSON() ?? null,
      inline: !!inlinePanel,
      fields: fields?.getBoundingClientRect().toJSON() ?? null,
      fieldsOverflow: fields && getComputedStyle(fields).overflowY,
      listOverflow: inlinePanel?.children[1] && getComputedStyle(inlinePanel.children[1]).overflowY,
      label: label?.getBoundingClientRect().toJSON() ?? null,
      actions: actions?.getBoundingClientRect().toJSON() ?? null,
      buttons: [...(actions?.querySelectorAll("button") ?? [])].map(el => ({ text: el.textContent, rect: el.getBoundingClientRect().toJSON() })),
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      active: document.activeElement?.outerHTML.slice(0, 350),
      viewport: viewport?.getBoundingClientRect().toJSON() ?? null,
      viewportScrollHeight: viewport?.scrollHeight, viewportClientHeight: viewport?.clientHeight,
      availableHeight: popup && getComputedStyle(popup).getPropertyValue("--available-height"),
    };
  });
}
async function measure(page: Page, name: string) {
  await page.waitForTimeout(350);
  const data = await readMeasurements(page);
  metrics[name] = data;
  const p = data.popup, a = data.actions;
  check(`${name}: popup viewport`, !!p && p.x >= -1 && p.y >= -1 && p.right <= data.width + 1 && p.bottom <= data.height + 1, p);
  check(`${name}: actions visible`, !!p && !!a && a.y >= p.y - 1 && a.bottom <= p.bottom + 1 && a.bottom <= data.height + 1, a);
  check(`${name}: buttons visible`, !!p && data.buttons.length >= 2 && data.buttons.every(({ rect }) => rect.x >= p.x - 1 && rect.right <= p.right + 1 && rect.y >= p.y - 1 && rect.bottom <= p.bottom + 1 && rect.bottom <= data.height + 1), data.buttons);
  check(`${name}: no horizontal scroll`, data.scrollWidth <= data.width, data.scrollWidth);
  if (data.panel) {
    const b = data.panel, f = data.fields;
    // 긴 인라인 판은 스크롤 본문에 담기므로 화면에 보이는 교집합을 잰다.
    const visible = data.inline && f ? { x: Math.max(b.x, f.x), right: Math.min(b.right, f.right), y: Math.max(b.y, f.y), bottom: Math.min(b.bottom, f.bottom) } : b;
    check(`${name}: visible panel contained`, !!p && visible.x >= p.x - 1 && visible.right <= p.right + 1 && visible.y >= p.y - 1 && visible.bottom <= p.bottom + 1, { panel: b, visible });
    check(`${name}: panel before depth`, !!data.label && b.bottom <= data.label.y + 1, data.label);
    if (data.inline) check(`${name}: one field scroll`, data.fieldsOverflow === "auto" && data.listOverflow !== "auto" && data.listOverflow !== "scroll", { fields: data.fieldsOverflow, list: data.listOverflow });
  }
  await page.screenshot({ path: path.join(output!, `${name}.png`), animations: "disabled", timeout: 15_000 });
}
async function scenario(browser: Browser, name: string, width: number, height: number, theme: string, glass: boolean, run: (page: Page) => Promise<void>) {
  // 좁혀 볼 때만 쓴다. 기본 실행은 전 시나리오를 돈다.
  const only = process.env.V3_PROJECT_CONTEXT_ONLY;
  if (only && !name.startsWith(only)) return;
  let page: Page | undefined;
  // 페이지가 다시 뜨거나 스크립트가 터진 흔적을 남겨, 빈 화면이 났을 때 원인을 가른다.
  const events: { kind: string; detail: string }[] = [];
  try {
    page = await setup(browser, width, height, theme, glass);
    const observed = page;
    observed.on("framenavigated", frame => {
      if (frame === observed.mainFrame() && events.length < 20) events.push({ kind: "navigated", detail: frame.url() });
    });
    observed.on("pageerror", error => { if (events.length < 20) events.push({ kind: "pageerror", detail: String(error).slice(0, 300) }); });
    observed.on("console", message => {
      if (message.type() === "error" && events.length < 20) events.push({ kind: "console", detail: message.text().slice(0, 300) });
    });
    observed.on("crash", () => events.push({ kind: "crash", detail: "" }));
    await run(page);
  } catch (error) {
    metrics[`${name}-events`] = events;
    check(`${name}: execution`, false, { error: String(error), events });
    if (page) await page.screenshot({ path: path.join(output!, `${name}-error.png`), timeout: 5000 }).catch(() => {});
  } finally {
    metrics[`${name}-events`] = events;
    await page?.context().close();
  }
}
async function openSample(page: Page, sample: string) {
  await page.goto(`${base}/dialogues?sample=${sample}`);
  await page.getByTestId("v3-project-context").waitFor();
  await page.waitForTimeout(1500);
  await page.locator(".v3-project-context-popover").waitFor({ state: "visible" });
}

// 카드 #1699: 컨텍스트 편집기의 노드 요청은 검수 창의 fixture(api.request)가
// 저장한 Response를 지나므로, setup()이 건 Response 변환 위에 한 겹 더 얹어
// 지정한 호출만 실패시킨다.
async function failFixtureAtomCalls(page: Page, failCalls: number[]) {
  await page.addInitScript({ content: `
    const PreviousResponse = window.Response;
    let atomCalls = 0;
    window.__qaAtomCalls = 0;
    const failCalls = ${JSON.stringify(failCalls)};
    window.Response = class extends PreviousResponse {
      constructor(body, init) {
        if (typeof body === "string" && body.includes('"sample-atom-card"')) {
          const call = atomCalls++;
          window.__qaAtomCalls = atomCalls;
          if (failCalls.includes(call)) {
            super(JSON.stringify({ detail: "오류" }), { status: 503 });
            return;
          }
        }
        super(body, init);
      }
    };
  ` });
}

// 폴더 설정 창은 실제 fetch를 쓰므로 라우트를 바꿔 실패를 만든다.
async function installNodeRoutes(page: Page, options: { failRootTimes?: number; failChildrenOf?: string } = {}) {
  let rootFailures = options.failRootTimes ?? 0;
  let childFailed = false;
  await page.route("**/api/atom/nodes**", route => {
    const pathname = new URL(route.request().url()).pathname;
    const match = pathname.match(/nodes\/([^/]+)\/children/);
    if (!match && rootFailures > 0) {
      rootFailures -= 1;
      return route.fulfill({ status: 503, json: { detail: "오류" } });
    }
    if (match && options.failChildrenOf && match[1] === options.failChildrenOf && !childFailed) {
      childFailed = true;
      return route.fulfill({ status: 503, json: { detail: "오류" } });
    }
    const depth = match ? Number(match[1].split("-")[0]) + 1 : 0;
    return route.fulfill({ json: { children: children(depth) } });
  });
}

// 카드 #1699: 초점이 간 요소가 프로젝트 초점 고리(UA 사각 외곽선 대신 inset 링)를 쓰는지 잰다.
async function checkProjectFocus(name: string, page: Page) {
  const style = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const computed = el ? getComputedStyle(el) : null;
    return {
      text: el?.textContent?.trim().slice(0, 40) ?? null,
      focusVisible: !!el?.matches(":focus-visible"),
      outlineStyle: computed?.outlineStyle ?? null,
      boxShadow: computed?.boxShadow ?? null,
    };
  });
  check(`${name}: project focus ring`, style.focusVisible && style.outlineStyle === "none" && style.boxShadow !== "none", style);
}

async function checkRing(target: Locator, name: string) {
  const style = await target.evaluate(el => {
    const { outlineStyle, boxShadow } = getComputedStyle(el);
    const spread = Number(boxShadow.match(/0px 0px 0px ([\d.]+)px/)?.[1] ?? 0);
    const rect = el.getBoundingClientRect();
    const clips = [];
    for (let clip = el.parentElement; clip; clip = clip.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(clip);
      if (overflowX === "visible" && overflowY === "visible") continue;
      const clipRect = clip.getBoundingClientRect();
      const left = clipRect.left + clip.clientLeft;
      const top = clipRect.top + clip.clientTop;
      clips.push({
        ancestor: clip.getAttribute("data-slot") ?? clip.className,
        horizontal: overflowX === "visible" ? [] : [rect.left - left, left + clip.clientWidth - rect.right],
        vertical: overflowY === "visible" ? [] : [rect.top - top, top + clip.clientHeight - rect.bottom],
      });
    }
    return { focused: document.activeElement === el, focusVisible: el.matches(":focus-visible"), outlineStyle, boxShadow, spread, rect: rect.toJSON(), clips };
  });
  // clientWidth and clientHeight are rounded to whole pixels.
  check(`${name}: unclipped v3 focus ring`, style.focused && style.focusVisible && style.outlineStyle === "none" &&
    style.spread > 0 && style.clips.length > 0 &&
    style.clips.every(({ horizontal, vertical }) => [...horizontal, ...vertical].every(gap => gap + 0.5 >= style.spread)), style);
}

async function checkRingAlignment(popup: Locator, name: string, width: number) {
  const edges = await popup.locator(".v3-project-context-fields").evaluate(fields =>
    [...fields.querySelectorAll(':scope > label, :scope > [role="group"], input[type="number"], select, [data-slot="atom-node-selector-trigger"], [data-slot="atom-node-selector-panel"]')]
      .map(el => {
        const { left, right } = el.getBoundingClientRect();
        return { label: el.getAttribute("data-slot") ?? el.firstChild?.textContent, left, right };
      }));
  const [left, right] = width === 390 ? [29, 361] : [33, 379];
  check(`${name}: fields keep their inline alignment`, edges.length > 0 &&
    edges.every(edge => Math.abs(edge.left - left) <= 1 && Math.abs(edge.right - right) <= 1), edges);
}
async function run(browser: Browser) {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    for (const [sample, heading] of [["project-edit", "참고 자료"], ["succession", "함께 전달할 자료"]]) {
      const name = `${sample}-${width}`;
      await scenario(browser, name, width, height, "dark", true, async page => {
        await page.goto(`${base}/dialogues?sample=${sample}`);
        const dialog = page.locator('[data-slot="dialog-popup"]');
        const add = dialog.locator("button", { hasText: /^atom에서 추가$/ });
        const summary = dialog.locator("summary").filter({ has: page.getByText(heading, { exact: true }) });
        await summary.waitFor();
        // Let the review page finish its initial reload before interacting with the dialog.
        await page.waitForTimeout(1500);
        if (await summary.getAttribute("aria-expanded") !== "true") await summary.click();
        await add.click();
        const popup = page.locator('[data-slot="popover-popup"]').filter({ has: page.locator('[title="자식 보기"]') });
        const row = popup.getByRole("button", { name: /^프로젝트 지식 노드 [012]-3$/ });
        await row.waitFor();
        check(`${name}: uses a portaled node list`, await popup.isVisible() && await dialog.locator('[title="자식 보기"]').count() === 0);
        check(`${name}: no inline list`, await page.locator('[data-slot="atom-node-selector-panel"]').count() === 0);
        await page.screenshot({ path: path.join(output!, `${name}-node-popup.png`), animations: "disabled" });
        await row.focus();
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "hidden" });
        check(`${name}: Escape keeps the dialog open`, await dialog.isVisible());
      });
    }
    const sample = width === 390 ? "atom-add" : "atom-edit";
    await scenario(browser, `${sample}-${width}-escape`, width, height, "dark", true, async page => {
      await openSample(page, sample);
      const popup = page.locator(".v3-project-context-popover");
      const panel = popup.locator('[data-slot="atom-node-selector-panel"]');
      const trigger = popup.locator('[data-slot="atom-node-selector-trigger"]');
      const depth = popup.getByRole("spinbutton", { name: "깊이", exact: true });
      const fields = [
        ["depth", depth],
        ["limit", popup.getByRole("spinbutton", { name: "atom 최근 자식 수" })],
        ["mode", popup.getByRole("combobox", { name: "atom 렌더 방식" })],
        ["titles only", popup.getByRole("checkbox", { name: "제목만 포함" })],
      ] as const;
      const row = panel.getByRole("button", { name: "프로젝트 지식 노드 0-3", exact: true });
      await row.waitFor();
      const name = `${sample}-${width}`;
      await checkRingAlignment(popup, `${name} open`, width);
      const modeStyle = await popup.locator(".v3-project-context-fields").evaluate(fields => {
        const number = getComputedStyle(fields.querySelector('input[type="number"]')!);
        const mode = getComputedStyle(fields.querySelector('select[aria-label="atom 렌더 방식"]')!);
        const properties = ["border-top-width", "border-top-style", "border-top-color", "border-top-left-radius", "padding", "color", "background-color"];
        return properties.map(property => ({ property, number: number.getPropertyValue(property), mode: mode.getPropertyValue(property) }));
      });
      check(`${name}: render mode matches the number input`, modeStyle.every(value => value.number === value.mode) &&
        modeStyle.some(({ property, mode }) => property === "border-top-left-radius" && parseFloat(mode) > 0), modeStyle);
      await checkRing(trigger, `${name} open trigger`);
      const listTabStops = await panel.locator("button:enabled").count();
      for (let i = 0; i < listTabStops; i++) await page.keyboard.press("Tab");
      for (const [field, locator] of fields) {
        await page.keyboard.press("Tab");
        await checkRing(locator, `${name} open ${field}`);
      }
      await depth.fill("5");
      if (width === 390) {
        await trigger.focus();
        await page.keyboard.press("Tab");
        check("atom-add-390: Tab reaches root", await panel.getByRole("button", { name: "루트" }).evaluate(el => el === document.activeElement));
      } else {
        await row.focus();
      }
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "hidden" });
      check(`${sample}-${width}: first Escape keeps editor open`, await popup.isVisible());
      check(`${sample}-${width}: first Escape keeps depth`, await depth.inputValue() === "5");
      check(`${sample}-${width}: first Escape focuses closed trigger`, await trigger.evaluate(el =>
        el === document.activeElement && el.getAttribute("aria-expanded") === "false"));
      await checkRingAlignment(popup, `${name} closed`, width);
      await checkRing(trigger, `${name} closed trigger`);
      await page.screenshot({ path: path.join(output!, `${sample}-${width}-first-escape.png`), animations: "disabled" });
      for (const [field, locator] of fields) {
        await page.keyboard.press("Tab");
        await checkRing(locator, `${name} closed ${field}`);
        if (field === "depth" || field === "mode") {
          await page.screenshot({ path: path.join(output!, `${sample}-${width}-${field}-ring.png`), animations: "disabled" });
        }
      }
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "hidden" });
      check(`${sample}-${width}: second Escape closes editor`, await popup.isHidden());
    });
    const variants = width === 390 ? [{ theme: "dark", glass: true }, { theme: "light", glass: true }, { theme: "dark", glass: false }] : [{ theme: "dark", glass: true }];
    for (const { theme, glass } of variants) {
      const suffix = `${width}-${theme}-${glass ? "glass" : "plain"}`;
      await scenario(browser, `atom-add-${suffix}`, width, height, theme, glass, async page => {
        await openSample(page, "atom-add");
        await page.keyboard.press("Escape");
        if (await page.locator(".v3-project-context-popover:visible").count()) await page.keyboard.press("Escape");
        await page.locator(".v3-project-context-popover").waitFor({ state: "hidden" });
        if (width === 390) await page.getByTestId("v3-project-context").evaluate(el => { (el as HTMLElement).style.marginTop = "400px"; });
        const trigger = page.getByRole("button", { name: "atom 추가" });
        await trigger.click();
        const popup = page.locator(".v3-project-context-popover");
        await popup.waitFor({ state: "visible" });
        await page.getByText(/프로젝트 지식 노드 [012]-1/, { exact: true }).first().waitFor();
        const group = popup.getByRole("group", { name: "atom 노드" });
        const selector = group.locator("button[aria-expanded]");
        check(`${suffix}: initial focus`, await selector.evaluate(el => el === document.activeElement));
        const save = popup.locator(".v3-project-context-editor-actions").getByRole("button", { name: "저장" });
        check(`${suffix}: save disabled while open`, await save.isDisabled());
        await measure(page, `atom-add-open-${suffix}`);
        await popup.getByRole("button", { name: /^프로젝트 지식 노드 [012]-1$/ }).click();
        await measure(page, `atom-add-selected-${suffix}`);
        check(`${suffix}: panel closed after selection`, await group.locator('[data-slot="atom-node-selector-panel"]').count() === 0);
        check(`${suffix}: save enabled after selection`, await save.isEnabled());
        check(`${suffix}: selection restores selector focus`, await selector.evaluate(el => el === document.activeElement));
        const targets = [
          'button[aria-expanded="false"]', 'input[type="number"]:not([aria-label])',
          '[aria-label="atom 최근 자식 수"]', '[aria-label="atom 렌더 방식"]',
          'input[type="checkbox"]', '.v3-project-context-editor-actions button:nth-last-child(2)',
          '.v3-project-context-editor-actions button:last-child',
        ];
        for (let i = 0; i < targets.length; i++) {
          if (i) await page.keyboard.press("Tab");
          const focused = await popup.locator(targets[i]).evaluate(el => el === document.activeElement);
          check(`${suffix}: tab ${i + 1}`, focused, targets[i]);
          check(`${suffix}: closed panel tab ${i + 1}`, await page.locator('[data-slot="atom-node-selector-panel"] :focus').count() === 0);
        }
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "hidden" });
        check(`${suffix}: escape and focus`, await trigger.evaluate(el => el === document.activeElement));
      });
    }
    await scenario(browser, `atom-edit-${width}`, width, height, "dark", true, async page => {
      await openSample(page, "atom-edit");
      await measure(page, `atom-edit-${width}-dark-glass`);
      await page.getByRole("group", { name: "atom 노드" }).locator("button[aria-expanded]").click();
      await measure(page, `atom-edit-closed-${width}-dark-glass`);
    });
    await scenario(browser, `defaults-add-${width}`, width, height, "dark", true, async page => {
      await openSample(page, "defaults-add");
      await measure(page, `defaults-add-${width}`);
    });
    await scenario(browser, `defaults-edit-${width}`, width, height, "dark", true, async page => {
      await openSample(page, "defaults-edit");
      await measure(page, `defaults-edit-${width}`);
    });
  }
  // 카드 #1699: 노드 목록 실패 뒤 「다시 시도」. 루트/하위 단계, 컨텍스트 팝오버/폴더 설정 창.
  await scenario(browser, "node-retry-390", 390, 844, "dark", true, async page => {
    await failFixtureAtomCalls(page, [0, 1]);
    await page.addInitScript({ content: `
      window.__qaFocusLog = [];
      document.addEventListener("focusin", event => {
        const el = event.target;
        window.__qaFocusLog.push(el.getAttribute?.("data-slot") || el.tagName + "." + String(el.className).slice(0, 40));
      }, true);
    ` });
    await page.goto(`${base}/dialogues?sample=atom-add`);
    await page.getByTestId("v3-project-context").waitFor();
    await page.waitForTimeout(1500);
    const popup = page.locator(".v3-project-context-popover");
    await popup.waitFor({ state: "visible" });
    const panel = popup.locator('[data-slot="atom-node-selector-panel"]');
    const error = popup.getByText("노드를 불러오지 못했습니다", { exact: true });
    await error.waitFor();
    const retry = panel.getByRole("button", { name: "다시 시도" });
    await retry.waitFor();
    check("node-retry-390: retry button in the same panel", await retry.count() === 1);
    const popupBox = await popup.evaluate(el => el.getBoundingClientRect().toJSON());
    const retryBox = await retry.evaluate(el => el.getBoundingClientRect().toJSON());
    check("node-retry-390: retry button inside the popover",
      retryBox.left >= popupBox.left - 1 && retryBox.right <= popupBox.right + 1
      && retryBox.top >= popupBox.top - 1 && retryBox.bottom <= popupBox.bottom + 1, { popupBox, retryBox });
    await page.screenshot({ path: path.join(output, "node-retry-390-error.png"), animations: "disabled" });
    await retry.click();
    // 두 번째 요청이 끝난 뒤에 잰다. 클릭 직후의 error.waitFor()는 아직 사라지기
    // 전의 오류를 그대로 만나 곧바로 돌아오므로, 요청 횟수로 끝을 가른다.
    await page.waitForFunction(() => (window as unknown as { __qaAtomCalls?: number }).__qaAtomCalls === 2);
    await error.waitFor();
    await page.waitForTimeout(150);
    check("node-retry-390: focus stays on retry after another failure",
      await retry.evaluate(el => el === document.activeElement),
      await page.evaluate(() => ({
        active: document.activeElement?.outerHTML.slice(0, 160) ?? null,
        focusLog: (window as unknown as { __qaFocusLog?: string[] }).__qaFocusLog?.slice(-8) ?? [],
      })));
    await page.screenshot({ path: path.join(output, "node-retry-390-failure-again.png"), animations: "disabled" });
    // 「다시 시도」 바로 앞 Tab 정류장인 빵부스러기 「루트」의 초점 표시.
    await retry.focus();
    await page.keyboard.press("Shift+Tab");
    await checkProjectFocus("node-retry-390: breadcrumb root ring", page);
    // 마지막 성공 누름은 키보드로 한다(세라피엘 반려 시나리오).
    await retry.focus();
    await page.keyboard.press("Enter");
    const firstNode = panel.locator("button").filter({ hasText: "프로젝트 컨텍스트에서 긴 노드 제목" }).first();
    await firstNode.waitFor();
    await page.waitForTimeout(100);
    check("node-retry-390: list after success", await error.count() === 0);
    check("node-retry-390: focus moves to the first node", await firstNode.evaluate(el => el === document.activeElement));
    await checkProjectFocus("node-retry-390: first node keyboard ring", page);
    await page.screenshot({ path: path.join(output, "node-retry-390-success.png"), animations: "disabled" });
  });
  await scenario(browser, "node-retry-sublevel-390", 390, 844, "dark", true, async page => {
    await failFixtureAtomCalls(page, [1]);
    await openSample(page, "atom-add");
    const popup = page.locator(".v3-project-context-popover");
    const panel = popup.locator('[data-slot="atom-node-selector-panel"]');
    const row = panel.getByRole("button", { name: "프로젝트 지식 노드 0-3", exact: true });
    await row.waitFor();
    await panel.locator('[title="자식 보기"]').nth(3).click();
    const error = popup.getByText("노드를 불러오지 못했습니다", { exact: true });
    await error.waitFor();
    const retry = panel.getByRole("button", { name: "다시 시도" });
    await retry.waitFor();
    check("node-retry-sublevel-390: failed level covered by retry", await error.isVisible());
    // 들어간 단계(0-3)의 이름이 빵부스러기에 남아 있어야 한다.
    check("node-retry-sublevel-390: breadcrumb keeps the level",
      await panel.getByRole("button", { name: "프로젝트 지식 노드 0-3", exact: true }).count() === 1);
    await page.screenshot({ path: path.join(output, "node-retry-sublevel-390-error.png"), animations: "disabled" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "프로젝트 지식 노드 1-1", exact: true }).waitFor();
    await page.waitForTimeout(100);
    check("node-retry-sublevel-390: retried the same level", await panel.getByRole("button", { name: "프로젝트 지식 노드 0-1", exact: true }).count() === 0);
    const firstChild = panel.locator("button").filter({ hasText: "프로젝트 컨텍스트에서 긴 노드 제목" }).last();
    check("node-retry-sublevel-390: focus moves to the first child", await firstChild.evaluate(el => el === document.activeElement));
    await checkProjectFocus("node-retry-sublevel-390: first child keyboard ring", page);
    await page.screenshot({ path: path.join(output, "node-retry-sublevel-390-success.png"), animations: "disabled" });
  });
  await scenario(browser, "minimum-360", 360, 844, "dark", true, async page => {
    await openSample(page, "atom-add");
    await measure(page, "atom-add-open-360-dark-glass");
  });
  await scenario(browser, "node-load-error", 390, 844, "dark", true, async page => {
    await page.addInitScript({ content: `
      const ResponseWithNodes = window.Response;
      let failOnce = true;
      window.Response = class extends ResponseWithNodes {
        constructor(body, init) {
          if (failOnce && typeof body === "string" && body.includes('"sample-atom-card"')) {
            failOnce = false;
            super(JSON.stringify({detail: "오류"}), { status: 503 });
          } else super(body, init);
        }
        async json() {
          const result = await super.json();
          if (result.children?.[0]?.id === "0-0") {
            await new Promise(resolve => window.addEventListener("qa-release-node-load", resolve, { once: true }));
          }
          return result;
        }
      };
    ` });
    await openSample(page, "atom-add");
    const popup = page.locator(".v3-project-context-popover");
    const error = popup.getByText("노드를 불러오지 못했습니다", { exact: true });
    await error.waitFor();
    await page.screenshot({ path: path.join(output!, "node-load-error-390.png"), animations: "disabled" });
    check("node load error: visible", await error.isVisible());
    const selector = popup.getByRole("group", { name: "atom 노드" }).locator("button[aria-expanded]");
    await selector.click();
    await selector.click();
    const loading = popup.getByText("불러오는 중", { exact: true });
    await loading.waitFor();
    await page.screenshot({ path: path.join(output!, "node-load-pending-390.png"), animations: "disabled" });
    await page.evaluate(() => window.dispatchEvent(new Event("qa-release-node-load")));
    await popup.getByText(/프로젝트 지식 노드 [012]-1/, { exact: true }).first().waitFor();
    check("node load error: retry", await error.count() === 0);
  });
  await scenario(browser, "resize", 1440, 900, "dark", true, async page => {
    await openSample(page, "atom-add");
    const popup = page.locator(".v3-project-context-popover");
    const fields = popup.locator(".v3-project-context-fields");
    const limit = popup.getByRole("spinbutton", { name: "atom 최근 자식 수" });
    await limit.fill("7");
    const anchor = popup.getByRole("button", { name: "프로젝트 지식 노드 0-12", exact: true });
    const relativeTop = () => anchor.evaluate(el =>
      el.getBoundingClientRect().top - el.closest(".v3-project-context-fields")!.getBoundingClientRect().top);
    await fields.evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
    const before = await relativeTop();
    const scrollBefore = await fields.evaluate(el => el.scrollTop);
    check("resize: list row visible before resize", before >= 0 && before < await fields.evaluate(el => el.clientHeight), before);
    await page.setViewportSize({ width: 390, height: 844 });
    await measure(page, "resize-1440-to-390");
    const after = await relativeTop();
    const scrollAfter = await fields.evaluate(el => el.scrollTop);
    check("resize: scroll retained", Math.abs(scrollAfter - scrollBefore) <= 1 && after >= 0 && after < await fields.evaluate(el => el.clientHeight), { scrollBefore, scrollAfter, before, after });
    check("resize: draft retained", await limit.inputValue() === "7");
  });
}
async function runWithScrollbars(browser: Browser) {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    for (const sample of ["defaults-add", "defaults-edit", "atom-add", "atom-edit"]) {
      const name = `scrollbars-${sample}-${width}`;
      await scenario(browser, name, width, height, "dark", true, async page => {
        await openSample(page, sample);
        const fields = page.locator(".v3-project-context-popover .v3-project-context-fields");
        const size = await fields.evaluate(el => {
          const field = el as HTMLElement;
          return { offsetHeight: field.offsetHeight, clientHeight: field.clientHeight, overflowX: getComputedStyle(field).overflowX };
        });
        check(`${name}: no horizontal scrollbar`, size.offsetHeight === size.clientHeight && size.overflowX === "hidden", size);
        await page.screenshot({ path: path.join(output!, `${name}.png`), animations: "disabled" });
      });
    }
  }
}

const launchOptions = { headless: true, args: ["--disable-webgl"], executablePath: existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
try {
  await runPlaywrightLifecycle({ lockName: "card1643-context-popover", timeoutMs: 480_000, launchOptions }, ({ browser }: { browser: Browser }) => run(browser));
  await runPlaywrightLifecycle({
    lockName: "card1643-context-popover", timeoutMs: 480_000,
    launchOptions: { ...launchOptions, ignoreDefaultArgs: ["--hide-scrollbars"] },
  }, ({ browser }: { browser: Browser }) => runWithScrollbars(browser));
} catch (error) { check("script execution", false, String(error)); }
writeFileSync(path.join(output, "metrics.json"), JSON.stringify({ checks, metrics }, null, 2));
writeFileSync(path.join(output, "summary.json"), JSON.stringify({
  pass: checks.every(c => c.ok),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  generated_at: new Date().toISOString(),
  checks,
}, null, 2));
console.table(checks.filter(c => !c.ok));
console.log(`${checks.filter(c => c.ok).length}/${checks.length} checks passed; ${output}`);
if (!recordOnly && checks.some(c => !c.ok)) process.exitCode = 1;
