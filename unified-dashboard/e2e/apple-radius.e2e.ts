// 카드 #1735 항목 6: 애플식 곡률(뿌리 24 하나)이 화면에 실제로 적용됐는지 계산 곡률로 판정한다.
// 규칙: 틀 24, 알약(높이의 절반 이상), 동심 12(틀에서 12 이상 떨어진 안쪽), 고정 4(인라인 코드·kbd·체크박스).
// 실행: corepack pnpm --dir unified-dashboard exec playwright test --config e2e/radius-glass.config.ts apple-radius
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { prepare } from "./glass-review-helpers";
import {
  installReadmeDemoRoutes,
  readmeDemoIds,
  readmeDemoPreferences,
  type DemoFixtureDiagnostics,
} from "./readme-demo/demo-fixtures";
import { installDemoEventSource } from "./readme-demo/demo-event-source";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = path.join(REPO_ROOT, ".local/card1735/apple-radius");
mkdirSync(OUT, { recursive: true });

const TOLERANCE = 0.5;
const AT = "2026-11-20T09:00:00.000Z";
// 어시스턴트 말풍선에 인라인 코드를 넣어 고정 4를 재고, 사용자 말풍선과 함께 동심 12를 본다.
const CHAT = [
  { id: 1, type: "user_message", payload: { text: "위젯에 시간대별 강수 확률을 보여 주세요.", timestamp: 1 } },
  {
    id: 2,
    type: "assistant_message",
    payload: {
      content: "위젯 폭에 맞춰 두 시간대씩 묶어 표시했습니다. 묶는 개수는 `slots` 하나로 정합니다.",
      timestamp: 2,
      tool_use_id: "radius-2",
      _final_for_live_stream: true,
    },
  },
];

async function prepareFolder(page: Page, width: number, webgl = false) {
  const diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript((wallpaper) => {
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("soul-wallpaper", JSON.stringify(wallpaper));
  }, readmeDemoPreferences.wallpaper);
  await installDemoEventSource(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
        controller: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  });
  await installReadmeDemoRoutes(page, diagnostics);
  await page.route(new RegExp(`/api/sessions/${readmeDemoIds.sessionIds.running}/timeline(?:\\?|$)`), (route) =>
    route.fulfill({
      json: {
        messages: [...CHAT].reverse().map((entry) => ({
          id: entry.id,
          parent_event_id: null,
          event_type: entry.type,
          payload: entry.payload,
          created_at: AT,
        })),
        next_cursor: null,
      },
    }),
  );
  if (webgl) {
    await page.addInitScript(() => localStorage.setItem("ls.webglGlass", "1"));
  }
}

