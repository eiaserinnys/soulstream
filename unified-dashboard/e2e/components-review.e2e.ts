import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { waitForStableLayout } from "./layout-stability";

const output = path.resolve("../../../.local/artifacts/20261001-components-full-page");
const argonOutput = path.resolve("../../../.local/artifacts/20261015-argon385");
const withdrawalCaptureRoot = path.resolve("../../../.local/artifacts");
const withdrawalCaptureStamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const withdrawalCaptureStage = process.env.CARD_WITHDRAWAL_CAPTURE_STAGE ?? "capture";
const withdrawalReasonText = "커멘트에서 여러 의견을 비교한 결과 B안으로 정리됐고, 같은 내용을 다시 확인할 필요가 없어 이 질문은 철회합니다.";
const phase = process.env.COMPONENTS_REVIEW_PHASE ?? "after";

async function prepare(page: Page, width: number) {
  page.on("pageerror", error => console.error("pageerror", error.stack));
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-01T00:00:00Z") });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, {
    unifiedFolderView: true, timelineEventCount: 1, liveEventText: "채팅의 기존 본문과 입력창입니다.",
  });
  // The older visual fixture seeds a card without a matching detail response.
  // This comparison concerns the unchanged folder and chat surfaces.
  await page.route("**/api/cards?**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ cards: [] }),
  }));

}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `${phase}-${name}.png`), animations: "disabled" });
}

for (const width of [1440, 360]) {
  test(`monthly schedule review sample ${width}`, async ({ page }) => {
    await prepare(page, width);
    await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
    await page.goto("/components");
    const sample = page.getByTestId("recurring-schedule-review-sample");
    await sample.scrollIntoViewIfNeeded();
    const grid = sample.getByRole("group", { name: "매월 날짜" });
    const days = grid.getByRole("button");
    await expect(days).toHaveCount(31);
    for (const day of [1, 15, 28]) await expect(days.nth(day - 1)).toHaveAttribute("aria-pressed", "true");
    await capture(page, `monthly-schedule-${width}`);
    await days.nth(1).click();
    await expect(days.nth(1)).toHaveAttribute("aria-pressed", "true");
  });
}

