// 세라피엘 화면 검수(카드 #1854)의 결함 여섯과 권함 둘, 못 본 것 둘의 완료 조건을 재고 판정한다.
// 잰 값 한 줄씩을 돌려주면 operations.md의 「검수 지적 완료 조건」 표로 들어간다.
import { expect, type Locator, type Page } from "@playwright/test";
import { NARROW, WIDE, openSettings, shot, type Theme } from "./agent-profile-assembly-guides-helpers";
import { listPitch, meanDifference, pressableAlignment, stickyGeometry, titleVisibility, treeGeometry } from "./agent-profile-assembly-guides-measure";

const assembly = (page: Page) => page.getByTestId("agent-context-assembly");
const f1 = (value: number) => value.toFixed(1);
const f2 = (value: number) => value.toFixed(2);

async function openProfile(page: Page, width: number, height: number, extra: { assemblyState?: string; theme?: Theme } = {}) {
  await openSettings(page, { width, height, category: "에이전트", ...extra });
  await expect(assembly(page).getByTestId("agent-context-skills")).toBeVisible({ timeout: 15_000 });
}
async function openSkills(page: Page, width: number, height: number, guidesState = "normal", theme: Theme = "light") {
  await openSettings(page, { width, height, category: "스킬과 카탈로그", guidesState, theme });
  if (guidesState === "normal" || guidesState === "verifyfail") {
    await expect(page.getByTestId("skill-catalog-skeleton")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator("button[data-settings-list-row]").first()).toBeVisible();
  }
}

/** 결함 1과 4, 권함 1: 구성 소스 줄 제목과 펼친 문서 트리. */
async function sourceRows(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const [width, height] of [[1440, 900], [800, 900], [360, 800]] as const) {
    await openProfile(page, width, height);
    const titles = await titleVisibility(assembly(page));
    const rows = titles.filter(item => item.text !== "전체" && !/^\d/.test(item.text));
    const min = Math.min(...rows.map(item => item.ratio));
    expect(min, `${width}px: 제목 보이는 폭이 전체 폭의 절반 미만 ${JSON.stringify(rows.filter(item => item.ratio < 0.5))}`).toBeGreaterThanOrEqual(width === 1440 ? 0.99 : 0.5);
    const longest = rows.reduce((a, b) => a.natural > b.natural ? a : b);
    await assembly(page).locator("button[aria-expanded]").nth(0).click();
    const tree = await treeGeometry(page, 0);
    expect(tree.rowToTree).toBeLessThan(tree.treeToNext!);
    expect(tree.leftInside && tree.rightInside).toBe(true);
    expect(tree.titleStartDelta).toBeLessThanOrEqual(1);
    // 실린 방식이 모두 같으면 머리에 한 번, 줄에는 되풀이하지 않는다.
    const how = await assembly(page).getByTestId("agent-context-documents-how").allTextContents();
    const repeated = await assembly(page).getByTestId("agent-context-documents").first().getByText(/본문까지|이름과 설명만|제목만/).count();
    expect(how).toEqual(["본문까지"]);
    expect(repeated).toBe(0);
    if (width !== 800) await shot(page, `states/profile-expanded-${width === 1440 ? "wide" : "narrow"}.png`);
    lines.push(`구성 줄 ${width}px: 가장 긴 제목 보이는 폭/전체 폭 ${Math.round(longest.visible)}/${Math.round(longest.natural)}(${f2(longest.ratio)}), 줄 전체 가운데 최소 비율 ${f2(min)}${width === 1440 ? "(모두 다 보임, 1440 모양 그대로)" : "(짧은 제목은 모두 다 보임)"}. 펼친 트리: 줄→트리 ${f1(tree.rowToTree)}px < 트리→다음 줄 ${f1(tree.treeToNext!)}px, 좌우 끝이 줄 상자 안, 문서명과 제목 시작선 차이 ${f1(tree.titleStartDelta)}px, 실린 방식은 머리에 한 번(줄마다 0번)`);
  }
  return lines;
}

