// 카드 #1735 항목 6: 애플식 곡률(뿌리 24 하나)이 화면에 실제로 적용됐는지 계산 곡률로 판정한다.
// 규칙: 틀 24, 알약(높이의 절반 이상), 동심 12(틀에서 12 이상 떨어진 안쪽), 고정 4(인라인 코드·kbd·체크박스).
// 실행: corepack pnpm --dir unified-dashboard exec playwright test --config e2e/radius-glass.config.ts apple-radius
import { expect, test, type Locator, type Page } from "./test";
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

/** 세라피엘 conflicts.js와 같은 셈: 변형 접두어 없는 rounded-* 클래스가 한 요소에 둘 이상이면 곡률이 뒤집힌 자리다. */
async function radiusClassConflicts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const classes = element.getAttribute("class");
      if (!classes) continue;
      const all: string[] = [];
      for (const name of classes.split(/\s+/)) {
        if (name.includes(":")) continue;
        const match = name.match(/^rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-.*)?$/);
        if (!match) continue;
        if ((match[2] ?? "all") === "all") all.push(name);
      }
      if (all.length > 1) found.push(`${element.tagName.toLowerCase()} ${all.join(" ")}`);
    }
    return found;
  });
}

/** /components 질문 장의 선택지 단추는 동심 12다. 한 줄·여러 줄 모두 같은 값이다. */
async function expectChoiceButtonsFloor(page: Page, label: string) {
  const buttons = page.locator("#components-question .v3-card-question-choices [data-slot=button]");
  const count = await buttons.count();
  expect(count, `${label}: 질문 선택지 단추를 찾지 못했습니다`).toBeGreaterThan(0);
  let checked = 0;
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    if (!(await button.isVisible())) continue;
    await expectFloor(button, `${label} 선택지 ${index + 1}`);
    checked++;
  }
  expect(checked, `${label}: 보이는 선택지 단추가 없습니다`).toBeGreaterThan(0);
}

/** 같은 질문 장 안에서 선택지 밖의 단추는 알약 그대로다. */
async function expectOtherButtonsPill(page: Page, label: string) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#components-question [data-slot='button']")]
      .filter((element) => !element.closest(".v3-card-question-choices"))
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: (element.textContent ?? element.getAttribute("aria-label") ?? "").trim().slice(0, 30),
          height: rect.height,
          radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
        };
      }),
  );
  expect(rows.length, `${label}: 질문 선택지 밖 단추를 찾지 못했습니다`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.radius, `${label}: "${row.name}" 단추 곡률 ${row.radius} < 높이의 절반 ${row.height / 2}`)
      .toBeGreaterThanOrEqual(row.height / 2 - TOLERANCE);
  }
}

/** soul-ui 체크박스 상자(카드 확인 항목은 누름 영역이 아니라 보이는 ::before)는 고정 4다. */
async function expectCheckboxBoxesMark(page: Page, label: string) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="checkbox"]')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const pseudo = element.getAttribute("data-variant") === "card-item" ? "::before" : null;
        return {
          variant: element.getAttribute("data-variant") ?? "default",
          radius: Number.parseFloat(getComputedStyle(element, pseudo).borderTopLeftRadius),
        };
      }),
  );
  expect(rows.length, `${label}: 체크박스를 찾지 못했습니다`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.radius, `${label}: ${row.variant} 체크박스 상자 ${row.radius} ≠ 4`).toBeCloseTo(4, 1);
  }
}

