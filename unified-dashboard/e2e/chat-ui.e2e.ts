import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { composeText } from "@soulstream/chat-ui";
import { installChatUiRoutes, openChatUi, chatUiSession, type ChatUiExample } from "./chat-ui-fixtures";

const output = path.resolve("../../../.local/artifacts/pas-web-w4");
mkdirSync(output, { recursive: true });
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}
async function endFocus(draft: Locator) {
  await expect(draft).toBeFocused();
  expect(await draft.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([
    (await draft.inputValue()).length, (await draft.inputValue()).length,
  ]);
}
async function select(root: Locator, page: Page, label = "웹 먼저") {
  await root.getByRole("combobox", { name: "진행 순서" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(root.getByRole("combobox", { name: "진행 순서" })).toContainText(label);
}
async function setTwelve(root: Locator) {
  const slider = root.getByRole("slider", { name: "인원수" });
  await slider.press("Home");
  for (let i = 0; i < 11; i++) await slider.press("ArrowRight");
  await root.getByRole("checkbox", { name: "연간 결제 (20% 할인)", exact: true }).check();
  await expect(root.getByText("278,400원/월", { exact: true })).toBeVisible();
}

for (const pas of [false, true]) for (const width of [1440, 360]) {
  test(`actual ${pas ? "PAS" : "column"} history, compose, attachment and undo ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const example: ChatUiExample = pas ? "pas" : "normal";
    const h = await installChatUiRoutes(page, { example });
    const root = await openChatUi(page, pas);
    const label = `${pas ? "pas" : "general"}-${width}`;
    await capture(page, `${label}-base`);
    if (pas) {
      await root.getByRole("combobox", { name: "진행 순서" }).click();
      if (width === 360) await capture(page, "pas-360-choice");
      await page.getByRole("option", { name: "웹 먼저", exact: true }).click();
      await root.getByRole("checkbox", { name: "전체 초기화", exact: true }).check();
      await root.getByRole("textbox", { name: "덧붙일 말" }).fill("기존 초안도 남겨줘");
    } else {
      await setTwelve(root);
      await capture(page, `${label}-after`);
    }
    expect(h.sourceRequests()).toBe(0);
    const draft = root.locator('textarea[data-slot="chat-input-body"]');
    const before = width === 360 ? "  쓰던 긴 초안\n" + "기존 초안과 첨부를 그대로 남깁니다. ".repeat(30) : "  쓰던 글\n";
    await draft.fill(before);
    await root.locator('input[type="file"]').setInputFiles({ name: "검수 메모와 긴 파일 이름.pdf", mimeType: "application/pdf", buffer: Buffer.from("fixture") });
    await expect(root.getByText("검수 메모와 긴 파일 이름.pdf", { exact: true })).toBeVisible();
    await expect(root.getByTestId("send-button")).toBeEnabled();
    const mode = await root.getByTestId("send-button").getAttribute("data-button-variant");
    const state = pas ? { values: { memo: "기존 초안도 남겨줘", notify: true, order: "web", checks: ["focus", "reset"] } }
      : { values: { seats: 12, annual: true, memo: "", notify: true, order: "app", checks: ["focus"] } };
    const generated = composeText(h.doc, state, pas ? "form" : "compose");
    await root.getByRole("button", { name: pas ? "이 순서로 요청" : "이 조건으로 질문", exact: true }).click();
    await expect(draft).toHaveValue(before + "\n\n" + generated); await endFocus(draft);
    expect(h.sends).toEqual([]);
    await expect(root.getByText("검수 메모와 긴 파일 이름.pdf", { exact: true })).toBeVisible();
    expect(await root.getByTestId("send-button").getAttribute("data-button-variant")).toBe(mode);
    await expect(root.getByRole("button", { name: "되돌리기", exact: true })).toBeVisible();
    const geometry = await root.evaluate(node => {
      const editor = node.querySelector('textarea')!, row = node.querySelector('[data-slot="chat-input-accessories"]')!;
      const undo = row.querySelector('[data-slot="chat-input-accessories-action"] button')!, composer = node.querySelector('[data-slot="chat-input-composer"]')!;
      const attachment = row.querySelector('[data-slot="chat-input-accessories-attachments"]')!;
      const er = editor.getBoundingClientRect(), rr = row.getBoundingClientRect(), ur = undo.getBoundingClientRect(), ar = attachment.getBoundingClientRect();
      return { rowBottom: rr.bottom, composerTop: composer.getBoundingClientRect().top, undoCenter: ur.y + ur.height / 2,
        attachmentCenter: ar.y + ar.height / 2, editorFont: getComputedStyle(editor).fontSize, undoFont: getComputedStyle(undo).fontSize,
        attachmentScrollbar: getComputedStyle(attachment.firstElementChild!).scrollbarWidth, editorX: er.x };
    });
    expect(geometry.undoFont).toBe(geometry.editorFont);
    expect(Math.abs(geometry.undoCenter - geometry.attachmentCenter)).toBeLessThanOrEqual(1);
    expect(geometry.attachmentScrollbar).toBe("none");
    writeFileSync(path.join(output, `${label}-geometry.json`), JSON.stringify({ geometry, identities: h.identities }, null, 2));
    if (pas) await root.getByRole("combobox", { name: "진행 순서" }).scrollIntoViewIfNeeded();
    await capture(page, `${label}-compose-attachment-undo`);
    await root.getByRole("button", { name: "되돌리기", exact: true }).click();
    await expect(draft).toHaveValue(before); await endFocus(draft);
    await root.getByRole("button", { name: pas ? "이 순서로 요청" : "이 조건으로 질문", exact: true }).click();
    await draft.fill((await draft.inputValue()) + " 편집");
    await expect(root.getByRole("button", { name: "되돌리기", exact: true })).toHaveCount(0);
    await root.getByRole("button", { name: "복사", exact: true }).click();
    const notice = root.locator('[data-testid="chat-input"] [role="status"]');
    await expect(notice).toHaveText("현재 값 복사됨");
    const noticeGeometry = await notice.evaluate(el => {
      const editor = el.parentElement!.querySelector('textarea')!, er = editor.getBoundingClientRect(), nr = el.getBoundingClientRect();
      return { textStart: nr.x + parseFloat(getComputedStyle(el).paddingInlineStart), editorStart: er.x, top: nr.top, editorBottom: er.bottom, font: getComputedStyle(el).fontSize };
    });
    expect(Math.abs(noticeGeometry.textStart - noticeGeometry.editorStart)).toBeLessThanOrEqual(1);
    expect(noticeGeometry.top).toBeGreaterThan(noticeGeometry.editorBottom); expect(noticeGeometry.font).toBe("12px");
    await capture(page, `${label}-notice`);
    await root.getByRole("button", { name: "초기화", exact: true }).click();
    await expect(notice).toHaveText("기본값으로 돌아갔어");
    await root.getByRole("checkbox", { name: pas ? "결과 알림" : "연간 결제 (20% 할인)", exact: true }).click();
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("");
    if (!pas && width === 1440) {
      await root.getByTestId("send-button").click();
      await expect.poll(() => h.sends.length).toBe(1);
      expect(JSON.stringify(h.sends[0])).toContain("/fixture/메모.pdf");
      await expect(draft).toHaveValue("");
      await expect(notice).toHaveCount(0);
      await expect(root.getByText("검수 메모와 긴 파일 이름.pdf", { exact: true })).toHaveCount(0);
    }
    expect(h.errors).toEqual([]);
  });
}

for (const pas of [false, true]) {
  test(`opened feedback preserves same-coordinate checkbox and slider targets ${pas ? "PAS" : "column"}`, async ({ page }) => {
    const h = await installChatUiRoutes(page);
    const root = await openChatUi(page, pas);
    const scroller = root.locator('[data-virtuoso-scroller="true"]');
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await root.getByRole("button", { name: "초기화", exact: true }).click();
    const notice = root.locator('[data-testid="chat-input"] [role="status"]');
    await expect(notice).toHaveText("기본값으로 돌아갔어");
    const checkbox = root.getByRole("checkbox", { name: "연간 결제 (20% 할인)", exact: true });
    const slider = root.getByRole("slider", { name: "인원수", exact: true });
    const cr = (await checkbox.boundingBox())!, sr = (await root.locator('[data-slot="slider-track"]').boundingBox())!;
    const thumb = (await root.locator('[data-slot="slider-thumb"]').boundingBox())!;
    const noticeHeight = (await notice.boundingBox())!.height;
    const point = { x: cr.x + cr.width / 2, y: cr.y + cr.height / 2 };
    await page.mouse.click(point.x, point.y); await expect(checkbox).toBeChecked();
    await expect(notice).toHaveText("");
    await page.mouse.click(point.x, point.y); await expect(checkbox).not.toBeChecked();
    expect(await checkbox.boundingBox()).toEqual(cr);
    expect((await notice.boundingBox())!.height).toBe(noticeHeight);
    await capture(page, `${pas ? "pas" : "general"}-feedback-empty-line`);
    // 9 keeps this approved document's conditional 10+ person hint closed.
    // Opening that new content intentionally changes the row's natural height.
    const thumbX = thumb.x + thumb.width / 2, thumbY = thumb.y + thumb.height / 2;
    await page.mouse.move(thumbX, thumbY); await page.mouse.down();
    await page.mouse.move(thumbX + (sr.width - thumb.width) / 49, thumbY);
    await page.mouse.up();
    await expect(slider).toHaveAttribute("aria-valuenow", "9");
    expect(await checkbox.boundingBox()).toEqual(cr);
    expect((await notice.boundingBox())!.height).toBe(noticeHeight);
    await root.locator('textarea[data-slot="chat-input-body"]').fill("새 안내 수명 검증");
    await root.getByTestId("send-button").click();
    await expect.poll(() => h.sends.length).toBe(1);
    await expect(notice).toHaveCount(0);
    expect(h.errors).toEqual([]);
  });
}

test("live UI stays independent of streaming/final text, virtual rows, history and session lifetimes", async ({ page }) => {
  const h = await installChatUiRoutes(page, { count: 160, live: true });
  const root = await openChatUi(page);
  await setTwelve(root);
  const scroller = root.locator('[data-virtuoso-scroller="true"]');
  await scroller.hover(); await page.mouse.wheel(0, -100000);
  await expect(root.locator(".chat-ui")).toHaveCount(0);
  await expect.poll(() => h.histories.filter(cursor => cursor !== null).length).toBeGreaterThan(0);
  await page.mouse.wheel(0, 100000);
  await expect(root.getByText("278,400원/월", { exact: true })).toBeVisible();
  h.releaseLive();
  await expect(root.locator(".chat-ui")).toHaveCount(2);
  await expect(root.locator('[data-slot="chat-body"]').filter({ hasText: /^앞뒤$/ })).toContainText("앞뒤");
  await expect(root.locator(".animate-caret-blink")).toHaveCount(1);
  h.releaseFinal();
  await expect(root.getByText("앞뒤 최종 답", { exact: true })).toBeVisible();
  await expect(root.locator(".animate-caret-blink")).toHaveCount(0);
  await expect(root.locator('[data-slot="chat-thinking-indicator"]')).toHaveCount(0);
  h.releaseDuplicate(); await expect(root.locator(".chat-ui")).toHaveCount(2);
  // Move by the real search result navigation, retaining the same browser document.
  await page.route("**/cogito/search**", route => route.fulfill({ json: { results: [], session_results: [
    { session_id: "run-alpha-1", title: "다른 세션", excerpt: "다른 세션으로 이동", evidence: [], session_url: "/?session=run-alpha-1", best_match: { event_id: null, match_source: "session_title", excerpt: "다른 세션으로 이동" } },
    { session_id: chatUiSession, title: "원래 세션", excerpt: "원래 세션으로 돌아가기", evidence: [], session_url: `/?session=${chatUiSession}`, best_match: { event_id: null, match_source: "session_title", excerpt: "원래 세션으로 돌아가기" } },
  ] } }));
  for (const excerpt of ["다른 세션으로 이동", "원래 세션으로 돌아가기"]) {
    await page.keyboard.press("Control+K");
    const search = page.getByRole("dialog", { name: "세션 기록 검색" });
    await search.getByPlaceholder("검색어를 입력하세요...").fill("세션");
    await search.getByText(excerpt, { exact: true }).click();
    await expect(search).toHaveCount(0);
    await expect(root.getByText("232,000원/월", { exact: true })).toBeVisible();
  }
  expect(h.errors).toEqual([]);
});

test("PAS gallery choices, entity focus, sources, upload in progress, questions and approvals", async ({ page }) => {
  const h = await installChatUiRoutes(page, { example: "gallery", questions: true });
  const root = await openChatUi(page, true);
  await select(root, page);
  await root.getByRole("textbox", { name: "덧붙일 말" }).fill("입력 중");
  await root.getByRole("spinbutton", { name: "인원수 (명)" }).fill("12");
  await root.getByRole("checkbox", { name: "좁은 화면", exact: true }).check();
  await root.getByRole("button", { name: "자료 상세", exact: true }).click();
  await expect(root.getByText("OpenUI 원문에서 확인한 구성 요소야.", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "자료 상세", exact: true }).click();
  await root.getByRole("button", { name: "자료 상세", exact: true }).focus();
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  await expect(root.getByRole("button", { name: "자료 상세", exact: true })).toBeFocused();
  const focus = await root.getByRole("button", { name: "자료 상세", exact: true }).evaluate(el => {
    const r = el.getBoundingClientRect();
    return { element: { left: r.left, right: r.right }, focusVisible: el.matches(':focus-visible'), ring: getComputedStyle(el).boxShadow,
      ancestors: Array.from((function* () { let node = el.parentElement; while (node) { yield node; node = node.parentElement; } })()).map(node => ({ slot: node.getAttribute("data-slot"), className: node.className, overflow: getComputedStyle(node).overflowX, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })) };
  });
  expect(focus.focusVisible).toBe(true);
  writeFileSync(path.join(output, "pas-focus-owner.json"), JSON.stringify(focus, null, 2));
  await capture(page, "pas-gallery-entity-focus");
  expect(h.sourceRequests()).toBe(0);
  const source = root.getByRole("link", { name: "출처 열기", exact: true });
  await source.focus();
  const popup = page.context().waitForEvent("page"); await page.keyboard.press("Enter");
  const opened = await popup; await opened.waitForLoadState(); expect(opened.url()).toContain("www.openui.com"); await opened.close();
  expect(h.sourceRequests()).toBe(1);
  const draft = root.locator('textarea[data-slot="chat-input-body"]'); await draft.fill("업로드 중 초안");
  h.holdUpload(); await root.locator('input[type="file"]').setInputFiles({ name: "메모.pdf", mimeType: "application/pdf", buffer: Buffer.from("fixture") });
  await root.getByRole("button", { name: "이 값으로 요청", exact: true }).click();
  await expect(draft).toHaveValue(/업로드 중 초안\n\n인원수 \(명\): 12명/);
  await expect(root.getByTestId("send-button")).toBeDisabled();
  h.releaseUpload(); await expect(root.getByTestId("send-button")).toBeEnabled();
  await root.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(root.getByRole("spinbutton", { name: "인원수 (명)" })).toHaveValue("8");
  await expect(root.getByRole("textbox", { name: "덧붙일 말" })).toHaveValue("");
  await expect(root.getByRole("combobox", { name: "진행 순서" })).toContainText("앱 먼저");
  await expect(root.getByRole("checkbox", { name: "좁은 화면", exact: true })).not.toBeChecked();
  await root.getByRole("button", { name: "유지", exact: false }).click();
  await root.getByRole("button", { name: "승인", exact: true }).click();
  await expect.poll(() => h.responses.length).toBe(2);
  expect(h.responses[0].body.request_id).toBe("qa-question"); expect(h.responses[1].path).toContain("qa-approval/approve");
  expect(h.sends).toEqual([]); expect(h.errors).toEqual([]);
});

for (const fallback of ["unsupported", "invalid"] as const) {
  test(`actual history ${fallback} falls back to readable text`, async ({ page }) => {
    await page.setViewportSize({ width: fallback === "unsupported" ? 1440 : 360, height: 1000 });
    const h = await installChatUiRoutes(page, { fallback });
    const root = await openChatUi(page, fallback === "unsupported");
    await expect(root.locator(".chat-ui input")).toHaveCount(0);
    await expect(root.getByText("팀 요금", { exact: true })).toBeVisible();
    await expect(root.getByRole("link", { name: "OpenUI 원문", exact: true })).toBeVisible();
    await capture(page, `fallback-${fallback}`); expect(h.errors).toEqual([]);
  });
}

test("ordinary chat stays unchanged around editing and has no empty accessories", async ({ page }) => {
  const h = await installChatUiRoutes(page, { ui: false });
  await page.goto(`/?session=${chatUiSession}`);
  const root = page.locator('[data-slot="chat-root"]').filter({ visible: true }).first();
  await expect(root.getByText("기존 일반 답 8", { exact: false })).toBeVisible();
  await expect(root.locator('[data-slot="chat-input-accessories"]')).toHaveCount(0);
  await capture(page, "ordinary-before");
  const body = await root.locator('[data-slot="chat-body"]').allTextContents();
  const editor = root.locator('textarea'); await editor.fill("일반 초안"); await editor.fill("");
  expect(await root.locator('[data-slot="chat-body"]').allTextContents()).toEqual(body);
  await capture(page, "ordinary-after"); expect(h.errors).toEqual([]);
});

test("review sample uses the actual composer and isolates its render-error fallback", async ({ page }) => {
  const h = await installChatUiRoutes(page);
  await page.goto("/components");
  const sample = page.getByTestId("chat-ui-review-default");
  await sample.getByRole("button", { name: "요금", exact: true }).click();
  const editor = sample.locator('textarea[data-slot="chat-input-body"]');
  await editor.fill("검수 창 초안");
  await sample.getByRole("button", { name: "이 조건으로 질문", exact: true }).click();
  await expect(editor).toHaveValue("검수 창 초안\n\n8명, 연간 결제: 아니오, 월 232,000원 조건으로 비교해 줘.");
  await sample.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(editor).toHaveValue("검수 창 초안");
  await sample.getByRole("button", { name: "렌더 오류", exact: true }).click();
  await expect(sample.getByText("화면을 표시하지 못했어. 기본값 글로 보여줄게.", { exact: true })).toBeVisible();
  await editor.scrollIntoViewIfNeeded(); await capture(page, "fallback-render-error-review");
  expect(h.errors).toEqual([]); expect(h.sends).toEqual([]);
});