/** 결함 2: 한눈에 열 머리가 세로 스크롤에도 붙어 있고 모서리 칸 위로 뒤 칸이 비치지 않는다. */
async function matrixSticky(page: Page): Promise<string[]> {
  const lines: string[] = [];
  await openProfile(page, WIDE.width, 700);
  await page.getByRole("button", { name: "한눈에", exact: true }).click();
  const frame = page.getByTestId("agent-context-overview");
  await expect(frame.locator("table")).toBeVisible({ timeout: 15_000 });
  const rows = await frame.locator("tbody tr").count();
  expect(rows - 2).toBeGreaterThan(20);
  const tall = await stickyGeometry(frame, { left: 0, top: "end" });
  expect(tall.scrollable).toBe(true);
  expect(Math.abs(tall.headTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(tall.cornerTop)).toBeLessThanOrEqual(1);
  await shot(page, "states/overview-scrolled-700.png");
  lines.push(`한눈에 1440x700(공유 소스 ${rows - 2}줄 + 따로 둔 두 줄): 세로 끝까지 스크롤한 채 열 머리와 틀 위 가장자리 차이 ${f1(tall.headTop)}px, 모서리 칸 ${f1(tall.cornerTop)}px`);

  await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
  const corner = frame.locator("thead th.guides-matrix-corner");
  await stickyGeometry(frame, { left: 0, top: 0 });
  const rest = await corner.screenshot();
  const narrow = await stickyGeometry(frame, { left: 240, top: 300 });
  const moved = await corner.screenshot();
  const diff = await meanDifference(page, rest, moved);
  expect(Math.abs(narrow.nameLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(narrow.cornerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(narrow.headTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(narrow.cornerTop)).toBeLessThanOrEqual(1);
  expect(diff, "모서리 칸 위로 스크롤한 칸이 비침").toBeLessThan(12);
  await shot(page, "states/overview-scrolled-360.png");
  lines.push(`한눈에 360: 가로 240, 세로 300 스크롤 뒤 줄 이름 칸 ${f1(narrow.nameLeft)}px, 모서리 칸 왼쪽 ${f1(narrow.cornerLeft)}px 위쪽 ${f1(narrow.cornerTop)}px, 열 머리 위쪽 ${f1(narrow.headTop)}px 차이. 모서리 칸 캡처를 스크롤 전후로 견준 평균 채널 차이 ${f2(diff)}/255(뒤 칸이 비치면 커진다)`);
  return lines;
}

/** 결함 3: 「경고 있는 것만」 켬은 default, 끔은 outline. 두 테마에서 켬이 끔과 disabled와 가려진다. */
async function warningsToggle(page: Page): Promise<string[]> {
  const lines: string[] = [];
  const style = (button: Locator) => button.evaluate(element => { const s = getComputedStyle(element); return { bg: `${s.backgroundColor} ${s.backgroundImage === "none" ? "" : "+ 그라데이션 바탕"}`.trim(), color: s.color, border: s.borderTopColor, opacity: s.opacity }; });
  for (const theme of ["light", "dark"] as const) {
    await openSkills(page, WIDE.width, WIDE.height, "loading", theme);
    const disabled = await style(page.getByRole("button", { name: "경고 있는 것만" }));
    expect(await page.getByRole("button", { name: "경고 있는 것만" }).isDisabled()).toBe(true);
    await openSkills(page, WIDE.width, WIDE.height, "normal", theme);
    const toggle = page.getByRole("button", { name: "경고 있는 것만" });
    const off = await style(toggle);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.blur();
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await style(toggle)).opacity).toBe("1");
    const on = await style(toggle);
    expect(on.bg).not.toBe(off.bg);
    expect(on.bg).not.toBe(disabled.bg);
    expect(Number(on.opacity)).toBe(1);
    expect(Number(disabled.opacity)).toBeLessThan(1);
    await page.getByTestId("skill-catalog-frame").locator("aside").screenshot({ path: `../.local/shots/states/warnings-toggle-${theme}.png` });
    lines.push(`경고 있는 것만 ${theme}: 끔 바탕 ${off.bg}, 켬 바탕 ${on.bg}(글 ${on.color}), disabled 바탕 ${disabled.bg}·불투명도 ${disabled.opacity}. 켬은 끔·disabled와 바탕이 다르고 불투명도 1`);
  }
  return lines;
}

/** 결함 5: 눌리는 줄 시작선, 눌림 바탕, 줄 높이, 배지 칸. */
async function pressableRows(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const [width, height] of [[WIDE.width, WIDE.height], [NARROW.width, NARROW.height]] as const) {
    await openSkills(page, width, height);
    // 카탈로그 상세 「쓰는 스킬」: 쓰는 스킬이 있는 카탈로그를 고른다.
    await page.getByRole("tab", { name: "카탈로그", exact: true }).click();
    const rowsNow = page.locator("button[data-settings-list-row]");
    const group = (title: string) => page.locator("p.mb-2", { hasText: title }).locator("..");
    let picked = false;
    for (let index = 0; index < 8 && !picked; index += 1) {
      await rowsNow.nth(index).click();
      picked = await group("쓰는 스킬").locator("button").count() > 1;
    }
    expect(picked).toBe(true);
    const used = group("쓰는 스킬");
    const neighbor = group("구성");
    const alignment = await pressableAlignment(used);
    const usedPitch = await listPitch(used, "li");
    const neighborPitch = await listPitch(neighbor, "li");
    const neighborLeft = await neighbor.evaluate(box => { const range = document.createRange(); range.selectNodeContents(box.querySelector("li")!); return range.getClientRects()[0]!.left; });
    for (const left of alignment.nameLefts) expect(Math.abs(left - alignment.titleLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(neighborLeft - alignment.titleLeft)).toBeLessThanOrEqual(1);
    expect(alignment.hoverInside).toBe(true);
    expect(usedPitch[0]).toBeCloseTo(neighborPitch[0]!, 0);
    if (width === WIDE.width) await shot(page, "states/catalog-uses-aligned.png");
    lines.push(`쓰는 스킬 ${width}px: 이름 시작선과 묶음 제목 시작선 차이 최대 ${f1(Math.max(...alignment.nameLefts.map(left => Math.abs(left - alignment.titleLeft))))}px(이웃 「구성」 줄과도 ${f1(Math.abs(neighborLeft - alignment.titleLeft))}px), 줄 간격 ${f1(usedPitch[0]!)}px = 이웃 묶음 ${f1(neighborPitch[0]!)}px, 눌림 바탕이 상자 테두리 안`);

    // 스킬 연결 탭: 나가는 연결과 들어오는 연결(한 칸 폭이면 먼저 목록으로 돌아간다).
    const back = page.getByRole("button", { name: "목록으로" });
    if (await back.isVisible()) await back.click();
    await page.getByRole("tab", { name: "스킬", exact: true }).click();
    let linked = false;
    for (let index = 0; index < 16 && !linked; index += 1) {
      await page.locator("button[data-settings-list-row]").nth(index).click();
      await page.getByRole("tab", { name: "연결" }).click();
      linked = await group("나가는 연결").locator("button").count() > 0 && await group("들어오는 연결").locator("button").count() > 0;
    }
    expect(linked).toBe(true);
    const outgoing = await pressableAlignment(group("나가는 연결"));
    const incoming = await pressableAlignment(group("들어오는 연결"));
    for (const part of [outgoing, incoming]) {
      expect(part.hoverInside).toBe(true);
      for (const left of part.badgeLefts) expect(Math.abs(left - part.titleLeft)).toBeLessThanOrEqual(1.5);
    }
    const names = [...outgoing.nameLefts, ...incoming.nameLefts];
    expect(Math.max(...names) - Math.min(...names)).toBeLessThanOrEqual(1);
    if (width === WIDE.width) await shot(page, "states/links-aligned.png");
    lines.push(`연결 탭 ${width}px: 종류 배지 시작선과 묶음 제목 시작선 차이 최대 ${f1(Math.max(...[outgoing, incoming].flatMap(part => part.badgeLefts.map(left => Math.abs(left - part.titleLeft)))))}px, 이름 시작선이 두 묶음 모든 줄에서 ${f1(Math.max(...names) - Math.min(...names))}px 안에서 같고, 눌림 바탕이 상자 테두리 안`);
  }
  return lines;
}

/** 결함 6: 빈 상태 안내는 한 번만. */
async function emptyOnce(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const [width, height, label] of [[WIDE.width, WIDE.height, "넓은 폭"], [NARROW.width, NARROW.height, "한 칸 폭"]] as const) {
    await openSkills(page, width, height, "empty");
    const visible = page.getByTestId("skill-catalog-settings").getByText("항목이 없습니다.").filter({ visible: true });
    await expect(visible).toHaveCount(1);
    if (width === WIDE.width) await shot(page, "states/empty-skills.png");
    lines.push(`빈 상태 ${label}(${width}px): 보이는 「항목이 없습니다.」 ${await visible.count()}번`);
  }
  return lines;
}

/** 권함 2: 좁은 폭의 긴 이름과 설명을 접어 본문 칸을 지킨다. */
async function narrowBody(page: Page, longName: string): Promise<string[]> {
  await openSkills(page, NARROW.width, NARROW.height);
  const row = page.locator("button[data-settings-list-row]").filter({ hasText: longName });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByRole("heading", { name: longName })).toBeVisible();
  const toggle = page.getByRole("button", { name: "더 보기" });
  await expect(toggle).toBeVisible();
  const read = () => page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('#guide-detail-panel [data-slot="context-content-fill"]') ?? document.querySelector<HTMLElement>("#guide-detail-panel")!;
    const description = document.querySelector<HTMLElement>("#guide-detail-panel")!.previousElementSibling!.previousElementSibling!.querySelector<HTMLElement>("p")!;
    return { body: body.getBoundingClientRect().height, descriptionHeight: description.getBoundingClientRect().height, viewport: innerHeight };
  });
  await expect(page.locator('#guide-detail-panel [data-slot="context-content-fill"]')).toBeVisible({ timeout: 15_000 });
  const folded = await read();
  expect(folded.body).toBeGreaterThanOrEqual(folded.viewport / 2 - 1);
  await shot(page, "states/skills-narrow-long.png");
  await toggle.click();
  await expect(page.getByRole("button", { name: "접기" })).toHaveAttribute("aria-expanded", "true");
  const open = await read();
  expect(open.descriptionHeight).toBeGreaterThan(folded.descriptionHeight);
  expect(open.body).toBeGreaterThanOrEqual(open.viewport / 2 - 1);
  return [`스킬 상세 360x800, 가장 긴 이름과 설명: 접힌 설명 ${Math.round(folded.descriptionHeight)}px(세 줄)에서 본문 칸 ${Math.round(folded.body)}px(화면 높이의 ${f2(folded.body / folded.viewport)}), 「더 보기」로 펼치면 설명 ${Math.round(open.descriptionHeight)}px에도 본문 칸 ${Math.round(open.body)}px`];
}

