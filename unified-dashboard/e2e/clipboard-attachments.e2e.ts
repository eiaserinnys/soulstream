import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output = path.resolve("../../../.local/artifacts/20261002-clipboard-attachments");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
// All network writes are isolated API fixtures. The inputs, upload hook and preview are production components.
async function setup(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({ folderId: "folder-amber", nodeId: "eiaserinnys", agentId: "roselin_codex", modelPreset: "qa-standard" }));
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true, value: async () => ({ update: async () => {}, active: null, addEventListener: () => {} }) });
  });
  const card = { ...reviewCard, id: "paste-card", title: "붙여넣기 검증", folderId: "folder-amber", status: "running" as const, assigneeSessionId: "run-alpha-2", nodeId: "eiaserinnys", assigneeAgentId: "roselin_codex" };
  const creates: Record<string, unknown>[] = [], comments: Record<string, unknown>[] = [], interventions: Record<string, unknown>[] = [];
  const uploads: Array<{ node: string; body: string }> = [];
  let releaseB: (() => void) | undefined;
  let holdB = false;
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, successionPickerRuns: true, postitCards: [card], liveEventText: "대화 검증", timelineEventCount: 1, onSessionCreate: body => creates.push(body) });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/auth/config") return json({ authEnabled: true, devModeEnabled: false });
    if (url.pathname === "/api/auth/status") return json({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } });
    if (url.pathname === "/api/nodes/qa-node/agents") return json({ agents: [{ id: "roselin_codex", name: "로젤린", backend: "codex", default_preset: "qa-standard", portraitUrl: null }] });
    if (url.pathname === "/api/attachments/sessions") {
      const node = url.searchParams.get("nodeId")!;
      const body = request.postDataBuffer()!.toString();
      expect(body).toMatch(/filename="clipboard-[^"]+\.png"/);
      expect(body).toContain('name="session_id"'); uploads.push({ node, body });
      if (node === "qa-node" && holdB) await new Promise<void>(resolve => { releaseB = resolve; });
      return json({ path: `/${node}/clipboard.png` });
    }
    if (url.pathname === "/api/cards/paste-card/comments") { comments.push(request.postDataJSON()); return json({ card, reports: [], comments: [], questions: [], sessions: [] }); }
    if (url.pathname === "/api/cards/paste-card") return json({ card, reports: [], comments: [], questions: [], sessions: [] });
    if (/\/api\/sessions\/[^/]+\/intervene$/.test(url.pathname)) { interventions.push(request.postDataJSON()); return json({ status: "ok", delivered: true }); }
    return route.fallback();
  });
  return { creates, comments, interventions, uploads, hold: () => { holdB = true; }, release: () => { holdB = false; releaseB?.(); } };
}
async function paste(input: Locator) {
  await expect(input).toBeVisible();
  expect(await input.evaluate((element, encoded) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], "image.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, png)).toBe(true);
}
async function capture(page: Page, name: string) {
  mkdirSync(output, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}
async function folder(page: Page, width: number) {
  if (width < 760) { await page.getByTestId("v3-mobile-tab-projects").click(); await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click(); }
  else await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
}

for (const width of [1440, 390]) {
  test(`main paste preserves file selection preview at ${width}`, async ({ page }) => {
    const state = await setup(page, width); await page.goto("/");
    const composer = page.locator(".v3-card-handoff"), input = composer.locator("textarea");
    await expect(input).toBeVisible();
    expect(await input.evaluate(element => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "일반 텍스트");
      const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(false);
    await composer.locator('input[type="file"]').setInputFiles({ name: "clipboard-selected.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    const preview = composer.locator('img[alt^="clipboard-"]');
    await expect(preview).toBeVisible();
    const selectedBounds = await preview.boundingBox();
    await capture(page, `main-selected-${width}`);
    await composer.getByRole("button", { name: "Remove file", exact: true }).click();
    await expect(preview).toHaveCount(0); await paste(input);
    await expect(preview).toBeVisible();
    expect(await preview.boundingBox()).toEqual(selectedBounds);
    await input.fill("이미지를 확인합니다");
    await expect(composer.getByTestId("send-button")).toBeEnabled();
    await capture(page, `main-pasted-${width}`);
    await composer.getByTestId("send-button").click();
    await expect.poll(() => state.creates.length).toBe(1);
    expect(state.creates[0]).toMatchObject({ nodeId: "eiaserinnys", attachmentPaths: ["/eiaserinnys/clipboard.png"] });
  });
  test(`new conversation paste and A→B at ${width}`, async ({ page }) => {
    const state = await setup(page, width); await page.goto("/"); await folder(page, width);
    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 세션", exact: true });
    await dialog.getByLabel("노드 선택", { exact: true }).selectOption("eiaserinnys");
    // Existing soulstream-e2e Base UI Select interaction: select only the open popup.
    await dialog.getByLabel("에이전트 선택", { exact: true }).click();
    await page.locator('[data-slot="select-positioner"]:not([hidden]) [data-slot="select-item"]').filter({ hasText: "로젤린" }).first().click();
    await dialog.locator("textarea").fill("이미지를 확인합니다"); await paste(dialog.locator("textarea"));
    await expect.poll(() => state.uploads.length).toBe(1);
    await expect(dialog.locator(".v3-succession-footer button:last-child")).toBeEnabled();
    await capture(page, `new-conversation-${width}`);
    state.hold(); await dialog.getByLabel("노드 선택", { exact: true }).selectOption("qa-node");
    await expect.poll(() => state.uploads.length).toBe(2);
    await expect(dialog.locator(".v3-succession-footer button:last-child")).toBeDisabled(); expect(state.creates).toHaveLength(0);
    state.release(); await expect(dialog.locator(".v3-succession-footer button:last-child")).toBeEnabled();
    await dialog.locator(".v3-succession-footer button:last-child").click();
    await expect.poll(() => state.creates.length).toBe(1);
    expect(state.creates[0]).toMatchObject({ nodeId: "qa-node", attachmentPaths: ["/qa-node/clipboard.png"] });
    expect(state.creates[0].initial_instruction).not.toContain("/eiaserinnys/clipboard.png");
    writeFileSync(path.join(output, `new-conversation-${width}.json`), JSON.stringify({ creates: state.creates, uploads: state.uploads.map(upload => upload.node) }, null, 2));
  });
  test(`comment and session paste at ${width}`, async ({ page }) => {
    const state = await setup(page, width); await page.goto("/");
    await page.getByRole("button", { name: "카드 붙여넣기 검증 열기", exact: true }).click();
    const detail = page.getByTestId("card-detail");
    await paste(detail.getByPlaceholder("커멘트", { exact: true }));
    await expect(detail.getByRole("button", { name: "커멘트 전송", exact: true })).toBeEnabled();
    await expect(detail.locator('[data-testid="card-composer"] img')).toBeVisible();
    await capture(page, `comment-${width}`);
    await detail.getByRole("button", { name: "커멘트 전송", exact: true }).click();
    await expect.poll(() => state.comments.length).toBe(1); expect(JSON.stringify(state.comments)).toContain("%2Feiaserinnys%2Fclipboard.png");
    await detail.getByRole("button", { name: "카드 닫기", exact: true }).click();
    await folder(page, width);
    await page.locator('[data-task-section="sessions"] .v3-run-open').first().click();
    const input = page.locator('.v3-chat-pane [data-slot="chat-input-body"]');
    await input.fill("이미지를 확인합니다");
    await paste(input); await expect(page.locator('.v3-chat-pane img[alt^="clipboard-"]')).toBeVisible();
    await capture(page, `session-${width}`); await input.press("Control+Enter");
    await expect.poll(() => state.interventions.length).toBe(1);
    expect(state.interventions[0]).toMatchObject({ attachmentPaths: ["/eiaserinnys/clipboard.png"] });
  });
}
