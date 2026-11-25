// 지침과 스킬 보기(카드 #1854): 세 화면(구성, 스킬과 카탈로그, 한눈에)의 캡처와 조작 측정.
// 캡처는 워크트리 .local/shots/, 조작 결과(ui-design §0의 14~18번과 대화상자 표)는 .local/shots/operations.md로 쓴다.
import { expect, test, type Page } from "@playwright/test";
import { LONGEST_SKILL_NAME } from "../client/v3/guides-fixture";
import { NARROW, WIDE, openSettings, shot, writeOperations, type OperationResults, type Theme } from "./agent-profile-assembly-guides-helpers";

const SIZES = { wide: WIDE, narrow: NARROW } as const;
type Size = keyof typeof SIZES;

async function openProfile(page: Page, size: Size, theme: Theme, extra: { assemblyState?: string; guidesState?: string } = {}) {
  await openSettings(page, { ...SIZES[size], theme, category: "에이전트", ...extra });
  await expect(page.getByTestId("agent-profile-editor")).toBeVisible();
}
async function openSkills(page: Page, size: Size, theme: Theme, guidesState = "normal") {
  await openSettings(page, { ...SIZES[size], theme, category: "스킬과 카탈로그", guidesState });
  await expect(page.getByTestId("skill-catalog-settings")).toBeVisible();
}
async function openOverview(page: Page, size: Size, theme: Theme, guidesState = "normal") {
  await openProfile(page, size, theme, { guidesState });
  await page.getByRole("button", { name: "한눈에", exact: true }).click();
}
const assembly = (page: Page) => page.getByTestId("agent-context-assembly");
const listRows = (page: Page) => page.locator("button[data-settings-list-row]");

/** 구성 화면: 첫 소스 줄을 펴서 실린 문서 트리와 스킬 구역이 함께 보이게 한다. */
async function profileScene(page: Page) {
  await expect(assembly(page).getByTestId("agent-context-skills")).toBeVisible({ timeout: 15_000 });
  await assembly(page).locator("button[aria-expanded]").nth(0).click();
}
async function skillsLoaded(page: Page) {
  await expect(page.getByTestId("skill-catalog-skeleton")).toHaveCount(0, { timeout: 15_000 });
  await expect(listRows(page).first()).toBeVisible();
}
async function overviewLoaded(page: Page) {
  await expect(page.getByTestId("agent-context-overview").locator("table")).toBeVisible({ timeout: 15_000 });
}

/** 설정 창 안에서 다른 항목으로 옮긴다(좁은 폭에서는 먼저 「모든 설정」으로 돌아간다). 페이지를 다시 열지 않아 시험이 빠르다. */
async function switchCategory(page: Page, label: "에이전트" | "스킬과 카탈로그") {
  const back = page.getByRole("button", { name: "모든 설정" });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

for (const theme of ["light", "dark"] as const) {
  const dir = theme === "dark" ? "dark/" : "";
  for (const size of ["wide", "narrow"] as const) {
    test(`three screens ${theme} ${size}`, async ({ page }) => {
      test.setTimeout(150_000);
      // 구성
      await openProfile(page, size, theme);
      await profileScene(page);
      await shot(page, `${dir}profile-${size}.png`);
      if (theme === "light") {
        // 같은 화면의 아래쪽: 스킬 구역(설명, 진단 배지, 나가는 연결, 실린 방식은 머리에 한 번)
        await assembly(page).getByTestId("agent-context-skills").scrollIntoViewIfNeeded();
        await page.locator('[data-testid="agent-context-skills"] > button').last().scrollIntoViewIfNeeded();
        await shot(page, `states/profile-skills-${size}.png`);
      }
      // 한눈에
      await page.getByRole("button", { name: "한눈에", exact: true }).click();
      await overviewLoaded(page);
      await shot(page, `${dir}overview-${size}.png`);
      if (theme === "light" && size === "wide") await shot(page, "states/error-column.png");
      // 스킬과 카탈로그
      await switchCategory(page, "스킬과 카탈로그");
      await expect(page.getByTestId("skill-catalog-settings")).toBeVisible();
      await skillsLoaded(page);
      if (size === "wide") {
        // 본문 탭(기본)은 states에 남기고, 대표 장면은 쓰이는 곳 탭으로 찍는다.
        if (theme === "light") {
          await expect(page.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15_000 });
          await shot(page, "states/body-tab.png");
        }
        await page.getByRole("tab", { name: "쓰이는 곳" }).click();
        await expect(page.getByTestId("skill-guide-usage")).toBeVisible({ timeout: 15_000 });
      }
      await shot(page, `${dir}skills-${size}.png`);
      if (theme === "light" && size === "wide") {
        await page.getByRole("tab", { name: "카탈로그", exact: true }).click();
        await expect(page.getByRole("heading", { name: /catalog$/ })).toBeVisible();
        await shot(page, "states/catalog-detail.png");
      }
      if (theme === "light" && size === "narrow") {
        await listRows(page).nth(1).click();
        await expect(page.getByRole("button", { name: "목록으로" })).toBeFocused();
        await shot(page, "states/skills-narrow-detail.png");
      }
    });
  }
}