for (const width of [1440, 390]) {
  test(`existing folder and chat ${width}`, async ({ page }) => {
    await prepare(page, width);
    await page.goto("/");
    if (width < 760) {
      await page.getByTestId("v3-mobile-tab-projects").click();
      await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click();
    } else {
      await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
    }
    await expect(page.locator("[data-task-section=sessions] .v3-run-row").first()).toBeVisible();
    await capture(page, `folder-${width}`);
    await page.locator("[data-task-section=sessions] .v3-run-open").first().click();
    await expect(page.locator(".v3-chat-pane [data-slot=chat-input-body]")).toBeVisible();
    await capture(page, `chat-${width}`);
  });

  test(`components direct entry and local interactions ${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    await prepare(page, width);
    await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
    await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
    const errors: string[] = [], writes: string[] = [], fixtureRequests: string[] = [], dashboardReads: string[] = [];
    // 검수 레이아웃과 표본이 마운트 때 여는 대시보드 골격 읽기. 이 밖의 운영 읽기는
    // 여전히 없어야 한다(카드 #1460).
    const bootReads = new Set(["/api/folders", "/api/sessions", "/api/sessions/stream", "/api/nodes/stream"]);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      if (!["GET", "HEAD"].includes(request.method()) && !url.pathname.includes("ui-events")) {
        writes.push(`${request.method()} ${url.pathname}`);
      }
      // 검수 페이지에 박힌 표본 채팅은 자기 표본 세션(components-review-*)만 읽는다.
      // 그 밖의 components- 경로와 대시보드 운영 경로는 읽지 않아야 한다(카드 #1460).
      const sampleSessionRead = /^\/api\/sessions\/components-review-[^/]+(\/|$)/.test(url.pathname);
      if (url.pathname.includes("components-") && !sampleSessionRead) fixtureRequests.push(url.pathname);
      if (!sampleSessionRead && (/^\/api\/(planner|sessions|folders|pages|cards|catalog)(\/|$)/.test(url.pathname)
        || /^\/api\/nodes(\/stream)?$/.test(url.pathname))) dashboardReads.push(url.pathname);
    });
    await page.goto("/components");
    const review = page.getByTestId("components-review");
    // Page-level actions update this notice; chat samples own separate statuses.
    const notice = review.locator(":scope > .v3-detail-scroll > .v3-task-detail-layout > .v3-task-detail-content > p[role=status]");
    const rows = review.locator("#components-rows");
    const sessionSample = rows.locator('[data-component="RichSessionRow / RunRowFrame"]').filter({
      has: page.getByText("RichSessionRow / RunRowFrame · 기본 · 행 클릭 · 포커스", { exact: true }),
    });
    const cardSample = rows.locator('[data-component="CardRowView / RunRowFrame"]');
    const documentSample = rows.locator('[data-component="InlineMarkdownCard"]');
    const timelineSample = review.locator('#components-bubbles [data-component="CardTimeline / UserMessage / AssistantMessage"]');
    const handoffSample = review.locator("#components-input").getByTestId("card-handoff-review-sample");
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(review.locator('section[id^="components-"] > .v3-detail-section-head > h3')).toHaveText([
      "목록 행", "말풍선과 첨부", "카드 질문 장", "입력창", "선택과 설정", "패널 표면",
    ]);
    await expect(review.locator('#components-heads .v3-detail-section-head > h3').filter({ hasText: "섹션 머리와 캡" })).toHaveText("섹션 머리와 캡");
    await page.reload();
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(':is(.v3-navigation, .v3-session-panel, .v3-planner, .v3-global-toolbar):not([data-testid="settings-toolbar-review"] *)')).toHaveCount(0);
    // 카드 질문 장 표본의 PAS 판(main.persistent-session-main)과 구분한다.
    const viewport = await page.locator("main.v3-components-main").evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        documentWidth: document.documentElement.scrollWidth };
    });
    expect(viewport.x).toBe(0); expect(viewport.y).toBe(0);
    expect(viewport.width).toBe(viewport.viewportWidth);
    expect(viewport.height).toBe(viewport.viewportHeight);
    expect(viewport.documentWidth).toBe(width);
    // 카드 질문 장 표본 하나는 스스로 520px 고정 폭을 선언한 검수 캔버스라 390 화면에서는
    // 주 영역보다 넓다(카드 #1197 표본). 페이지 껍데기와 그 밖의 표본이 넘치지 않는지는
    // 그대로 보고, 고정 폭 캔버스 안에서만 넘치는 것을 허용한다.
    const overflowOutsideFixedCanvas = await page.locator("main.v3-components-main").evaluate(el => {
      const right = el.getBoundingClientRect().right;
      const insideFixedCanvas = (node: Element) => {
        for (let parent: Element | null = node; parent && parent !== el; parent = parent.parentElement) {
          if (parent instanceof HTMLElement && parent.style.width === "520px") return true;
        }
        return false;
      };
      // 중간 스크롤 상자에 잘린 내용은 주 영역의 scrollWidth를 늘리지 않는다.
      const clippedBeforeMain = (node: Element) => {
        for (let parent = node.parentElement; parent && parent !== el; parent = parent.parentElement) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
        }
        return false;
      };
      return [...el.querySelectorAll<HTMLElement>("*")]
        .filter(node => !clippedBeforeMain(node))
        .filter(node => node.getBoundingClientRect().right > right + 1 && !insideFixedCanvas(node))
        .map(node => `${node.tagName}.${node.className}`);
    });
    expect(overflowOutsideFixedCanvas).toEqual([]);
    if (width >= 760) expect(viewport.scrollWidth).toBe(viewport.clientWidth);
    await capture(page, `components-${width}-rows`);
    await sessionSample.locator(".v3-run-open").focus();
    await page.keyboard.press("Enter");
    await expect(notice).toHaveText("세션 샘플을 열었습니다.");
    await capture(page, `components-${width}-focus`);
    await cardSample.getByRole("button", { name: "카드 카드 행 기본 열기", exact: true }).click();
    await expect(notice).toHaveText("카드 샘플을 열었습니다.");
    await rows.getByTestId("v3-task-components-parent").click();
    await expect(notice).toHaveText("상위 폴더 샘플을 열었습니다.");
    await documentSample.locator(".v3-inline-board-expand").click();
    // 펼친 문서 본문의 편집 단추는 FolderDescriptionPanel의 아이콘 캡이 그린다. 본문 자체는
    // v3-description-content인 div라 단추가 아니다.
    await expect(documentSample.getByRole("button", { name: "검수 문서 편집", exact: true })).toBeVisible();
    await capture(page, `components-${width}-documents`);
    const star = review.locator("#components-heads").getByRole("button", { name: "샘플 별표", exact: true });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");

    const geometry = async () => {
      await waitForStableLayout(handoffSample, ["[data-slot=chat-input-body]", "[data-testid=send-button]"]);
      return review.evaluate(el => {
      const box = (node: Element | null) => {
        if (!node) return null;
        const r = node.getBoundingClientRect(), s = getComputedStyle(node);
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
          padding: s.padding, gap: s.gap, font: s.fontSize, outline: s.outlineStyle,
          pt: parseFloat(s.paddingTop), pb: parseFloat(s.paddingBottom),
          bt: parseFloat(s.borderTopWidth), bb: parseFloat(s.borderBottomWidth) };
      };
      return { page: box(el), header: box(el.querySelector("header")),
        firstCap: box(el.querySelector("header .dashboard-icon-cap")), lastCap: box(el.querySelector("header .v3-folder-header-actions")),
        sections: [...el.querySelectorAll('section[id^="components-"] > .v3-detail-section-head')].map(head => ({ section: box(head.parentElement), head: box(head) })),
        rows: [...el.querySelectorAll('#components-rows [data-component^="RichSessionRow"] .v3-run-row, #components-rows [data-component="CardRowView / RunRowFrame"] .v3-run-row')].map(row => ({ self: box(row), open: box(row.querySelector(".v3-run-open")),
          avatar: box(row.querySelector(".v3-run-avatar")), copy: box(row.querySelector(".v3-run-copy")), trailing: box(row.querySelector(".v3-run-trailing")) })),
        inputSection: box(el.querySelector("#components-input")),
        input: box(el.querySelector('[data-testid="card-handoff-review-sample"] [data-slot=chat-input-body]')),
        send: box(el.querySelector('[data-testid="card-handoff-review-sample"] [data-testid=send-button]')),
        chip: box(el.querySelector('[data-testid="card-handoff-review-sample"] .v3-card-handoff-chip')),
        composer: box(el.querySelector('[data-testid="card-handoff-review-sample"] [data-slot=chat-input-composer]')) };
      });
    };
    const initial = await geometry();
    for (const row of initial.rows) {
      const sum = row.self!.bt + row.self!.bb + row.open!.pt + row.open!.pb
        + Math.max(row.avatar!.h, row.copy!.h, row.trailing!.h);
      expect(Math.abs(row.self!.h - sum)).toBeLessThanOrEqual(1);
    }
    for (const section of initial.sections) expect(section.head!.x).toBe(initial.sections[0].head!.x);

    await review.locator("#components-bubbles").scrollIntoViewIfNeeded();
    await capture(page, `components-${width}-bubbles`);
    await timelineSample.getByRole("button", { name: "검수 이미지", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "검수 이미지" })).toBeVisible();
    await capture(page, `components-${width}-image`);
    await page.keyboard.press("Escape");
    const attachment = timelineSample.getByRole("link", { name: "샘플 첨부 열기" });
    await expect(attachment).toHaveAttribute("href", "/icon-512.png");
    const popup = page.waitForEvent("popup");
    await attachment.click();
    const opened = await popup; await expect(opened).toHaveURL(/icon-512\.png$/); await opened.close();

    await handoffSample.getByRole("button", { name: "샘플 폴더 선택", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "별표" })).toBeVisible();
    await capture(page, `components-${width}-picker`);
    await page.locator(".v3-folder-picker").getByRole("button", { name: "👩‍💻 검수 폴더", exact: true }).click();
    const input = handoffSample.getByLabel("검수 메시지", { exact: true });
    await input.fill("한 줄\n두 줄\n세 줄\n네 줄");
    await capture(page, `components-${width}-input`);
    const multiline = await geometry();
    expect(multiline.input!.h).toBeGreaterThan(initial.input!.h);
    expect(multiline.send!.h).toBe(initial.send!.h);
    expect(multiline.send!.right).toBeLessThanOrEqual(multiline.inputSection!.right);
    expect(multiline.composer!.w).toBe(multiline.inputSection!.w);
    await handoffSample.locator("input[type=file]").setInputFiles({ name: "샘플.txt", mimeType: "text/plain", buffer: Buffer.from("샘플 첨부") });
    await expect(handoffSample.getByTitle("샘플.txt")).toBeVisible();
    await handoffSample.getByRole("button", { name: "샘플 전송", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(notice).toHaveText("샘플 메시지를 페이지의 말풍선에 추가했습니다.");
    await expect(timelineSample.locator('[data-card-entry="커멘트"]')).toHaveCount(1);
    await review.locator("#components-surfaces").getByRole("button", { name: "샘플 패널 열기", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "패널 표면 샘플" })).toBeVisible();
    await capture(page, `components-${width}-surface`);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]); expect(writes).toEqual([]); expect(fixtureRequests).toEqual([]);
    expect(dashboardReads.filter(path => !bootReads.has(path))).toEqual([]);
    writeFileSync(path.join(output, `${phase}-${width}-metrics.json`), JSON.stringify({ viewport, initial, multiline, writes, fixtureRequests, dashboardReads }, null, 2));
    await review.getByRole("button", { name: "대시보드로 돌아가기", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(review).toHaveCount(0);
  });
}

for (const width of [1440, 390]) {
  test(`card question withdrawal review sample ${width}`, async ({ page }) => {
    await prepare(page, width);
    await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
    await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
    await page.goto("/components");

    const sample = page.getByTestId("card-board-sample");
    await sample.locator('[data-card-id="board-size-comparison"] .v3-postit-open').first().click();
    // CardWorkspace는 카드 질문 장 표본의 카드 상세 다섯과 섞이지 않도록
    // 자기 작업대(v3-card-workspace) 안에서 찾는다.
    const detail = page.getByTestId("v3-card-workspace").getByTestId("card-detail");
    await expect(detail).toBeVisible();
    await detail.getByRole("tab", { name: "커멘트" }).click();
    const timeline = detail.locator(".v3-card-timeline");
    const openQuestion = timeline.locator('[data-card-entry="질문"]').filter({ hasText: "내용을 확인했나요?" });
    const withdrawnQuestion = timeline.locator('[data-card-entry="질문"]').filter({ hasText: "어느 안으로 할까요?" });
    const withdrawalReason = withdrawnQuestion.locator(".v3-card-question-withdrawal");
    const commentTarget = timeline.locator(".v3-card-comment-target");
    await expect(openQuestion).toBeVisible();
    await expect(withdrawnQuestion).toBeVisible();
    // 카드 상세의 질문 장은 새 질문 부품으로 그린다. 철회된 질문도 선택지를 보여 주되
    // 잠그므로, 열린 질문에만 고를 수 있는 단추가 있어야 한다(카드 #1197).
    await expect(openQuestion.locator(".v3-card-question-choices button")).toHaveCount(1);
    await expect(withdrawnQuestion.locator(".v3-card-bubble-kind")).toContainText("철회됨");
    await expect(withdrawalReason).toHaveText(withdrawalReasonText);
    await expect(withdrawnQuestion.locator(".v3-card-question-choices button:not([disabled])")).toHaveCount(0);
    await expect(commentTarget).toHaveCount(1);
    await openQuestion.scrollIntoViewIfNeeded();
    await withdrawnQuestion.scrollIntoViewIfNeeded();

    const questionMetrics = await withdrawnQuestion.evaluate(question => {
      const reason = question.querySelector<HTMLElement>(".v3-card-question-withdrawal")!;
      const questionParagraph = Array.from(reason.parentElement!.querySelectorAll<HTMLElement>("p")).find(node => node !== reason)!;
      const reasonStyle = getComputedStyle(reason);
      return {
        fontSize: reasonStyle.fontSize,
        lineHeight: reasonStyle.lineHeight,
        questionReasonGap: reason.getBoundingClientRect().top - questionParagraph.getBoundingClientRect().bottom,
      };
    });
    const targetMetrics = await commentTarget.evaluate(target => {
      const style = getComputedStyle(target);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    console.info("card question withdrawal computed metrics", { width, questionMetrics, targetMetrics });
    mkdirSync(withdrawalCaptureRoot, { recursive: true });
    writeFileSync(path.join(withdrawalCaptureRoot, `${withdrawalCaptureStamp}-card-question-withdrawal-${withdrawalCaptureStage}-${width}-metrics.json`), JSON.stringify({ width, questionMetrics, targetMetrics }, null, 2));

    await page.screenshot({
      path: path.join(withdrawalCaptureRoot, `${withdrawalCaptureStamp}-card-question-withdrawal-${withdrawalCaptureStage}-${width}.png`),
      animations: "disabled",
    });
    if (width === 1440) {
      await commentTarget.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(withdrawalCaptureRoot, `${withdrawalCaptureStamp}-card-question-comment-target-${withdrawalCaptureStage}.png`),
        animations: "disabled",
      });
    }

    await expect(withdrawalReason).toHaveCSS("font-size", "12px");
    await expect(withdrawalReason).toHaveCSS("line-height", "18px");
    await expect(commentTarget).toHaveCSS("font-size", "12px");
    await expect(commentTarget).toHaveCSS("line-height", "18px");
  });
}

const w13CaptureRoot = path.resolve("../../../.local/artifacts");
const w13Now = new Date().toISOString();
const w13Stamp = `${w13Now.slice(0, 10).replaceAll("-", "")}-${w13Now.slice(11, 16).replace(":", "")}`;

for (const width of [1440, 390]) {
  test(`W13 manuscript activity sample ${width}`, async ({ page }, testInfo) => {
    // 두 폭 모두 표본 그림이 붙는 만큼 기본 60초로는 모자란다(카드 #1714).
    testInfo.setTimeout(120_000);
    // 카드 #1714: 표본 첨부는 번들 그림으로 뜨고 첨부 API와 다른 출처를 부르지 않는다.
    const attachmentRequests: string[] = [];
    const allRequests: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      allRequests.push(request.url());
      if (/^\/api\/sessions\/[^/]+\/events\/\d+\/attachments$/.test(url.pathname)
        || url.pathname.startsWith("/api/attachments")) {
        attachmentRequests.push(url.pathname);
      }
    });
    await prepare(page, width);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: width === 390 ? "reduce" : "no-preference" });
    await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
    await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
    await page.goto("/components");

    const activity = page.getByTestId("manuscript-activity-review-sample");
    const defaultChat = page.getByTestId("persistent-manuscript-chat-review").getByTestId("default-review-column");
    await activity.scrollIntoViewIfNeeded();
    await expect(activity).toBeVisible();
    await expect(activity.locator("[data-slot=manuscript-activity-toggle]")).toHaveCount(3);
    await expect(activity.locator("[data-slot=manuscript-activity-toggle]").nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(activity.locator("[data-slot=manuscript-activity-toggle]").nth(1)).toHaveAttribute("aria-expanded", "false");
    await expect(activity).toContainText("도구 2회");
    await expect(activity).toContainText("도구 1회");
    await expect(activity).toContainText("실행 중");
    await expect(activity).toContainText("실패 1");
    await expect(activity).toContainText("생각 중입니다…");

    const indicator = activity.locator("[data-slot=chat-thinking-indicator]");
    const orb = indicator.locator('canvas[data-thinking-orb-state="working"]');
    await expect(orb).toHaveCount(1);
    await expect(orb).toHaveAttribute("aria-label", "생각 중입니다");
    const readOrbFrame = () => orb.evaluate(canvas => {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("working orb canvas has no 2D context");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let paintedPixels = 0;
      let signature = 2166136261;
      for (let index = 0; index < pixels.length; index += 1) {
        if (index % 4 === 3 && pixels[index] > 0) paintedPixels += 1;
        signature = Math.imul(signature ^ pixels[index], 16777619) >>> 0;
      }
      return { width: canvas.width, height: canvas.height, paintedPixels, signature };
    });
    await expect.poll(async () => (await readOrbFrame()).paintedPixels).toBeGreaterThan(0);
    const frameBefore = await readOrbFrame();
    await page.clock.runFor(200);
    const frameAfter = await readOrbFrame();
    expect(frameBefore.width).toBeGreaterThan(0);
    expect(frameBefore.height).toBeGreaterThan(0);
    if (width === 390) expect(frameAfter.signature).toBe(frameBefore.signature);
    else expect(frameAfter.signature).not.toBe(frameBefore.signature);

    await waitForStableLayout(activity, ["[data-slot=chat-activity-row]", "[data-slot=chat-thinking-indicator]"]);
    const geometry = await activity.evaluate(element => {
      const box = (selector: string) => {
        const rect = element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { x: rect.x, right: rect.right, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        viewportWidth: innerWidth,
        activity: box("[data-slot=chat-activity-row]"),
        activityToggle: box("[data-slot=manuscript-activity-toggle]"),
        thinking: box('[data-tree-node-id="review-thought-alone"]'),
        indicator: box("[data-slot=chat-thinking-indicator]"),
        orb: box('canvas[data-thinking-orb-state="working"]'),
      };
    });
    expect(Math.abs(geometry.activity.x - geometry.thinking.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.activity.x - geometry.indicator.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.activityToggle.right - geometry.activity.right)).toBeLessThanOrEqual(1);
    expect(geometry.orb.width).toBe(20);
    expect(geometry.orb.height).toBe(20);

    await page.evaluate(() => document.fonts.ready);
    await activity.screenshot({ path: path.join(w13CaptureRoot, `${w13Stamp}-w13-activity-${width}.png`), animations: "disabled" });
    const defaultToolRow = defaultChat.locator('[data-tree-node-id="review-tool"]');
    await expect(defaultToolRow).toBeVisible();
    await defaultToolRow.screenshot({ path: path.join(w13CaptureRoot, `${w13Stamp}-w13-default-after-${width}.png`), animations: "disabled" });
    writeFileSync(path.join(w13CaptureRoot, `${w13Stamp}-w13-geometry-${width}.json`), JSON.stringify(geometry, null, 2));

    const argonReview = page.getByTestId("persistent-manuscript-chat-review");
    const argonManuscript = argonReview.getByTestId("manuscript-review-column");
    const emptyRows = defaultChat.locator('[data-tree-node-id^="text-argon-empty-"]');
    const manuscriptEmptyRows = argonManuscript.locator('[data-tree-node-id^="text-argon-empty-"]');
    const expectedEmptyRows = phase === "before" ? 5 : 0;
    await expect(emptyRows).toHaveCount(expectedEmptyRows);
    await expect(manuscriptEmptyRows).toHaveCount(expectedEmptyRows);

    const responseRow = defaultChat.locator('[data-tree-node-id="text-argon-review-response"]');
    const manuscriptChat = argonManuscript.locator('[data-slot="chat-root"]');
    const manuscriptResponseRow = manuscriptChat.locator('[data-tree-node-id="text-argon-review-response"]');
    await expect(responseRow).toContainText("Argon의 정상 응답입니다.");
    await expect(manuscriptResponseRow).toContainText("Argon의 정상 응답입니다.");
    await expect(manuscriptChat.locator('[data-slot="chat-thinking-indicator"]')).toHaveCount(0);
    mkdirSync(argonOutput, { recursive: true });
    if (expectedEmptyRows > 0) {
      const firstEmptyRow = emptyRows.first();
      await firstEmptyRow.scrollIntoViewIfNeeded();
      await firstEmptyRow.screenshot({
        path: path.join(argonOutput, phase + "-default-empty-row-" + width + ".png"),
        animations: "disabled",
      });
    }
    await responseRow.scrollIntoViewIfNeeded();
    await responseRow.screenshot({
      path: path.join(argonOutput, phase + "-default-response-" + width + ".png"),
      animations: "disabled",
    });
    await manuscriptResponseRow.scrollIntoViewIfNeeded();
    await defaultChat.screenshot({
      path: path.join(argonOutput, phase + "-default-" + width + ".png"),
      animations: "disabled",
    });
    await manuscriptChat.screenshot({
      path: path.join(argonOutput, phase + "-manuscript-" + width + ".png"),
      animations: "disabled",
    });

    const closedGroup = activity.locator("[data-slot=manuscript-activity-toggle]").nth(1);
    await closedGroup.click();
    await expect(closedGroup).toHaveAttribute("aria-expanded", "true");
    const singleToolRow = closedGroup.locator("xpath=ancestor::*[@data-slot='chat-activity-row'][1]");
    await expect(singleToolRow.locator("[data-slot=manuscript-tool-call-item]")).toHaveCount(1);
    await singleToolRow.locator("[data-slot=tool-call-item-toggle]").click();
    await expect(singleToolRow.locator("[data-slot=chat-tool-body]")).toContainText("읽기 완료");
    await expect(activity).not.toContainText("mcp__soulstream__");

    const agentReview = page.getByTestId("persistent-agent-message-group-review");
    await agentReview.scrollIntoViewIfNeeded();
    const collapsedAgent = page.getByTestId("agent-message-group-collapsed");
    const agentHeader = collapsedAgent.locator("button");
    await expect(agentHeader).toHaveText("다른 세션 메시지 1건");
    const agentGeometry = await collapsedAgent.evaluate(element => {
      const row = element.querySelector<HTMLElement>('[data-slot="manuscript-agent-message-group"]')!;
      const button = row.querySelector<HTMLButtonElement>("button")!;
      return { rowRight: row.getBoundingClientRect().right, buttonRight: button.getBoundingClientRect().right };
    });
    expect(Math.abs(agentGeometry.rowRight - agentGeometry.buttonRight)).toBeLessThanOrEqual(1);
    await collapsedAgent.screenshot({ path: path.join(w13CaptureRoot, `${w13Stamp}-w13-agent-collapsed-${width}.png`), animations: "disabled" });
    const agentHeaderBox = await agentHeader.boundingBox();
    if (!agentHeaderBox) throw new Error("collapsed agent header has no layout box");
    await agentHeader.click({ position: { x: 4, y: agentHeaderBox.height / 2 } });
    await expect(agentHeader).toHaveAttribute("aria-expanded", "true");
    await expect(collapsedAgent.locator('[data-slot="chat-body"]')).toHaveCount(1);
    await collapsedAgent.screenshot({ path: path.join(w13CaptureRoot, `${w13Stamp}-w13-agent-expanded-${width}.png`), animations: "disabled" });

    // 표본 첨부(사람 메시지)는 서버 없이 같은 출처의 번들 raster 그림으로 로드된다.
    await defaultChat.getByText("첨부 이미지를 확인해주세요.").scrollIntoViewIfNeeded();
    const reviewAttachmentImages = defaultChat.locator('img[src*="pas-settings-1"][src$=".png"]');
    await expect(reviewAttachmentImages.first()).toBeVisible();
    await expect.poll(async () => reviewAttachmentImages.first().evaluate(
      image => (image as HTMLImageElement).naturalWidth,
    )).toBeGreaterThan(0);
    await expect.poll(async () => reviewAttachmentImages.count()).toBeGreaterThan(0);
    for (const source of await reviewAttachmentImages.evaluateAll(images => images.map(image => (image as HTMLImageElement).getAttribute("src") ?? ""))) {
      const imageUrl = new URL(source, page.url());
      expect(imageUrl.origin).toBe(new URL(page.url()).origin);
      expect(imageUrl.pathname).toMatch(/^\/assets\/pas-settings-1-[\w-]+\.png$/);
      expect(source).not.toContain("/api/attachments");
    }
    await expect(defaultChat).not.toContainText("첨부를 찾을 수 없거나");
    await expect(defaultChat).not.toContainText("첨부 정보를 불러오지 못했습니다");
    expect(attachmentRequests).toEqual([]);
    const reviewOrigin = new URL(page.url()).origin;
    expect(allRequests.filter(url => !["data:", "blob:"].includes(new URL(url).protocol)
      && new URL(url).origin !== reviewOrigin)).toEqual([]);
    const webCaptureDir = path.resolve("../.local/card1714/web");
    mkdirSync(webCaptureDir, { recursive: true });
    await defaultChat.screenshot({
      path: path.join(webCaptureDir, `web-chat-attachments-${width}.png`), animations: "disabled",
    });
  });
}

test("components inherits the login boundary before authenticated entry", async ({ page }) => {
  await prepare(page, 390);
  await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
  let authenticated = false;
  await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authenticated, user: authenticated ? { email: "qa@example.test", name: "QA" } : null }) }));
  await page.goto("/components");
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  await expect(page.getByTestId("components-review")).toHaveCount(0);
  await capture(page, "login-390");
  authenticated = true;
  await page.reload();
  await expect(page.getByTestId("components-review")).toBeVisible({ timeout: 30_000 });
});
