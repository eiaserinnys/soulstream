import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const phase = process.env.COMPONENTS_REVIEW_PHASE;
if (!phase) throw new Error("COMPONENTS_REVIEW_PHASE is required");
const output = path.resolve("../../../.local/artifacts/20261001-components-feedback");
mkdirSync(output, { recursive: true });

async function prepare(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-01T00:00:00Z") });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    // Account preferences own the font size on both routes.
    localStorage.setItem("soul-user-preferences:qa@example.test", JSON.stringify({ chatFontSize: 17 }));
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1,
    liveEventText: "채팅 말풍선과 입력창의 글자 크기를 대조합니다." });
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true,
    user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", r => r.fulfill({ json: { preferences: { chatFontSize: 17 }, hasBackground: false } }));

}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `${phase}-${name}.png`), animations: "disabled" });
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
        font: s.fontSize, line: s.lineHeight, padding: s.padding, pt: parseFloat(s.paddingTop),
        pb: parseFloat(s.paddingBottom), bt: parseFloat(s.borderTopWidth), bb: parseFloat(s.borderBottomWidth),
        gap: s.gap, radius: s.borderRadius, outline: s.outlineStyle, resize: s.resize,
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth, scrollTop: el.scrollTop };
    };
    const root = document.querySelector('[data-testid="components-review"]') ?? document;
    return {
      rows: [...root.querySelectorAll(".v3-run-row")].map(row => ({ self: box(row),
        open: box(row.querySelector(".v3-run-open")), avatar: box(row.querySelector(".v3-run-avatar")),
        title: box(row.querySelector(".v3-run-title-line")), agent: box(row.querySelector(".v3-run-agent-line")),
        identity: box(row.querySelector(".v3-run-identity")), copy: box(row.querySelector(".v3-run-copy")),
        chip: box(row.querySelector("[data-slot=status-chip]")), time: box(row.querySelector("time")),
        trailing: box(row.querySelector(".v3-run-trailing")) })),
      folder: box(root.querySelector(".v3-task-card")), document: box(root.querySelector(".v3-inline-board-row")),
      caps: [...root.querySelectorAll(".v3-inline-board-row .dashboard-icon-cap")].map(box),
      chips: [...root.querySelectorAll("[data-slot=status-chip]")].map(el => ({ ...box(el), text: el.textContent })),
      head: box(root.querySelector("#components-heads .v3-detail-section-head")),
      headTitle: box(root.querySelector("#components-heads h3")),
      headItem: box(root.querySelector("#components-heads .v3-run-row")),
      body: box(root.querySelector('[data-slot="chat-body"] p')),
      input: box(root.querySelector('[data-slot="chat-input-body"]')),
      paperclip: box(root.querySelector('button[title="Attach files"]')),
      send: box(root.querySelector('[data-testid="send-button"]')),
      editor: box(root.querySelector('.v3-description-editor textarea')),
      composer: box(root.querySelector('[data-slot="chat-input-composer"]')),
      emptyModeSlots: root.querySelectorAll('[data-slot="chat-input-mode"]:empty').length,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}

