import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/card-checkitems-261005/web-captures");
const baseURL = process.env.CARD_CHECK_ITEMS_BASE_URL;
if (!baseURL) throw new Error("CARD_CHECK_ITEMS_BASE_URL must point to the local Vite server.");

async function prepare(page: Page, width: number) {
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()) && !url.pathname.includes("ui-events")) {
      writes.push(`${request.method()} ${url.pathname}`);
    }
  });
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width, height: width === 1920 ? 1080 : 810 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await page.clock.install({ time: new Date("2026-10-05T09:00:00Z") });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: "세션 대화 영역은 남는 폭을 사용합니다." });
  await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
  await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
  await page.goto(new URL("/components", baseURL).href);
  await expect(page.getByTestId("components-review")).toBeVisible();
  await page.locator(".v3-shell.v3-components-page").evaluate(element => (element as HTMLElement).style.setProperty("--v3-navigation-width", "336px"));
  return { errors, writes };
}

for (const width of [1920, 1440]) {
  test(`card check items, workspace width and return behavior ${width}`, async ({ page }) => {
    const { errors, writes } = await prepare(page, width);
    const board = page.getByTestId("card-board-sample");
    await board.scrollIntoViewIfNeeded();

    const rowSection = page.locator("#components-rows");
    await rowSection.scrollIntoViewIfNeeded();
    const row = rowSection.locator('[data-card-id="components-card-0"]');
    await expect(row.locator(".v3-card-progress-dot")).toHaveCount(7);
    await expect(row).toContainText("확인 3");
    await expect(row).toContainText("요청된 카드 화면을 확인하고 있습니다.");
    await expect(row).toContainText("볼 것 2");
    await expect(row).toContainText("보고된 결과 두 개를 확인해 주세요.");

    await board.scrollIntoViewIfNeeded();
    const postit = board.getByTestId("postit-size-comparison").locator(".v3-postit-open").first();
    await expect(postit.locator(".v3-card-progress-dot")).toHaveCount(7);
    await expect(postit).toContainText("볼 것 2");
    await postit.click();

    const workspace = page.getByTestId("v3-card-workspace");
    const detail = page.getByTestId("card-detail");
    await expect(workspace).toBeVisible();
    await expect(detail).toBeVisible();
    const expectedWorkspaceWidth = width === 1920 ? 1552 : 1072;
    const expectedChatWidth = expectedWorkspaceWidth - 466 - 16;
    await expect(workspace).toHaveAttribute("data-card-width-px", "466");
    const initialGeometry = await workspace.evaluate(element => {
      const detail = element.querySelector("[data-testid=card-detail]" )!.getBoundingClientRect();
      const chat = element.querySelector("[data-testid=v3-card-session-chat]")!.getBoundingClientRect();
      return { width: element.getBoundingClientRect().width, detail: detail.width, chat: chat.width };
    });
    expect(initialGeometry.width).toBe(expectedWorkspaceWidth);
    expect(initialGeometry.detail).toBe(466);
    expect(initialGeometry.chat).toBeCloseTo(expectedChatWidth, 2);

    const tabs = [...await detail.getByRole("tab").allTextContents()].map(value => value.replace(/\d+/g, "").trim());
    expect(tabs).toEqual(["확인 항목", "커멘트", "세션", "노트"]);
    await expect(detail.getByRole("tab", { name: /확인 항목/ })).toHaveAttribute("aria-selected", "true");
    await expect(detail.locator("[data-testid=card-check-items]")).toHaveAttribute("data-active-count", "7");
    const dropped = detail.locator('[data-item-id="7"]');
    await expect(dropped.locator("del")).toHaveText("요청에서 뺀 항목");
    await expect(dropped).toContainText("현재 범위에 포함되지 않습니다.");
    await expect(dropped.getByRole("checkbox")).toBeDisabled();
    await expect(dropped.getByRole("button", { name: "7번 항목 접기" })).toBeDisabled();
    await expect(detail.getByText("되돌리기", { exact: true })).toHaveCount(0);

    const evidenceImage = detail.getByRole("button", { name: "완료 화면", exact: true });
    await evidenceImage.focus();
    await page.keyboard.press("Enter");
    const imageDialog = page.getByRole("dialog");
    await expect(imageDialog.getByRole("img", { name: "완료 화면", exact: true })).toBeVisible();
    const activeElementAtImageOpen = width === 1920 ? await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active ? {
        tagName: active.tagName,
        role: active.getAttribute("role"),
        ariaLabel: active.getAttribute("aria-label"),
        testId: active.getAttribute("data-testid"),
        insideDialog: Boolean(active.closest('[data-slot="dialog-popup"]')),
        insideWorkspaceScrim: Boolean(active.closest(".v3-workspace-scrim")),
      } : null;
    }) : null;
    if (activeElementAtImageOpen) console.info(`activeElement after evidence open: ${JSON.stringify(activeElementAtImageOpen)}`);
    await page.keyboard.press("Escape");
    await expect(evidenceImage).toBeFocused();
    await expect(imageDialog).toHaveCount(0);
    await expect(detail).toBeVisible();

    await evidenceImage.click();
    await expect(imageDialog.getByRole("img", { name: "완료 화면", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(evidenceImage).toBeFocused();
    await expect(detail).toBeVisible();

    await detail.getByRole("tab", { name: "노트", exact: true }).click();
    await expect(detail.getByText("인계 요약", { exact: true })).toBeVisible();
    await expect(detail.getByTestId("card-notes").locator("[data-card-note-id]")).toHaveCount(5);
    await detail.getByRole("button", { name: "앞선 노트 1건" }).click();
    await expect(detail.getByTestId("card-notes").locator("[data-card-note-id]")).toHaveCount(6);
    await page.screenshot({ path: path.join(output, `${width}-notes.png`), animations: "disabled" });
    await detail.getByRole("tab", { name: "세션", exact: true }).click();
    await expect(detail.locator("[data-card-section=sessions]")).toBeVisible();
    await page.screenshot({ path: path.join(output, `${width}-sessions.png`), animations: "disabled" });
    await detail.getByRole("tab", { name: "확인 항목" }).click();

    const nowPanel = detail.getByTestId("card-now-panel");
    const currentLayout = await page.evaluate(() => {
      const panel = document.querySelector("[data-testid=card-now-panel]")!.getBoundingClientRect();
      const items = document.querySelector("[data-testid=card-check-items]")!.getBoundingClientRect();
      return { panelHeight: panel.height, firstItemY: items.y };
    });
    await page.screenshot({ path: path.join(output, `${width}-initial.png`), animations: "disabled" });

    await detail.locator('[data-item-id="1"] [role="checkbox"]').click();
    await expect(detail.locator('[data-item-id="1"] [role="checkbox"]')).toHaveAttribute("aria-checked", "true");
    await expect(detail.locator("[data-testid=card-check-items]")).toHaveAttribute("data-active-count", "6");
    await page.screenshot({ path: path.join(output, `${width}-still.png`), animations: "disabled" });

    await nowPanel.getByRole("button", { name: "이전 상황" }).click();
    await expect(nowPanel).toHaveAttribute("data-now-view", "past");
    await expect(nowPanel).toContainText("지난 상황");
    const pastLayout = await page.evaluate(() => {
      const panel = document.querySelector("[data-testid=card-now-panel]")!.getBoundingClientRect();
      const items = document.querySelector("[data-testid=card-check-items]")!.getBoundingClientRect();
      return { panelHeight: panel.height, firstItemY: items.y };
    });
    expect(pastLayout.panelHeight).toBe(currentLayout.panelHeight);
    expect(pastLayout.firstItemY).toBe(currentLayout.firstItemY);
    await page.screenshot({ path: path.join(output, `${width}-past.png`), animations: "disabled" });
    await nowPanel.getByRole("button", { name: "다음 상황" }).click();
    await expect(nowPanel).toHaveAttribute("data-now-view", "current");

    const divider = page.getByTestId("v3-card-workspace-divider");
    const dragBy = async (delta: number) => {
      const dragHandle = divider.locator(".cursor-col-resize");
      const box = await dragHandle.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + 8, box!.y + 80);
      await page.mouse.down();
      const cursorWhileDragging = await page.evaluate(() => document.body.style.cursor);
      await page.mouse.move(box!.x + 8 + delta, box!.y + 80);
      await page.mouse.up();
      if (width === 1920 && delta === -66) console.info(`divider drag: ${JSON.stringify({ box, cursorWhileDragging, width: await workspace.getAttribute("data-card-width-px") })}`);
    };
    await dragBy(-66);
    await expect(workspace).toHaveAttribute("data-card-width-px", "400");
    await page.screenshot({ path: path.join(output, `${width}-split-400.png`), animations: "disabled" });
    const stateAt400 = await detail.locator('[data-item-id="4"] .v3-card-check-item-state').boundingBox();
    const titleAt400 = await detail.locator('[data-item-id="4"] .v3-card-check-item-title').boundingBox();
    expect(stateAt400!.y).toBe(titleAt400!.y);
    await dragBy(-1);
    await expect(workspace).toHaveAttribute("data-card-width-px", "399");
    const stateAt399 = await detail.locator('[data-item-id="4"] .v3-card-check-item-state').boundingBox();
    const titleAt399 = await detail.locator('[data-item-id="4"] .v3-card-check-item-title').boundingBox();
    expect(stateAt399!.y).toBeGreaterThan(titleAt399!.y);
    await divider.focus();
    await page.keyboard.press("Home");
    await expect(workspace).toHaveAttribute("data-card-width-px", "466");

    await detail.locator('[data-item-id="5"] .v3-card-check-item-target').click();
    const input = detail.getByPlaceholder("커멘트", { exact: true });
    await expect(input).toBeFocused();
    await expect(detail.locator(".v3-card-target-notice")).toContainText("대상: 5번 남겨진 고칠 점이 표시됩니다");
    await input.fill("좁은 화면에서 상태 글이 제목 아래로 내려옵니다.");
    await detail.getByRole("tab", { name: "세션", exact: true }).click();
    await expect(input).toHaveValue("좁은 화면에서 상태 글이 제목 아래로 내려옵니다.");
    await detail.getByRole("tab", { name: "확인 항목" }).click();
    await detail.getByRole("button", { name: "커멘트 전송", exact: true }).click();
    await expect(detail.locator('[data-item-id="5"]')).toHaveAttribute("data-item-display", "fix");
    await expect(detail.locator('[data-item-id="5"] .v3-card-check-item-state')).toContainText("고칠 점 3");
    await expect(detail.locator(".v3-card-sent-notice")).toContainText("보냈습니다.");
    await expect(detail.getByRole("tab", { name: "확인 항목" })).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: path.join(output, `${width}-after-fix.png`), animations: "disabled" });
    await detail.getByRole("button", { name: "커멘트에서 보기", exact: false }).click();
    await expect(detail.getByRole("tab", { name: "커멘트" })).toHaveAttribute("aria-selected", "true");
    await expect(detail.locator(".v3-card-comment-target")).toContainText("5번");
    await expect(detail.getByRole("tab", { name: /커멘트/ })).toContainText("커멘트");
    await page.screenshot({ path: path.join(output, `${width}-target-comment.png`), animations: "disabled" });
    const reportImage = detail.getByRole("button", { name: "검수 이미지", exact: true });
    await reportImage.click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "검수 이미지", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, `${width}-comment-image.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(reportImage).toBeFocused();
    await expect(detail.getByRole("tab", { name: "커멘트" })).toHaveAttribute("aria-selected", "true");

    await detail.getByRole("tab", { name: "확인 항목" }).click();
    for (const id of [2, 3, 4, 5, 8, 9]) {
      await detail.locator(`[data-item-id="${id}"] [role="checkbox"]`).click();
    }
    await expect(detail.locator("[data-testid=card-check-items]")).toHaveAttribute("data-active-count", "0");
    await expect(nowPanel).toContainText("모두 확인했습니다. 완료로 옮길까요?");
    await expect(detail.locator(".v3-folder-header-actions")).toHaveAttribute("data-complete-emphasis", "true");
    expect(await detail.textContent()).not.toContain("되돌리기");
    await page.screenshot({ path: path.join(output, `${width}-all-checked.png`), animations: "disabled" });
    await detail.getByRole("button", { name: "완료", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.getByTestId("v3-card-workspace")).toHaveCount(0);

    const legacyCard = board.locator('[data-card-id="board-0-1"] .v3-postit-open');
    await legacyCard.scrollIntoViewIfNeeded();
    await legacyCard.click();
    const legacyDetail = page.getByTestId("card-detail");
    await expect(legacyDetail.getByRole("tab", { name: "커멘트", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(legacyDetail.getByTestId("card-now-panel")).toHaveCount(0);
    await expect(legacyDetail.locator('[data-card-entry="지시"]')).toBeVisible();
    await expect(legacyDetail.locator('[data-card-entry="보고"]')).toBeVisible();

    await legacyDetail.getByRole("button", { name: "카드 닫기", exact: true }).click();
    await board.getByRole("button", { name: "실행 중", exact: true }).click();
    await board.getByTestId("postit-size-comparison").locator(".v3-postit-open").first().click();
    const reducedDetail = page.getByTestId("card-detail");
    await reducedDetail.getByRole("tab", { name: "세션", exact: true }).click();
    const runningSession = reducedDetail.locator(".v3-card-session-history .v3-run-row").first();
    await expect(runningSession).toBeVisible();
    await expect(runningSession).toContainText("실행 중");
    const sessionStyleBefore = await runningSession.evaluate(element => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, background: style.backgroundColor, color: style.color };
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const sessionStyleAfter = await runningSession.evaluate(element => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, background: style.backgroundColor, color: style.color };
    });
    expect(sessionStyleAfter).toEqual(sessionStyleBefore);
    await reducedDetail.getByRole("tab", { name: "확인 항목" }).click();
    const doingRow = reducedDetail.locator('[data-item-display="doing"]').first();
    await expect(doingRow).toBeVisible();
    const reducedAnimation = await doingRow.evaluate(element => getComputedStyle(element, "::before").animationName);
    expect(reducedAnimation).toBe("none");
    await page.keyboard.press("Escape");
    await expect(reducedDetail).toHaveCount(0);
    await expect(page.getByTestId("v3-card-workspace")).toHaveCount(0);
    writeFileSync(path.join(output, `${width}-metrics.json`), JSON.stringify({
      viewport: { width, height: width === 1920 ? 1080 : 810 }, activeElementAtImageOpen,
      initialGeometry, currentLayout, pastLayout, stateAt400, titleAt400, stateAt399, titleAt399, sessionStyleBefore,
    }, null, 2));
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
  });
}