/** 못 본 것: 실행 노드를 바꾸면 한눈에 칸이 그 노드의 설정 전용 프로필로 바뀐다. */
async function nodeSwitch(page: Page): Promise<string[]> {
  await openProfile(page, WIDE.width, WIDE.height);
  await page.getByRole("button", { name: "한눈에", exact: true }).click();
  const frame = page.getByTestId("agent-context-overview");
  const heads = () => frame.locator("thead th.guides-matrix-profile").evaluateAll(items => items.map(item => ({ name: item.getAttribute("title") ?? "", node: item.getAttribute("data-first-node") === "true" })));
  await expect(frame.locator("table")).toBeVisible({ timeout: 15_000 });
  const first = await heads();
  const select = page.getByLabel("실행 노드");
  await select.selectOption("sample-usage-node");
  await expect.poll(async () => (await heads()).length, { timeout: 15_000 }).not.toBe(first.length);
  const second = await heads();
  // 중앙 프로필 열은 노드 설정 전용 열(data-first-node)보다 앞에 있다.
  const central = (items: typeof first) => items.findIndex(item => item.node);
  expect(second.length).toBe(first.length - 4);
  expect(second.some(item => item.name === "가온") && second.some(item => item.name === "하늬")).toBe(true);
  expect(first.some(item => item.name === "누리") && !second.some(item => item.name === "누리")).toBe(true);
  expect(central(second)).toBe(central(first));
  await shot(page, "states/overview-node-switched.png");
  await select.selectOption("sample-node");
  await expect.poll(async () => (await heads()).length, { timeout: 15_000 }).toBe(first.length);
  return [`실행 노드 전환(한눈에, 1440): sample-node 열 ${first.length}개(중앙 11 + 설정 전용 7)에서 sample-usage-node로 바꾸면 열 ${second.length}개(중앙 11 + 설정 전용 가온, 나비, 하늬)로 바뀌고 이전 노드의 열(누리)은 사라진다. 다시 sample-node로 돌리면 ${first.length}개로 돌아온다. 중앙 프로필 열 수는 두 노드에서 같다`];
}