for (const width of [1440, 390]) {
  test(`feedback contracts and existing surfaces ${width}`, async ({ page }) => {
    await prepare(page, width);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/components");
    await expect(page.getByTestId("components-review")).toBeVisible();
    await capture(page, `components-${width}-rows`);
    const initial = await metrics(page);
    await page.locator("[data-board-kind=markdown]").scrollIntoViewIfNeeded();
    await capture(page, `components-${width}-documents`);
    await page.locator("#components-heads").scrollIntoViewIfNeeded();
    await capture(page, `components-${width}-heads`);
    await page.locator("#components-bubbles").scrollIntoViewIfNeeded();
    await capture(page, `components-${width}-bubbles`);
    await page.getByRole("button", { name: "검수 이미지", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByLabel("검수 메시지").fill("첫 줄\n둘째 줄\n셋째 줄");
    await capture(page, `components-${width}-input`);
    const multiline = await metrics(page);
    await page.getByRole("button", { name: "폴더 설명 편집", exact: true }).first().click();
    const editor = page.getByLabel("폴더 설명 마크다운");
    await editor.fill("폴더 설명 첫 줄");
    await editor.press("End");
    for (let index = 0; index < 25; index++) await editor.press("Enter");
    await editor.pressSequentially("마지막 커서 줄");
    await capture(page, `components-${width}-description`);
    const editing = await metrics(page);
    await page.getByRole("button", { name: "완료", exact: true }).click();
    await expect(editor).toHaveCount(0);

    const controls = page.getByTestId("components-review-controls");
    await controls.getByLabel("에이전트 선택", { exact: true }).selectOption("seosoyoung");
    await expect(controls.getByLabel("에이전트 선택", { exact: true })).toHaveValue("seosoyoung");
    await expect(controls.getByLabel("기본 실행 에이전트")).toBeDisabled();
    await controls.getByRole("combobox", { name: "모델 선택" }).click();
    await expect(page.getByRole("option", { name: /사용 불가 샘플/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    const settingRows = controls.getByTestId("config-field-row");
    await settingRows.nth(0).locator("input").fill("로컬 입력 변경");
    await settingRows.nth(1).getByRole("switch").click();
    await expect(settingRows.nth(1).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await settingRows.nth(2).getByTitle("보기", { exact: true }).click();
    await expect(settingRows.nth(2).locator("input")).toHaveAttribute("type", "text");
    await expect(settingRows.nth(3).locator("input")).toBeDisabled();
    await page.getByRole("button", { name: "검수 폴더 펼치기", exact: true }).click();
    await capture(page, `components-${width}-controls`);
    await page.getByRole("button", { name: "샘플 폴더 선택" }).click();
    await page.getByRole("tab", { name: "전체", exact: true }).click();
    await page.locator(".v3-folder-picker").getByRole("button", { name: "검수 폴더 펼치기", exact: true }).click();
    const sampleNames = await page.locator(".v3-folder-picker .v3-project-nav-link").evaluateAll(links => links.map(link => {
      const icon = link.parentElement!.querySelector(".v3-project-tree-icon")!.getBoundingClientRect(), r = link.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, h: r.height, iconY: icon.y, label: link.textContent };
    }));
    for (const name of sampleNames) expect.soft(name.y).toBeLessThanOrEqual(name.iconY);
    await capture(page, `components-${width}-picker`);
    await page.keyboard.press("Escape");
    const variants: Record<string, unknown> = {};
    for (const variant of ["compact", "daily", "inline"] as const) {
      const label = variant === "inline" ? "검수 문서" : `${variant} 설명`;
      if (variant === "inline") await page.locator(".v3-inline-board-expand").click();
      await page.getByRole("button", { name: `${label} 편집`, exact: true }).first().click();
      const input = page.getByLabel(`${label} 마크다운`);
      await input.fill("긴 설명\n".repeat(30) + "마지막 커서 줄");
      await input.press("Control+End");
      const dimensions = await input.evaluate(el => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return { font: s.fontSize, line: s.lineHeight, right: r.right, h: r.height,
          maxHeight: s.maxHeight, outline: s.outlineStyle, resize: s.resize,
          scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
          parentRight: el.parentElement!.getBoundingClientRect().right };
      });
      variants[variant] = dimensions;
      expect.soft(dimensions.font).toBe(initial.input!.font);
      expect.soft(dimensions.line).toBe(initial.input!.line);
      expect.soft(dimensions.right).toBeLessThanOrEqual(dimensions.parentRight);
      expect.soft(dimensions.h).toBeLessThanOrEqual(parseFloat(dimensions.maxHeight));
      expect.soft(dimensions.scrollTop + dimensions.clientHeight).toBeGreaterThanOrEqual(dimensions.scrollHeight - 25);
      await capture(page, `components-${width}-description-${variant}`);
      await input.press("Control+Enter");
      await expect(input).toHaveCount(0);
    }
    writeFileSync(path.join(output, `${phase}-${width}-metrics.json`), JSON.stringify({ initial, multiline, editing, variants, sampleNames, errors }, null, 2));

    for (const row of initial.rows) {
      expect.soft(row.avatar!.y).toBeCloseTo(row.title!.y, 0);
      expect.soft(row.avatar!.bottom).toBeCloseTo(row.agent!.bottom, 0);
      expect.soft(row.chip!.y + row.chip!.h / 2).toBeCloseTo(row.title!.y + row.title!.h / 2, 0);
      expect.soft(row.time!.y + row.time!.h / 2).toBeCloseTo(row.agent!.y + row.agent!.h / 2, 0);
      expect.soft(row.chip!.right).toBeLessThanOrEqual(row.open!.right - row.open!.pt);
      expect.soft(row.open!.pt).toBe(row.open!.pb);
      expect.soft(row.self!.h).toBeCloseTo(row.self!.bt + row.self!.bb + row.open!.pt + row.open!.pb
        + Math.max(row.copy!.h, row.trailing!.h), 0);
    }
    expect.soft(initial.folder!.pt).toBe(initial.rows[0].open!.pt);
    expect.soft(initial.document!.pt).toBe(initial.rows[0].open!.pt);
    expect.soft(initial.caps).toHaveLength(2);
    for (const cap of initial.caps) { expect.soft(cap!.w).toBe(32); expect.soft(cap!.h).toBe(32); }
    expect.soft(initial.caps[0]?.y).toBe(initial.caps[1]?.y);
    expect.soft(initial.chips.some(chip => chip.text?.includes("카드 진행 중"))).toBe(true);
    expect.soft(initial.chips.some(chip => chip.text?.includes("세션 #1 실행 중"))).toBe(true);
    expect.soft(initial.headTitle!.font).toBe("16px");
    expect.soft(initial.headItem).not.toBeNull();
    if (initial.headItem) expect.soft(initial.headItem.y - initial.head!.bottom).toBe(12);
    expect.soft(initial.input!.font).toBe("17px");
    expect.soft(initial.body!.font).toBe(initial.input!.font);
    expect.soft(initial.body!.line).toBe(initial.input!.line);
    expect.soft(initial.paperclip!.w).toBe(initial.paperclip!.h);
    expect.soft(initial.paperclip!.radius).toBe("50%");
    expect.soft(initial.emptyModeSlots).toBe(0);
    expect.soft(multiline.send!.h).toBe(initial.send!.h);
    expect.soft(editing.editor!.font).toBe(initial.input!.font);
    expect.soft(editing.editor!.line).toBe(initial.input!.line);
    expect.soft(editing.editor!.outline).toBe("none");
    expect.soft(editing.editor!.resize).toBe("none");
    expect.soft(editing.editor!.scrollHeight).toBeGreaterThan(editing.editor!.clientHeight);
    expect.soft(editing.editor!.scrollTop + editing.editor!.clientHeight).toBeGreaterThanOrEqual(editing.editor!.scrollHeight - 25);
    expect.soft(editing.documentWidth).toBe(width);
    expect.soft(errors).toEqual([]);
  });
}

for (const width of [1440, 1024]) {
  test(`operational folder names ${width}`, async ({ page }) => {
    await prepare(page, width);
    await page.goto("/");
    const tree = page.getByTestId("v3-all-projects");
    await expect(tree.locator(".v3-project-nav-row").first()).toBeVisible();
    const measureNames = async (selector: string) => page.locator(selector).evaluateAll(rows => rows.map(row => {
      const icon = row.querySelector(".v3-project-tree-icon")!.getBoundingClientRect();
      const link = row.querySelector(".v3-project-nav-link")!, label = link.querySelector("span")!;
      const r = link.getBoundingClientRect(), l = label.getBoundingClientRect();
      return { name: label.textContent, iconY: icon.y, linkY: r.y, linkHeight: r.height,
        labelWidth: l.width, labelScrollWidth: label.scrollWidth, labelClientWidth: label.clientWidth,
        linkRight: r.right, rowRight: row.getBoundingClientRect().right, columns: getComputedStyle(row).gridTemplateColumns };
    }));
    const navigation = await measureNames('[data-testid="v3-all-projects"] .v3-project-nav-row');
    await capture(page, `operational-${width}-folder-tree`);
    await page.locator(".v3-card-handoff-folder").click();
    await expect(page.locator(".v3-folder-picker")).toBeVisible();
    await page.getByRole("tab", { name: "전체", exact: true }).click();
    const picker = await measureNames(".v3-folder-picker .v3-project-nav-row");
    const panelRows = await page.locator(".v3-session-panel .v3-run-row").evaluateAll(rows => rows.slice(0, 2).map(row => {
      const panel = row.closest(".v3-session-panel")!.getBoundingClientRect(), r = row.getBoundingClientRect();
      const chip = row.querySelector("[data-slot=status-chip]")!.getBoundingClientRect();
      return { panelRight: panel.right, rowRight: r.right, chipRight: chip.right, rowWidth: r.width };
    }));
    for (const row of panelRows) { expect.soft(row.rowRight).toBeLessThanOrEqual(row.panelRight); expect.soft(row.panelRight).toBeLessThanOrEqual(width); }

    await capture(page, `operational-${width}-folder-picker`);
    writeFileSync(path.join(output, `${phase}-${width}-folder-names.json`), JSON.stringify({ navigation, picker, panelRows }, null, 2));
    for (const row of [...navigation, ...picker]) {
      expect.soft(row.linkY).toBeLessThanOrEqual(row.iconY);
      expect.soft(row.linkY + row.linkHeight).toBeGreaterThan(row.iconY);
      expect.soft(row.linkRight).toBeCloseTo(row.rowRight, 0);
      if (row.name === "소울스트림") expect.soft(row.labelClientWidth).toBeGreaterThanOrEqual(row.labelScrollWidth);
    }
  });
}