/** 포스트잇 턴 블록은 감싼 포스트잇과 같은 곡률이다(배율 반영). */
async function expectPostitTurnMatchesCard(page: Page, label: string) {
  const card = page.getByTestId("folder-card-section")
    .locator(".v3-postit-card[data-card-enhanced]")
    .filter({ has: page.locator(".v3-postit-turn") })
    .first();
  await expect(card, `${label}: 턴 블록이 있는 포스트잇을 찾지 못했습니다`).toBeVisible({ timeout: 60_000 });
  await card.scrollIntoViewIfNeeded();
  const turn = card.locator(".v3-postit-turn").first();
  await expect(turn).toBeVisible();
  const scale = await card.evaluate((element) => {
    const value = getComputedStyle(element).getPropertyValue("--postit-scale").trim();
    return value === "" ? 1 : Number.parseFloat(value);
  });
  await expectCorners(card, `${label} 포스트잇(scale ${scale})`, [12 * scale, 12 * scale, 12 * scale, 12 * scale]);
  await expectCorners(turn, `${label} 포스트잇 턴`, [12 * scale, 12 * scale, 12 * scale, 12 * scale]);
  return turn;
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

  const folderConflicts = await radiusClassConflicts(page);
  expect(folderConflicts, `폴더 1440: 변형 없는 rounded-* 클래스가 둘 이상인 요소 ${folderConflicts.join(", ")}`).toEqual([]);

  // 압축 보기(보드)와 일반 보기(격자) 각각에서 턴 블록이 포스트잇과 같은 곡률인지 본다.
  await expectPostitTurnMatchesCard(page, "압축 보기");
  await page.getByTestId("folder-card-section").getByLabel("일반 보기").first().click();
  await expect(page.getByTestId("folder-card-section").locator(".v3-postit-grid .v3-postit-card").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  const normalTurn = await expectPostitTurnMatchesCard(page, "일반 보기");
  const turnBox = await normalTurn.boundingBox();
  if (turnBox) {
    await page.screenshot({
      path: path.join(OUT, "zoom-postit-turn.png"),
      clip: {
        x: Math.max(0, turnBox.x - 12),
        y: Math.max(0, turnBox.y - 12),
        width: Math.min(760, turnBox.width + 24),
        height: turnBox.height + 24,
      },
      animations: "disabled",
    });
  }

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

  // atom-edit 표본: 처음부터 펼쳐진 atom 목록 판과 트리거가 같은 동심 12다(R2).
  await page.goto("/dialogues?sample=atom-edit", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dialogue-sample")).toBeVisible({ timeout: 120_000 });
  const atomPopup = page.locator("[data-slot=popover-popup]:visible").first();
  await expect(atomPopup).toBeVisible({ timeout: 60_000 });
  const atomTrigger = atomPopup.locator("[data-slot=atom-node-selector-trigger]").first();
  await expect(atomTrigger).toBeVisible({ timeout: 60_000 });
  const atomPanel = atomPopup.locator("[data-slot=atom-node-selector-panel]").first();
  await expect(atomPanel).toBeVisible({ timeout: 60_000 });
  const atomTriggerCorners = await corners(atomTrigger);
  const atomPanelCorners = await corners(atomPanel);
  expect(atomTriggerCorners[0], `atom 트리거 곡률 ${atomTriggerCorners[0]} ≠ 12`).toBeCloseTo(12, 1);
  expect(atomPanelCorners[0], `atom 목록 판 곡률 ${atomPanelCorners[0]} ≠ 트리거 ${atomTriggerCorners[0]}`).toBeCloseTo(atomTriggerCorners[0], 1);
  await atomPopup.screenshot({ path: path.join(OUT, "web-atom-edit-1440.png"), animations: "disabled" });

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

test("구성 요소: 상세 팬 24·체크박스 4·질문 선택지 12 (1440과 390)", async ({ page }) => {
  test.setTimeout(420_000);
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
  await expectCheckboxBoxesMark(page, "components 1440");

  await page.screenshot({ path: path.join(OUT, "web-components-1440.png"), animations: "disabled", fullPage: false });
  const box = await checkbox.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "zoom-card-checkbox.png"),
      clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: 320, height: 120 },
      animations: "disabled",
    });
  }

  // 질문 장 선택지는 알약이 아니라 동심 12다(곡률 클래스 합치기 R1).
  const questionSample = page.locator('#components-question [data-component^="CardQuestionBlock"]').first();
  await questionSample.scrollIntoViewIfNeeded();
  await questionSample.screenshot({ path: path.join(OUT, "components-question-1440.png"), animations: "disabled" });
  await expectChoiceButtonsFloor(page, "components 1440");
  await expectOtherButtonsPill(page, "components 1440");

  const componentsConflicts = await radiusClassConflicts(page);
  expect(componentsConflicts, `components 1440: 변형 없는 rounded-* 클래스가 둘 이상인 요소 ${componentsConflicts.join(", ")}`).toEqual([]);

  // 390에서도 같은 값이어야 한다(여러 줄로 접힌 선택지 포함).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const narrowChoices = page.locator("#components-question .v3-card-question-choices").first();
  await narrowChoices.scrollIntoViewIfNeeded();
  const narrowBox = await narrowChoices.boundingBox();
  if (narrowBox) {
    const x = Math.max(0, narrowBox.x - 8);
    await page.screenshot({
      path: path.join(OUT, "components-question-390.png"),
      clip: { x, y: Math.max(0, narrowBox.y - 8), width: Math.min(390 - x, narrowBox.width + 16), height: narrowBox.height + 16 },
      animations: "disabled",
    });
  }
  await expectChoiceButtonsFloor(page, "components 390");
  await expectOtherButtonsPill(page, "components 390");
  await expectCheckboxBoxesMark(page, "components 390");
  const componentsConflicts390 = await radiusClassConflicts(page);
  expect(componentsConflicts390, `components 390: 변형 없는 rounded-* 클래스가 둘 이상인 요소 ${componentsConflicts390.join(", ")}`).toEqual([]);
});