/** 못 본 것: 다시 검증이 202도 409도 아닌 실패(500)일 때. */
async function verifyFailed(page: Page): Promise<string[]> {
  await openSkills(page, WIDE.width, WIDE.height, "verifyfail");
  const verify = page.getByRole("button", { name: "다시 검증" });
  await verify.click();
  const head = page.getByTestId("skill-catalog-report");
  await expect(head.getByRole("alert")).toContainText("요청하지 못했습니다");
  await expect(verify).toBeVisible();
  await expect(verify).toBeFocused();
  await expect(head).not.toContainText("검증 중");
  await shot(page, "states/verify-failed.png");
  return ["다시 검증 실패(견본 500): 같은 단추 자리에서 「요청하지 못했습니다」 안내(role=alert)가 단추 왼쪽에 서고, 「다시 검증」 단추는 그대로 남아 있어 다시 누를 수 있으며, 초점이 단추에 그대로 남음(「검증 중」으로 바뀌지 않음)"];
}

const PARTS: Array<[string, (page: Page, longName: string) => Promise<string[]>]> = [
  ["sourceRows", page => sourceRows(page)], ["matrixSticky", page => matrixSticky(page)], ["warningsToggle", page => warningsToggle(page)],
  ["pressableRows", page => pressableRows(page)], ["emptyOnce", page => emptyOnce(page)], ["narrowBody", narrowBody],
  ["nodeSwitch", page => nodeSwitch(page)], ["verifyFailed", page => verifyFailed(page)],
];

/** FIXES_PARTS=이름,이름 으로 일부만 돌릴 수 있다(개발용). 기본은 전부. */
export async function measureFixes(page: Page, longName: string): Promise<string[]> {
  const only = process.env.FIXES_PARTS?.split(",");
  const lines: string[] = [];
  for (const [name, run] of PARTS) if (!only || only.includes(name)) lines.push(...await run(page, longName));
  return lines;
}