test("states: 스킬 탭 로딩, 오류, 빈 상태, 보고에 없음, 검증 중", async ({ page }) => {
  test.setTimeout(180_000);
  await openSkills(page, "wide", "light", "loading");
  await expect(page.getByTestId("skill-catalog-skeleton")).toBeVisible();
  await shot(page, "states/loading-skills.png");
  await openSkills(page, "wide", "light", "failure");
  await expect(page.getByTestId("skill-catalog-settings").getByRole("alert")).toContainText("불러오지 못했습니다");
  await shot(page, "states/error-skills.png");
  await openSkills(page, "wide", "light", "empty");
  await expect(page.getByText("항목이 없습니다.").first()).toBeVisible();
  await shot(page, "states/empty-skills.png");
  await openSkills(page, "wide", "light", "noreport");
  await expect(page.getByTestId("skill-catalog-report")).toHaveText("검증 보고 없음");
  await shot(page, "states/no-report.png");
  await openSkills(page, "wide", "light", "nolint");
  await skillsLoaded(page);
  await page.getByRole("tab", { name: "검증" }).click();
  await expect(page.getByText("보고에 없음").first()).toBeVisible();
  await shot(page, "states/no-lint.png");
  await openSkills(page, "wide", "light", "verifying");
  await skillsLoaded(page);
  await page.getByRole("button", { name: "다시 검증" }).click();
  await expect(page.getByRole("button", { name: "검증 중" })).toBeVisible();
  await shot(page, "states/verifying.png");
});

test("states: 한눈에와 구성 로딩, 오류, 빈 상태, 옛 응답", async ({ page }) => {
  test.setTimeout(180_000);
  await openOverview(page, "wide", "light", "overviewslow");
  await expect(page.getByTestId("agent-context-overview").locator(".v3-run-skeleton").first()).toBeVisible();
  await shot(page, "states/loading-overview.png");
  await openOverview(page, "wide", "light", "failure");
  await expect(page.getByRole("alert")).toContainText("프로필을 모으지 못했습니다");
  await shot(page, "states/error-overview.png");
  await openOverview(page, "wide", "light", "noprofiles");
  await expect(page.getByText("프로필이 없습니다")).toBeVisible();
  await shot(page, "states/empty-overview.png");
  await openProfile(page, "wide", "light", { assemblyState: "loading" });
  await expect(assembly(page).locator(".v3-run-skeleton").first()).toBeVisible();
  await shot(page, "states/loading-profile.png");
  await openProfile(page, "wide", "light", { assemblyState: "failure" });
  await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "states/error-profile.png");
  await openProfile(page, "wide", "light", { assemblyState: "legacy" });
  await expect(assembly(page).locator("button[data-status]").first()).toBeVisible({ timeout: 15_000 });
  expect(await assembly(page).locator("button[aria-expanded]").count()).toBe(0);
  await shot(page, "states/legacy-profile.png");
});

