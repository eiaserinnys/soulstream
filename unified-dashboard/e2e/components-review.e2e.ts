import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/20261001-components-full-page");
const phase = process.env.COMPONENTS_REVIEW_PHASE;
if (!phase) throw new Error("COMPONENTS_REVIEW_PHASE is required");

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
    await prepare(page, width);
    await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
    await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
    const errors: string[] = [], writes: string[] = [], fixtureRequests: string[] = [], dashboardReads: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())
        && !url.pathname.includes("ui-events")) writes.push(`${request.method()} ${url.pathname}`);
      if (url.pathname.startsWith("/api/") && url.pathname.includes("components-")) fixtureRequests.push(url.pathname);
      if (/^\/api\/(planner|sessions|folders|pages|cards|catalog)(\/|$)/.test(url.pathname)
        || /^\/api\/nodes(\/stream)?$/.test(url.pathname)) dashboardReads.push(url.pathname);
    });
    await page.goto("/components");
    const review = page.getByTestId("components-review");
    await expect(review).toBeVisible();
    await expect(review.locator(".v3-detail-section-head > h3")).toHaveText([
      "목록 행", "섹션 머리와 캡", "말풍선과 첨부", "입력창", "선택과 설정", "패널 표면",
    ]);
    await page.reload();
    await expect(review).toBeVisible();
    await expect(page.locator(".v3-navigation, .v3-session-panel, .v3-planner, .v3-global-toolbar")).toHaveCount(0);
    const viewport = await page.locator("main").evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        documentWidth: document.documentElement.scrollWidth };
    });
    expect(viewport.x).toBe(0); expect(viewport.y).toBe(0);
    expect(viewport.width).toBe(viewport.viewportWidth);
    expect(viewport.height).toBe(viewport.viewportHeight);
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
    expect(viewport.documentWidth).toBe(width);
    await capture(page, `components-${width}-rows`);
    await review.locator(".v3-run-open").first().focus();
    await page.keyboard.press("Enter");
    await expect(review.locator("p[role=status]")).toHaveText("세션 샘플을 열었습니다.");
    await capture(page, `components-${width}-focus`);
    await review.locator(".v3-card-row .v3-run-open").first().click();
    await expect(review.locator("p[role=status]")).toHaveText("카드 샘플을 열었습니다.");
    await review.locator("[data-testid=v3-task-components-parent]").click();
    await expect(review.locator("p[role=status]")).toHaveText("상위 폴더 샘플을 열었습니다.");
    await review.locator("[data-board-kind=markdown] .v3-inline-board-expand").click();
    await expect(review.getByRole("button", { name: "검수 문서 편집", exact: true }).first()).toBeVisible();
    await capture(page, `components-${width}-documents`);
    await review.getByRole("button", { name: "샘플 별표", exact: true }).click();
    await expect(review.getByRole("button", { name: "샘플 별표", exact: true })).toHaveAttribute("aria-pressed", "true");

    const geometry = async () => review.evaluate(el => {
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
        sections: [...el.querySelectorAll(".v3-detail-section")].map(section => ({ section: box(section), head: box(section.querySelector(".v3-detail-section-head")) })),
        rows: [...el.querySelectorAll(".v3-run-row")].map(row => ({ self: box(row), open: box(row.querySelector(".v3-run-open")),
          avatar: box(row.querySelector(".v3-run-avatar")), copy: box(row.querySelector(".v3-run-copy")), trailing: box(row.querySelector(".v3-run-trailing")) })),
        input: box(el.querySelector("[data-slot=chat-input-body]")), send: box(el.querySelector("[data-testid=send-button]")),
        chip: box(el.querySelector(".v3-card-handoff-chip")), composer: box(el.querySelector("[data-slot=chat-input-composer]")) };
    });
    const initial = await geometry();
    for (const row of initial.rows) {
      const sum = row.self!.bt + row.self!.bb + row.open!.pt + row.open!.pb
        + Math.max(row.avatar!.h, row.copy!.h, row.trailing!.h);
      expect(Math.abs(row.self!.h - sum)).toBeLessThanOrEqual(1);
    }
    for (const section of initial.sections) expect(section.head!.x).toBe(initial.sections[0].head!.x);

    await review.locator("#components-bubbles").scrollIntoViewIfNeeded();
    await capture(page, `components-${width}-bubbles`);
    await review.getByRole("button", { name: "검수 이미지", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "검수 이미지" })).toBeVisible();
    await capture(page, `components-${width}-image`);
    await page.keyboard.press("Escape");
    const attachment = review.getByRole("link", { name: "샘플 첨부 열기" });
    await expect(attachment).toHaveAttribute("href", "/icon-512.png");
    const popup = page.waitForEvent("popup");
    await attachment.click();
    const opened = await popup; await expect(opened).toHaveURL(/icon-512\.png$/); await opened.close();

    await review.getByRole("button", { name: "샘플 폴더 선택" }).click();
    await expect(page.getByRole("tabpanel", { name: "별표" })).toBeVisible();
    await capture(page, `components-${width}-picker`);
    await page.locator(".v3-folder-picker .v3-project-nav-link").last().click();
    const input = review.getByLabel("검수 메시지");
    await input.fill("한 줄\n두 줄\n세 줄\n네 줄");
    await capture(page, `components-${width}-input`);
    const multiline = await geometry();
    expect(multiline.input!.h).toBeGreaterThan(initial.input!.h);
    expect(multiline.send!.h).toBe(initial.send!.h);
    expect(multiline.send!.right).toBeLessThanOrEqual(multiline.sections[3].section!.right);
    expect(multiline.composer!.w).toBe(multiline.sections[3].section!.w);
    await review.locator("input[type=file]").setInputFiles({ name: "샘플.txt", mimeType: "text/plain", buffer: Buffer.from("샘플 첨부") });
    await expect(review.getByTitle("샘플.txt")).toBeVisible();
    await review.getByRole("button", { name: "샘플 전송", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(review.locator("p[role=status]")).toHaveText("샘플 메시지를 페이지의 말풍선에 추가했습니다.");
    await expect(review.locator('[data-card-entry="커멘트"]')).toHaveCount(1);
    await review.getByRole("button", { name: "샘플 패널 열기" }).click();
    await expect(page.getByRole("dialog", { name: "패널 표면 샘플" })).toBeVisible();
    await capture(page, `components-${width}-surface`);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]); expect(writes).toEqual([]); expect(fixtureRequests).toEqual([]);
    expect(dashboardReads).toEqual([]);
    writeFileSync(path.join(output, `${phase}-${width}-metrics.json`), JSON.stringify({ viewport, initial, multiline, writes, fixtureRequests, dashboardReads }, null, 2));
    await review.getByRole("button", { name: "대시보드로 돌아가기", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(review).toHaveCount(0);
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
  await expect(page.getByTestId("components-review")).toBeVisible();
});
