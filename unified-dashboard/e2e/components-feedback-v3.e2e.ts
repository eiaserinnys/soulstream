import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewCard } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/20261001-web-ui-v3");
const phase = process.env.COMPONENTS_REVIEW_PHASE;
if (!phase) throw new Error("COMPONENTS_REVIEW_PHASE required");
mkdirSync(output, { recursive: true });

for (const width of [1440, 390]) for (const webgl of [false, true]) {
test(`composer and surfaces ${width} ${webgl ? "webgl" : "fallback"}`, async ({ page }) => {
  test.setTimeout(120_000);
  const name = `${phase}-${width}-${webgl ? "webgl" : "fallback"}`;
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.stack ?? error.message); writeFileSync(path.join(output, `${name}-page-errors.json`), JSON.stringify(errors, null, 2)); });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const preferences = { appearance: "dark", chatFontSize: 17, wallpaper: { mode: "photo", customImage: "/api/user/background?v=qa" } };
  await page.addInitScript(({ preferences, webgl }) => {
    // Throttle only the live glass loop for software WebGL on the shared
    // verification host. Its actual renderer, wallpaper and tint stay active.
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => request(time => {
      if (callback.name === "renderFrame") window.setTimeout(() => callback(performance.now()), 100);
      else callback(time);
    });
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", webgl ? "1" : "0");
    localStorage.setItem("soul-user-preferences:qa@example.test", JSON.stringify(preferences));
  }, { preferences, webgl });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", r => r.fulfill({ json: { preferences, hasBackground: true, backgroundUrl: "/api/user/background?v=qa" } }));
  // Repository wallpaper: an actual raster with light/dark detail, no personal capture.
  await page.route("**/api/user/background?**", r => r.fulfill({ path: path.resolve("public/system-portrait.png"), contentType: "image/png" }));
  const cards = ["blocked", "review"].map((status, i) => ({ ...reviewCard, status, id: `qa-state-${status}`,
    folderId:"folder-amber", assigneeSessionId:null, positionKey:String(i), title:"상태별 같은 카드", request:"같은 미리보기" }));
  await page.route("**/api/cards?**", r => r.fulfill({ json: { cards:new URL(r.request().url()).searchParams.get("folderId") === "folder-amber" ? cards : [] } }));
  await page.route("**/api/cards/qa-state-*", r => r.fulfill({ json: { card:cards.find(c => r.request().url().endsWith(c.id)),
    reports:[], questions:[], sessions:[], comments:[] } }));
  await page.route("**/api/nodes/*/model-presets", r => r.fulfill({ json: { model_presets:[
    {id:"qa-opus",label:"Claude Opus",backend:"claude",available:true},
    {id:"qa-standard",label:"QA 표준 모델",backend:"codex",available:true}] } }));
  const field = {field_name:"qa", description:"실제 설정 입력", value:"샘플 값", value_type:"str", sensitive:false, hot_reloadable:true, read_only:false};
  await page.route("**/api/config/settings", r => r.fulfill({ json: { categories:[{name:"qa",label:"설정 표면 검수",fields:[
    {...field,key:"qa-text",label:"입력"}, {...field,key:"qa-secret",label:"마스킹",sensitive:true},
    {...field,key:"qa-readonly",label:"읽기 전용",read_only:true}] }] } }));
  await page.goto("/components");
  await expect(page.getByTestId("components-review")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (webgl) await expect(page.locator('[data-slot="chat-input-composer"]')).toHaveAttribute("data-liquid-glass-webgl", "true");
  // Capture the current compositor surface directly. Playwright's animation
  // stabilization waits indefinitely while the live WebGL glass redraws.
  const cdp = await page.context().newCDPSession(page);
  const capture = async (state: string) => {
    await page.evaluate(() => document.fonts.ready);
    const { data } = await cdp.send("Page.captureScreenshot", { format:"png", fromSurface:true, captureBeyondViewport:false });
    writeFileSync(path.join(output, `${name}-${state}.png`), Buffer.from(data, "base64"));
  };
  await page.locator('#components-rows').evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" })); await capture('rows');
  if (process.env.ROWS_ONLY) {
    await page.evaluate(async () => {
      // This fixture mounts the actual operational component; the review page
      // remains owned by the independent PostItCard implementation session.
      const { mountManagedFolderFixture } = await import("/e2e/fixtures/run-row-layout.tsx");
      const host = document.createElement("div"); host.dataset.testid="managed-long-fixture";
      document.querySelector("#components-rows .v3-components-samples")!.append(host);
      mountManagedFolderFixture(host);
    });
    await expect(page.getByTestId("v3-task-components-managed-long")).toBeVisible();
  }
  const rows = await page.locator('.v3-run-row').evaluateAll(elements => elements.map(row => {
    const rect = (selector: string) => row.querySelector(selector)?.getBoundingClientRect().toJSON();
    const open = row.querySelector('.v3-run-open')!, actions = row.querySelector('.v3-run-row-actions');
    return { id: row.getAttribute('data-testid') ?? row.getAttribute('data-card-id'),
      frame:row.getBoundingClientRect().toJSON(), copy:rect('.v3-run-copy'), avatar:rect('.v3-run-avatar'),
      info:rect('.v3-run-trailing'), actions:rect('.v3-run-row-actions'),
      actionParent:actions?.parentElement?.className, tracks:getComputedStyle(open).gridTemplateRows,
      columns:getComputedStyle(open).gridTemplateColumns, padding:getComputedStyle(open).padding,
      narrow:getComputedStyle(row.querySelector('.v3-run-trailing')!).gridColumnStart === '2',
      labels:[...row.querySelectorAll('.v3-status-label')].map(el=>({text:el.textContent,width:el.clientWidth,scrollWidth:el.scrollWidth,rect:el.getBoundingClientRect().toJSON()})),
      title: (()=>{const el=row.querySelector('.v3-run-title-line strong')!;return {text:el.textContent,width:el.clientWidth,scrollWidth:el.scrollWidth};})(),
      caps:[...row.querySelectorAll('.v3-run-row-actions button')].map(el=>el.getBoundingClientRect().toJSON()) };
  }));
  writeFileSync(path.join(output, `${name}-row-metrics.json`), JSON.stringify(rows, null, 2));
  for (const row of rows) if (row.actions && row.info) {
    expect.soft(row.actionParent).toBe('v3-run-open outline-none focus-visible:ring-2 focus-visible:ring-ring');
    expect.soft(row.actions.left).toBeGreaterThanOrEqual(row.info.right);
    expect.soft(Math.abs(row.actions.y + row.actions.height/2 - row.frame.y - row.frame.height/2)).toBeLessThanOrEqual(1);
    if (row.narrow) {
      expect.soft(row.info.top).toBeGreaterThanOrEqual(row.copy!.bottom);
      expect.soft(row.info.left).toBeCloseTo(row.copy!.left,0);
      for (const label of row.labels) expect.soft(label.scrollWidth).toBeLessThanOrEqual(label.width);
    }
    expect.soft(row.padding).toBe("12px 16px");
    expect.soft(row.frame.right - row.actions.right).toBe(17);
    for (const cap of row.caps) { expect.soft(cap.width).toBe(32); expect.soft(cap.height).toBe(32); }
  }
  await page.locator('[data-component="CardRowView / RunRowFrame actions"]').evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" })); await capture('card-states');
  await page.getByTestId('v3-task-components-parent').evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" })); await capture('parent-folder');
  if (process.env.ROWS_ONLY) {
    const short = rows.find(row => row.id === "v3-task-components-folder-card")!;
    const long = rows.find(row => row.id === "v3-task-components-managed-long")!;
    expect.soft(short.title.scrollWidth).toBeLessThanOrEqual(short.title.width);
    for (const row of [short,long]) {
      expect.soft(row.narrow).toBe(width === 390);
      expect.soft(row.labels.map(label=>label.text)).toEqual(["카드 집계 · 진행", "세션 #1 실행 중"]);
      for (const label of row.labels) expect.soft(label.scrollWidth).toBeLessThanOrEqual(label.width);
    }
    await page.getByTestId("v3-task-components-managed-long").evaluate(el=>el.scrollIntoView({block:"center",behavior:"instant"}));
    await capture("managed-long-row");
    if(width===1440) {
      await page.getByTestId("managed-long-fixture").evaluate(el=>{el.style.width="340px";});
      const narrow = await page.getByTestId("v3-task-components-managed-long").evaluate(row=>({
        column:getComputedStyle(row.querySelector('.v3-run-trailing')!).gridColumnStart,
        copyWidth:row.querySelector('.v3-run-copy')!.getBoundingClientRect().width,
        labels:[...row.querySelectorAll('.v3-status-label')].map(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}))}));
      expect.soft(narrow.column).toBe("2");
      for (const label of narrow.labels) expect.soft(label.scrollWidth).toBeLessThanOrEqual(label.width);
      writeFileSync(path.join(output, `${name}-narrow-panel-metrics.json`), JSON.stringify(narrow,null,2));
      await capture("managed-narrow-panel");
    }
    return;
  }
  await page.locator("#components-heads").evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" })); await capture("unchanged-heads");
  const headers = await page.getByTestId("components-panel-headers").locator("header").evaluateAll(elements => elements.map(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const children = [...el.children].map(child => child.getBoundingClientRect());
    return { paddingTop: s.paddingTop, paddingBottom: s.paddingBottom, marginBottom:s.marginBottom,
      rect:r.toJSON(), aboveLine:r.bottom - Math.max(...children.map(c => c.bottom)),
      nextTop: el.parentElement?.querySelector('.v3-detail-section-head, [data-slot="chat-message-row"]')?.getBoundingClientRect().top,
      childRects:children.map(c=>c.toJSON()) };
  }));
  await expect(page.getByTestId("components-panel-headers").getByTestId("session-model-preset")).toHaveText("Claude Opus");
  await capture("panel-headers");
  for (const h of headers) { expect.soft(h.paddingBottom).toBe("12px"); expect.soft(h.marginBottom).toBe("28px"); expect.soft(h.nextTop! - h.rect.bottom).toBeCloseTo(28, 0); }
  writeFileSync(path.join(output, `${name}-header-metrics.json`), JSON.stringify(headers, null, 2));
  if (process.env.BOUNDARIES_ONLY) return;
  await page.locator("#components-input").evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" }));
  const editor = page.getByLabel("검수 메시지");
  const inputs = [];
  for (const [state, value] of [["placeholder", ""], ["one-line", "샘플 메시지"], ["multiline", "샘플 메시지\n샘플 메시지\n샘플 메시지"]]) {
    await editor.fill(value);
    const metrics = await readComposer(editor);
    inputs.push({ state, ...metrics });
    await capture(`input-${state}`);
    expect.soft(metrics.font).toBe("17px"); expect.soft(metrics.line).toBe(25);
    for (const button of metrics.buttons) {
      expect.soft(Math.abs(button.bottomInset - metrics.framePaddingBottom - metrics.borderBottom)).toBeLessThanOrEqual(1);
      if (state !== "multiline") expect.soft(Math.abs(button.topInset - button.bottomInset)).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(button.center - metrics.lastLineCenter)).toBeLessThanOrEqual(1);
    }
    expect.soft(Math.abs(metrics.ink.topInset - metrics.ink.bottomInset)).toBeLessThanOrEqual(3);
    expect.soft(metrics.ancestors.filter(a => a.paddingTop !== "0px" || a.paddingBottom !== "0px")).toHaveLength(0);
  }
  writeFileSync(path.join(output, `${name}-input-metrics.json`), JSON.stringify(inputs, null, 2));
  const surfaces = [];
  const chip = page.getByRole("button", { name: "샘플 폴더 선택" });
  const reference = await readSurface(chip); surfaces.push({ kind: "folder-chip", ...reference });
  await page.locator("#components-controls").evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" })); await capture("controls");
  const controls = page.getByTestId("components-review-controls");
  for (const el of await controls.locator('[role="combobox"], input:not([type="checkbox"]):not([aria-hidden="true"])').all()) {
    const surface = await readSurface(el); surfaces.push(surface);
    expect.soft(surface.background).toBe(reference.background);
    expect.soft(surface.ancestorOpacity).toBe(1);
  }
  const agent = controls.getByRole("combobox", { name: "에이전트 선택", exact: true });
  await agent.focus(); const focus = await readSurface(agent); expect.soft(focus.background).toBe(reference.background);
  await agent.click(); await capture("agent-options"); await page.keyboard.press("Escape");
  await page.locator("#components-surfaces").evaluate(el => el.scrollIntoView({ block:"center", behavior:"instant" })); await capture("description-view");
  const panel = page.locator("#components-surfaces .v3-description-shell").first();
  const view = await readSurface(panel.locator(".v3-description-preview"));
  expect.soft(view.background).toBe(reference.background);
  await panel.getByRole("button", { name: "폴더 설명 편집", exact: true }).first().click();
  await capture("description-edit"); const edit = await readSurface(panel.locator(".v3-description-editor"));
  expect.soft(edit.background).toBe(view.background);
  surfaces.push({ kind: "description-view", ...view }, { kind: "description-edit", ...edit });
  const composer = await readSurface(page.locator('[data-slot="chat-input-composer"]'));
  expect.soft(composer.background).toBe(reference.background);
  surfaces.push({ kind: "composer", ...composer });
  await page.goto("/");
  const liveInput = page.locator('[data-testid="card-composer"] textarea').first();
  await expect(liveInput).toBeVisible(); await liveInput.fill("샘플 메시지");
  const operationalInput = await readComposer(liveInput); await capture("operational-input");
  if (width < 760) {
    await page.getByTestId("v3-mobile-tab-projects").click();
    await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click();
  } else await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
  const context = page.getByTestId("v3-project-context");
  await expect(context).toBeVisible(); await capture("operational-context");
  expect(errors).toEqual([]);
  await page.getByTestId("v3-task-task-alpha").click({ timeout: 5000 });
  const livePanel = page.locator(".v3-description-preview").first();
  await expect(livePanel).toBeVisible();
  const operationalPanel = await readSurface(livePanel);
  expect.soft(operationalPanel.background).toBe(reference.background);
  await capture("operational-folder");
  await page.locator(".v3-description-shell").first().getByRole("button", { name: "폴더 설명 편집", exact:true }).first().click();
  await capture("operational-folder-edit");
  expect.soft((await readSurface(page.locator('.v3-description-editor').first())).background).toBe(reference.background);
  await page.keyboard.press('Escape');
  await page.getByTestId("v3-global-toolbar").getByRole("button", { name: "서버 설정" }).click();
  await expect(page.getByRole("heading", { name: "⚙️ 서버 설정" })).toBeVisible(); await capture("operational-settings");
  await expect(page.getByRole("dialog").getByTestId("config-field-row")).toHaveCount(3);
  const operationalSettings = [];
  for (const input of await page.getByRole('dialog').getByTestId('config-field-row').locator('input').all()) {
    const surface = await readSurface(input); operationalSettings.push(surface);
    expect.soft(surface.background).toBe(reference.background);
    expect.soft(surface.ancestorOpacity).toBe(1);
  }
  writeFileSync(path.join(output, `${name}-metrics.json`), JSON.stringify({ headers, inputs, surfaces, focus, operationalInput, operationalPanel, operationalSettings }, null, 2));
});
}