async function openFolder(page: Page, needCards = false) {
  await page.goto(`/?folder=${readmeDemoIds.folderId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(document.querySelector(".v3-shell")), null, { timeout: 120_000 });
  await expect(page.locator(".v3-planner").first()).toBeVisible({ timeout: 120_000 });
  if (needCards) {
    // 카드 칸은 기획 패널을 카드 구역까지 내려야 처음 그려진다(시안 스크립트와 같은 순서).
    await expect(page.getByTestId("v3-folder-cards-section")).toBeAttached({ timeout: 120_000 });
    await page.getByTestId("v3-planner-scroll").evaluate((scroller) => {
      const section = scroller.querySelector<HTMLElement>(".v3-run-row--small")?.parentElement?.closest("section")
        ?? scroller.querySelector<HTMLElement>('[data-testid="v3-folder-cards-section"]');
      if (section) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    });
    await expect(page.getByTestId("v3-folder-cards-section").locator(".v3-postit-card").first()).toBeVisible({ timeout: 120_000 });
  }
  await page.waitForTimeout(1200);
}

async function openChat(page: Page) {
  const row = page.locator('[data-session-id="session-widget-run"], [data-agent-session-id="session-widget-run"]').first();
  if (await row.count()) await row.click();
  else await page.getByText("위젯 강수 확률", { exact: false }).first().click();
  await expect(page.locator(".v3-chat-pane [data-slot=chat-input-body]")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".v3-chat-pane").getByText("묶는 개수는", { exact: false })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1200);
}

function corners(locator: Locator, pseudo?: string): Promise<number[]> {
  return locator.evaluate((element, selector) => {
    const style = getComputedStyle(element, selector ?? null);
    return [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].map((value) => Math.round(Number.parseFloat(value) * 100) / 100);
  }, pseudo);
}

async function expectCorners(locator: Locator, name: string, expected: number[]) {
  const actual = await corners(locator);
  const labels = ["TL", "TR", "BR", "BL"];
  for (const [index, value] of expected.entries()) {
    expect(
      Math.abs(actual[index]! - value),
      `${name}: ${labels[index]} 곡률 ${actual[index]} ≠ ${value}`,
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

function expectFrame(locator: Locator, name: string) {
  return expectCorners(locator, name, [24, 24, 24, 24]);
}

function expectFloor(locator: Locator, name: string) {
  return expectCorners(locator, name, [12, 12, 12, 12]);
}

async function expectPill(locator: Locator, name: string) {
  const actual = await corners(locator);
  const box = await locator.boundingBox();
  expect(box, `${name}: 크기를 재지 못했습니다`).not.toBeNull();
  for (const [index, value] of actual.entries()) {
    expect(value, `${name}: ${["TL", "TR", "BR", "BL"][index]} 곡률 ${value}이 높이 ${box!.height}의 절반보다 작습니다`).toBeGreaterThanOrEqual(box!.height / 2 - TOLERANCE);
  }
}

async function menuOnSessionRow(page: Page) {
  const row = page.locator(".v3-session-row").first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click({ button: "right" });
  const popup = page.locator("[data-slot=menu-popup]:visible").first();
  await expect(popup).toBeVisible({ timeout: 15_000 });
  return popup;
}

/** Select와 Popover는 폴더 화면 픽스처에 없으므로, 검수 창과 같은 방식으로 화면에 바로 띄운다. */
async function mountPopups(page: Page) {
  await page.evaluate(async (paths) => {
    const main = await (await fetch("/client/main.tsx")).text();
    const reactPath = main.match(/"(\/.vite-cache\/deps\/react\.js\?[^"]+)"/)?.[1];
    const domPath = main.match(/"(\/.vite-cache\/deps\/react-dom_client\.js\?[^"]+)"/)?.[1];
    if (!reactPath || !domPath) throw new Error("React 검수 모듈을 찾지 못했습니다.");
    const React = (await import(/* @vite-ignore */ reactPath)).default;
    const dom = await import(/* @vite-ignore */ domPath);
    const select = await import(/* @vite-ignore */ `/@fs${paths.select}`);
    const popover = await import(/* @vite-ignore */ `/@fs${paths.popover}`);
    const avatar = await import(/* @vite-ignore */ `/@fs${paths.avatar}`);
    const host = document.createElement("div");
    host.id = "radius-popup-probes";
    host.style.position = "fixed";
    host.style.left = "16px";
    host.style.top = "16px";
    host.style.zIndex = "9999";
    document.body.appendChild(host);
    dom.default.createRoot(host).render(
      React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        React.createElement(
          select.Select,
          null,
          React.createElement(
            select.SelectTrigger,
            { "aria-label": "곡률 시험 선택" },
            React.createElement(select.SelectValue, { placeholder: "선택" }),
          ),
          React.createElement(
            select.SelectContent,
            null,
            ["가", "나", "다"].map((label) =>
              React.createElement(select.SelectItem, { key: label, value: label }, label),
            ),
          ),
        ),
        React.createElement(
          popover.Popover,
          null,
          React.createElement(popover.PopoverTrigger, null, "곡률 시험 팝오버"),
          React.createElement(popover.PopoverPopup, null, "곡률 시험 내용"),
        ),
        React.createElement(
          "div",
          { id: "radius-avatar-probe" },
          React.createElement(avatar.ProfileAvatar, { role: "assistant", hasPortrait: false, fallbackEmoji: "🤖", shape: "circle" }),
        ),
      ),
    );
  }, {
    select: path.join(REPO_ROOT, "packages/soul-ui/src/components/ui/select.tsx"),
    popover: path.join(REPO_ROOT, "packages/soul-ui/src/components/ui/popover.tsx"),
    avatar: path.join(REPO_ROOT, "packages/soul-ui/src/components/ProfileAvatar.tsx"),
  });
  await expect(page.getByLabel("곡률 시험 선택")).toBeVisible({ timeout: 30_000 });
}

test("폴더 화면 1440: 틀 24·동심 12·고정 4·알약·메뉴·선택 팝업·팝오버", async ({ page }) => {
  test.setTimeout(300_000);
  await prepareFolder(page, 1440);
  await openFolder(page, true);

  await expectFrame(page.locator(".v3-navigation"), "내비");
  await expectFrame(page.locator(".v3-planner"), "기획 패널");
  await expectFrame(page.locator(".v3-session-panel"), "세션 패널");
  await expectFloor(page.locator(".v3-nav-list button").first(), "내비 항목");
  await expectFloor(page.locator(".v3-session-row").first(), "세션 행");
  await expectFloor(page.locator('[data-testid^="v3-child-folder-"] .v3-run-row').first(), "기획 패널 하위 폴더 행");
  await expectPill(page.locator(".v3-status-chip").first(), "상태 칩");
  await expectCorners(page.locator(".v3-nav-foot kbd").first(), "단축키 표시", [4, 4, 4, 4]);

  const postit = page.locator(".v3-postit-card").first();
  await postit.scrollIntoViewIfNeeded();
  const postitScale = await postit.evaluate((element) => {
    const value = getComputedStyle(element).getPropertyValue("--postit-scale").trim();
    return value === "" ? 1 : Number.parseFloat(value);
  });
  const postitRadius = 12 * postitScale;
  await expectCorners(postit, `포스트잇(scale ${postitScale})`, [postitRadius, postitRadius, postitRadius, postitRadius]);

  await page.screenshot({ path: path.join(OUT, "web-folder-1440.png"), animations: "disabled" });

  const menu = await menuOnSessionRow(page);
  await expectFrame(menu, "메뉴");
  await expectPill(page.locator("[data-slot=menu-item]:visible").first(), "메뉴 항목");
  await page.screenshot({ path: path.join(OUT, "web-menu-1440.png"), animations: "disabled" });
  await page.keyboard.press("Escape");

  // 토스트는 대시보드 화면에서 toastManager가 검수 스크립트 모듈과 갈라져 띄우지 못한다(PR 본문에 적음).

  await mountPopups(page);
  // 폼의 선택 트리거도 입력 칸과 같은 동심 12다(대화상자 입력 칸은 대화상자 시험에서 잰다).
  await expectFloor(page.getByLabel("곡률 시험 선택"), "폼 선택 트리거");
  await expectPill(page.locator("#radius-avatar-probe > span").first(), "아바타");
  await page.getByLabel("곡률 시험 선택").click();
  const selectPopup = page.locator("[data-slot=select-popup]:visible").first();
  await expect(selectPopup).toBeVisible({ timeout: 15_000 });
  await expectFrame(page.locator("[data-slot=select-popup] > div").first(), "선택 팝업");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "곡률 시험 팝오버" }).click();
  const popoverPopup = page.locator("[data-slot=popover-popup]:visible").first();
  await expect(popoverPopup).toBeVisible({ timeout: 15_000 });
  await expectFrame(popoverPopup, "팝오버");
});

test("채팅 1440: 말풍선 12·입력 24·인라인 코드 4", async ({ page }) => {
  test.setTimeout(300_000);
  await prepareFolder(page, 1440);
  await openFolder(page);
  await openChat(page);

  await expectFrame(page.locator(".v3-chat-pane"), "채팅 팬");
  const bubbles = page.locator('.v3-chat-pane [data-slot="chat-message-bubble"]');
  const bubbleCount = await bubbles.count();
  expect(bubbleCount, "말풍선을 찾지 못했습니다").toBeGreaterThanOrEqual(2);
  for (let index = 0; index < bubbleCount; index++) {
    await expectFloor(bubbles.nth(index), `말풍선 ${index + 1}`);
  }

  const inline = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll<HTMLElement>('.v3-chat-pane [data-slot="chat-body"] code')]
      .filter((element) => !element.closest("pre"));
    const target = candidates[0];
    if (!target) return null;
    const style = getComputedStyle(target);
    return [style.borderTopLeftRadius, style.borderBottomRightRadius].map((value) => Number.parseFloat(value));
  });
  expect(inline, "인라인 코드를 찾지 못했습니다").not.toBeNull();
  expect(inline![0]).toBeCloseTo(4, 1);

  await expectPill(page.locator(".v3-chat-pane [data-slot=dashboard-icon-cap]").first(), "아이콘 단추");

  const composer = page.locator('.v3-chat-pane [data-slot="chat-input-composer"]').first();
  await expectFrame(composer, "채팅 입력 상자");
  const oneLine = await composer.boundingBox();
  if (oneLine) {
    await page.screenshot({
      path: path.join(OUT, "zoom-chat-input-oneline.png"),
      clip: { x: Math.max(0, oneLine.x - 8), y: Math.max(0, oneLine.y - 8), width: Math.min(760, oneLine.width + 16), height: oneLine.height + 16 },
      animations: "disabled",
    });
  }
  const textarea = page.locator(".v3-chat-pane [data-slot=chat-input-body]").first();
  await textarea.fill("한 줄");
  await textarea.fill("첫 줄\n둘째 줄\n셋째 줄\n넷째 줄");
  await page.waitForTimeout(400);
  const manyLines = await composer.boundingBox();
  const growth = await textarea.evaluate((element) => {
    const el = element as HTMLTextAreaElement;
    return { value: el.value, height: el.style.height, scroll: el.scrollHeight, disabled: el.disabled };
  });
  expect(manyLines!.height, `여러 줄로 늘어난 뒤에도 입력 상자 높이가 그대로입니다 ${JSON.stringify(growth)}`).toBeGreaterThan(oneLine!.height + 8);
  await expectFrame(composer, "여러 줄 채팅 입력 상자");

  await page.screenshot({ path: path.join(OUT, "web-chat-1440.png"), animations: "disabled" });
  // 확대: 말풍선과 인라인 코드, 입력 상자.
  const box = await page.locator('.v3-chat-pane [data-slot="chat-message-row"]').last().boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "zoom-chat-bubble-inline-code.png"),
      clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(760, box.width + 16), height: box.height + 16 },
      animations: "disabled",
    });
  }
  const composerBox = await composer.boundingBox();
  if (composerBox) {
    await page.screenshot({
      path: path.join(OUT, "zoom-chat-input-multiline.png"),
      clip: { x: Math.max(0, composerBox.x - 8), y: Math.max(0, composerBox.y - 8), width: Math.min(760, composerBox.width + 16), height: composerBox.height + 16 },
      animations: "disabled",
    });
  }
});

test("대화상자 1440: 틀 24·입력 12·바닥 단추 알약 + 390 시트", async ({ page }) => {
  test.setTimeout(300_000);
  await prepare(page, 1440, false);
  await page.goto("/dialogues?sample=project-edit", { waitUntil: "domcontentloaded" });
  const popup = page.locator("[data-slot=dialog-popup]:visible").first();
  await expect(popup).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1200);

  await expectFrame(popup, "대화상자 팝업");
  await expectFloor(page.locator('[data-slot="dialog-popup"] input[aria-label="폴더 이름"]').first(), "대화상자 입력 칸");
  await expectPill(page.locator('[data-slot="dialog-footer"] button:visible').first(), "대화상자 바닥 단추");
  await page.screenshot({ path: path.join(OUT, "web-dialog-1440.png"), animations: "disabled" });

  // 390 하단 시트: 위는 24, 아래는 0.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/ui-events/config", (route) =>
    route.fulfill({ json: { enabled: false, flushIntervalMs: 1000, maxBatchSize: 1, maxQueueSize: 500, schemaVersion: "soulstream.ui_event.v1" } }),
  );
  await page.goto("/dialogues?sample=session-sheet");
  const sheet = page.locator("[data-slot=dialog-popup]:visible").first();
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await expectCorners(sheet, "하단 시트", [24, 24, 0, 0]);
  await page.screenshot({ path: path.join(OUT, "web-sheet-390.png"), animations: "disabled" });
});

test("구성 요소 1440: 상세 팬 24와 카드 체크박스 4", async ({ page }) => {
  test.setTimeout(300_000);
  await prepare(page, 1440, false);
  await page.goto("/components");
  await expect(page.getByTestId("components-review")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  // components-review 자체는 안쪽으로 흐르는 인라인 판이라 곡률이 0이다. 틀인 상세 팬은 머리 표본에서 잰다.
  const detailPane = page.locator('[data-testid="components-panel-headers"] .v3-detail-pane').first();
  await detailPane.scrollIntoViewIfNeeded();
  await expectFrame(detailPane, "상세 팬");

  const checkbox = page.locator('[data-testid="card-check-items"] [data-slot="checkbox"][data-variant="card-item"]').first();
  await checkbox.scrollIntoViewIfNeeded();
  await expect(checkbox, "카드 확인 항목 체크박스를 찾지 못했습니다").toBeVisible();
  const before = await corners(checkbox, "::before");
  expect(before[0], `카드 확인 항목 체크박스 ::before ${before[0]} ≠ 4`).toBeCloseTo(4, 1);

  await page.screenshot({ path: path.join(OUT, "web-components-1440.png"), animations: "disabled", fullPage: false });
  const box = await checkbox.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "zoom-card-checkbox.png"),
      clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: 320, height: 120 },
      animations: "disabled",
    });
  }
});