test("operations: ui-design §0 14번부터 18번을 재서 operations.md를 쓴다", async ({ page }) => {
  test.setTimeout(300_000);
  const out: OperationResults = { focus: [], tab: [], overflow: [], errors: [], resize: [], dialogs: [] };
  const active = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return "없음(body)";
    return `${element.tagName.toLowerCase()}${element.getAttribute("aria-label") ? `[${element.getAttribute("aria-label")}]` : ""} "${(element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24)}"`;
  });
  const narrowMeasure = async (label: string) => {
    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const detail = document.querySelector<HTMLElement>(".config-detail")!;
      const dialog = document.querySelector<HTMLElement>(".config-dialog")!;
      const frame = document.querySelector<HTMLElement>('[data-testid="agent-context-overview"]');
      const box = detail.getBoundingClientRect();
      const outside = Array.from(detail.querySelectorAll<HTMLElement>("h3, p, span, button, li")).filter(element => {
        if (frame?.contains(element)) return false;
        const r = element.getBoundingClientRect();
        return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
      }).map(element => (element.textContent ?? "").trim().slice(0, 20));
      const clipped = Array.from(detail.querySelectorAll<HTMLElement>(".truncate")).filter(element => element.scrollWidth > element.clientWidth + 1)
        .filter(element => getComputedStyle(element).textOverflow !== "ellipsis").map(element => (element.textContent ?? "").slice(0, 20));
      const split = Array.from(detail.querySelectorAll<HTMLElement>("strong, .tabular-nums")).filter(element => element.getClientRects().length > 1 && !getComputedStyle(element.closest(".truncate") ?? element).whiteSpace.startsWith("nowrap")).map(element => element.textContent);
      return { page: [doc.scrollWidth, doc.clientWidth], dialog: [dialog.scrollWidth, dialog.clientWidth], detail: [detail.scrollWidth, detail.clientWidth], outside, clipped, split };
    });
    expect(m.page[0]).toBeLessThanOrEqual(m.page[1]!);
    expect(m.dialog[0]).toBeLessThanOrEqual(m.dialog[1]!);
    expect(m.detail[0]).toBeLessThanOrEqual(m.detail[1]!);
    expect(m.outside).toEqual([]);
    expect(m.clipped).toEqual([]);
    expect(m.split).toEqual([]);
    out.overflow.push(`${label}: 페이지 ${m.page.join("/")}, 설정 창 ${m.dialog.join("/")}, 상세 ${m.detail.join("/")}(scrollWidth/clientWidth). 틀 밖 요소 0, 말줄임 없이 잘린 글 0, 줄 중간에서 끊긴 수치 0`);
  };

  // ---- 14번 누른 뒤 초점, 16번 최소 폭: 스킬 탭 360
  await openSkills(page, "narrow", "light");
  await skillsLoaded(page);
  await listRows(page).nth(2).click();
  const afterOpen = await active();
  expect(afterOpen).toContain("목록으로");
  await page.getByRole("button", { name: "목록으로" }).click();
  await expect(page.locator('button[data-settings-list-row][class*="bg-accent-blue/15"]')).toBeFocused();
  out.focus.push(["스킬 목록 줄(360)", "줄을 누름: 목록 대신 상세가 서고", `초점 ${afterOpen}. 「목록으로」 뒤 초점 ${await active()}`]);

  const longRow = listRows(page).filter({ hasText: LONGEST_SKILL_NAME });
  await longRow.scrollIntoViewIfNeeded();
  await longRow.click();
  await expect(page.getByRole("heading", { name: LONGEST_SKILL_NAME })).toBeVisible();
  await narrowMeasure("스킬 탭 360, 가장 긴 이름과 설명을 고른 상세(본문 탭)");
  for (const tabName of ["연결", "쓰이는 곳", "검증"]) {
    await page.getByRole("tab", { name: tabName }).click();
    await narrowMeasure(`스킬 탭 360, ${tabName} 탭`);
  }
  await page.getByRole("button", { name: "목록으로" }).click();
  await narrowMeasure("스킬 탭 360, 목록(가장 긴 이름 줄 포함)");

  // ---- 15번 Tab 순서와 Esc
  await openSkills(page, "wide", "light");
  await skillsLoaded(page);
  await page.getByRole("button", { name: "다시 검증" }).focus();
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const r = element.getBoundingClientRect();
      const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      return { text: element.getAttribute("aria-label") ?? (element.textContent ?? "").trim().slice(0, 16), visible: element.checkVisibility?.() !== false && inView };
    });
    out.tab.push(info.text);
    expect(info.visible, `보이지 않는 요소에 초점: ${info.text}`).toBe(true);
  }
  await page.getByRole("dialog").press("Escape");
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toHaveCount(0);
  out.dialogs.push(["설정 창 안의 스킬과 카탈로그 탭", "왼쪽 목록에서 「스킬과 카탈로그」 누름", "해당 없음(새 입력 없음, 첫 동작은 「다시 검증」)", "해당 없음", "설정 창이 닫힘(기존 대화상자 동작). 새 팝오버나 메뉴는 없음", "설정을 연 단추(기존 동작)"]);

  // ---- 14번: 구성(소스 펼침, 본문 보기), 한눈에
  await openProfile(page, "wide", "light");
  await expect(assembly(page).getByTestId("agent-context-skills")).toBeVisible({ timeout: 15_000 });
  const toggle = assembly(page).locator("button[aria-expanded]").first();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const afterToggle = await active();
  await assembly(page).locator('button[aria-label$="본문 보기"]').first().click();
  const detailFocus = await active();
  expect(detailFocus).toContain("소스 목록으로");
  await page.getByLabel("소스 목록으로").click();
  await expect(toggle).toBeFocused();
  out.focus.push(["구성 소스 줄 펼침과 본문 보기", "줄을 누름, 이어서 「본문 보기」", `줄을 누른 뒤 초점 ${afterToggle}. 본문 보기 뒤 ${detailFocus}. 「소스 목록으로」 뒤 ${await active()}`]);
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  out.dialogs.push(["구성 소스 줄(펼침)", "줄을 누르거나 Enter", "줄에 그대로(펼침은 초점을 옮기지 않음)", "펼침과 접힘 전환", "해당 없음(펼침은 대화상자가 아님)", "줄에 그대로"]);
  out.dialogs.push(["구성 본문 보기(같은 자리 전환)", "줄 끝 「본문 보기」 아이콘 단추", "「소스 목록으로」 단추", "해당 없음", "해당 없음(설정 창 Esc는 위 줄과 같음)", "그 소스 줄(위에서 측정)"]);
  await page.getByRole("button", { name: "한눈에", exact: true }).click();
  const overviewFocus = await active();
  expect(overviewFocus).toContain("프로필 편집으로");
  out.focus.push(["한눈에 단추", "단추를 누름", `글이 「프로필 편집으로」로 바뀐 같은 단추에 초점이 남음: ${overviewFocus}`]);
  await overviewLoaded(page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-profile-editor")).toBeVisible();
  out.dialogs.push(["한눈에(같은 자리 전환)", "「한눈에」 단추", "같은 단추(글이 「프로필 편집으로」로 바뀜)", "단추를 다시 실행하면 프로필 편집으로 돌아감", "해당 없음", "같은 단추"]);

  // ---- 17번 오류 상태
  const alertIn = (selector: string) => page.locator(selector).getByRole("alert").first();
  const cases: Array<[string, () => Promise<void>]> = [
    ["스킬 탭 목록 요청 실패", async () => { await openSkills(page, "wide", "light", "failure"); await expect(alertIn('[data-testid="skill-catalog-settings"]')).toBeVisible(); await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible(); }],
    ["스킬 탭 본문 요청 실패", async () => { await openSkills(page, "wide", "light", "bodyfail"); await expect(alertIn("#guide-detail-panel")).toContainText("본문을 읽지 못했습니다"); await expect(page.locator("#guide-detail-panel").getByRole("button", { name: "다시 시도" })).toBeVisible(); }],
    ["쓰이는 곳 자료 요청 실패", async () => { await openSkills(page, "wide", "light", "overviewfail"); await skillsLoaded(page); await page.getByRole("tab", { name: "쓰이는 곳" }).click(); await expect(alertIn("#guide-detail-panel")).toContainText("프로필을 모으지 못했습니다"); await expect(page.locator("#guide-detail-panel").getByRole("button", { name: "다시 시도" })).toBeVisible(); }],
    ["한눈에 요청 실패", async () => { await openOverview(page, "wide", "light", "failure"); await expect(page.getByRole("alert")).toContainText("프로필을 모으지 못했습니다"); await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible(); }],
    ["구성 미리보기 요청 실패(기존 상태)", async () => { await openProfile(page, "wide", "light", { assemblyState: "failure" }); await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 }); await expect(page.getByRole("button", { name: "다시 시도" }).first()).toBeVisible(); }],
  ];
  for (const [label, run] of cases) {
    await run();
    out.errors.push(`${label}: 그 자리가 실패 안내(role=alert)로 바뀌고 「다시 시도」 단추가 같은 틀 안에 있음`);
  }

  // ---- 18번 창 크기 바꾸기
  await openSkills(page, "wide", "light");
  await skillsLoaded(page);
  const aside = page.locator('[data-testid="skill-catalog-frame"] aside');
  await aside.evaluate(element => { element.scrollTop = 600; });
  const rowName = await listRows(page).nth(8).evaluate(row => row.querySelector(".font-medium")?.textContent ?? "");
  await listRows(page).nth(8).click();
  await page.getByRole("tab", { name: "연결" }).click();
  const before = await aside.evaluate(element => element.scrollTop);
  await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
  await expect(page.getByRole("button", { name: "목록으로" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "연결" })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await expect(aside).toBeVisible();
  await expect.poll(() => aside.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const after = await aside.evaluate(element => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("tab", { name: "연결" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: rowName })).toBeVisible();
  out.resize.push(`스킬 탭 1440 → 360 → 1440: 360에서 상세가 서고(「목록으로」) 다시 넓히면 두 칸으로 돌아온다. 목록 스크롤 ${before} → ${after}, 고른 스킬(${rowName})과 「연결」 탭 유지. 이 화면에는 열린 팝오버와 메뉴가 없다`);

  await openOverview(page, "wide", "light");
  await overviewLoaded(page);
  const frame = page.getByTestId("agent-context-overview");
  await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
  await frame.evaluate(element => { element.scrollLeft = 120; });
  const left = await frame.evaluate(element => element.scrollLeft);
  const sticky = await frame.evaluate(element => {
    const th = element.querySelector<HTMLElement>("tbody th")!;
    return Math.abs(th.getBoundingClientRect().left - element.getBoundingClientRect().left);
  });
  expect(left).toBeGreaterThan(0);
  expect(sticky).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  out.overflow.push(`한눈에 360: 표만 가로 스크롤(scrollLeft ${left}), 줄 이름 칸이 틀 왼쪽에 붙음(차이 ${sticky.toFixed(1)}px), 페이지 가로 스크롤 없음`);
  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await expect(frame.locator("table")).toBeVisible();
  out.resize.push(`한눈에 1440 ↔ 360: 가로로 ${left}px 스크롤한 채 넓혀도 표가 그대로 서고 열 머리가 다시 그려진다`);

  // 구성과 한눈에 360
  await openProfile(page, "narrow", "light");
  await expect(assembly(page).getByTestId("agent-context-skills")).toBeVisible({ timeout: 15_000 });
  await assembly(page).locator("button[aria-expanded]").first().click();
  await narrowMeasure("구성 360, 소스를 펼친 모습과 스킬 구역");
  await openOverview(page, "narrow", "light");
  await overviewLoaded(page);
  await narrowMeasure("한눈에 360");

  // ---- 14번: 다시 검증은 눌러도 초점이 사라지지 않고 끝나면 단추로 돌아온다. 가짜 시계를 쓰므로 맨 끝에 둔다(이 뒤로 다른 화면을 열지 않는다).
  await page.clock.install({ time: new Date("2026-11-25T06:00:00Z") });
  await openSkills(page, "wide", "light");
  await skillsLoaded(page);
  const verify = page.getByRole("button", { name: "다시 검증" });
  await verify.click();
  const status = page.getByRole("button", { name: "검증 중" });
  await expect(status).toBeFocused();
  out.focus.push(["다시 검증", "단추를 누름(202)", `같은 단추가 「검증 중」 표시로 바뀌고 초점이 그대로 남음: ${await active()}`]);
  await page.clock.fastForward(15_000);
  await expect(verify).toBeVisible();
  await expect(verify).toBeFocused();
  out.focus.push(["검증이 끝남", "15초 뒤 목록을 다시 읽어 새 보고가 옴", `「다시 검증」 글로 돌아오고 초점이 그대로 남음: ${await active()}`]);
  out.dialogs.push(["다시 검증(같은 자리 전환)", "「다시 검증」 단추", "같은 단추(글이 「검증 중」으로 바뀌고 초점이 그대로 남음)", "해당 없음", "해당 없음(대화상자가 아님)", "끝나면 「다시 검증」 단추"]);

  writeOperations(out);
});