async function readSurface(locator: Locator) {
  return locator.evaluate(el => {
    const target = el.closest('[data-slot="input-control"]') ?? el;
    const s = getComputedStyle(target), p = getComputedStyle(target, "::before");
    let ancestorOpacity = 1;
    for (let node: Element | null = target; node; node = node.parentElement) ancestorOpacity *= Number(getComputedStyle(node).opacity);
    const background = target.getAttribute("data-liquid-glass-webgl") === "true" ? p.backgroundColor : s.backgroundColor;
    return { tag: target.tagName, label: el.getAttribute("aria-label"), background,
      opacity: s.opacity, ancestorOpacity, before: { background: p.backgroundColor, opacity: p.opacity, content: p.content },
      border: s.borderColor, backdrop: s.backdropFilter, token: s.getPropertyValue("--v3-glass-dense").trim(),
      rect: target.getBoundingClientRect().toJSON(), webgl: target.getAttribute("data-liquid-glass-webgl") };
  });
}

async function readComposer(editor: Locator) {
  return editor.evaluate(input => {
    const el = input as HTMLTextAreaElement, frame = el.closest('[data-slot="chat-input-composer"]')!;
    const r = el.getBoundingClientRect(), f = frame.getBoundingClientRect(), s = getComputedStyle(el), fs = getComputedStyle(frame);
    const line = parseFloat(s.lineHeight), pt = parseFloat(s.paddingTop), pb = parseFloat(s.paddingBottom);
    const lines = (el.value || el.placeholder).split("\n");
    const mirror = document.createElement("div");
    mirror.style.cssText = `position:fixed;visibility:hidden;left:0;top:0;width:${r.width}px;font:${s.font};line-height:${s.lineHeight};white-space:pre-wrap;`;
    const text = document.createElement("span"); text.textContent = lines[0];
    const baseline = document.createElement("i"); baseline.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;";
    mirror.append(text, baseline); document.body.append(mirror);
    const baselineOffset = baseline.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    mirror.remove();
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!; ctx.font = s.font;
    const first = ctx.measureText(lines[0]), last = ctx.measureText(lines.at(-1)!);
    const inkTop = r.top + pt + baselineOffset - first.actualBoundingBoxAscent;
    const inkBottom = r.bottom - pb - line + baselineOffset + last.actualBoundingBoxDescent;
    const ancestors = [];
    for (let n = el.parentElement; n && n !== frame; n = n.parentElement) {
      const ns = getComputedStyle(n); ancestors.push({ tag: n.tagName, paddingTop: ns.paddingTop, paddingBottom: ns.paddingBottom, height: ns.height, display: ns.display });
    }
    return { font: s.fontSize, line, padding: s.padding, height: r.height, minHeight: s.minHeight,
      frame: f.toJSON(), framePaddingTop: parseFloat(fs.paddingTop), framePaddingBottom: parseFloat(fs.paddingBottom),
      borderBottom: parseFloat(fs.borderBottomWidth), textarea: r.toJSON(), ancestors,
      lastLineCenter: r.bottom - pb - line / 2,
      ink: { baselineOffset, ascent: first.actualBoundingBoxAscent, descent: last.actualBoundingBoxDescent, topInset: inkTop - f.top, bottomInset: f.bottom - inkBottom },
      buttons: [...frame.querySelectorAll("button")].map(b => { const q = b.getBoundingClientRect(); return { label: b.getAttribute("aria-label"), rect: q.toJSON(), topInset: q.top - f.top, bottomInset: f.bottom - q.bottom, center: q.y + q.height / 2 }; }) };
  });
}
