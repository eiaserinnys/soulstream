// 세라피엘 화면 검수(카드 #1854)의 완료 조건을 재고 판정한다. 1차의 결함 여섯과 권함 둘, 못 본 것 둘, 2차의 결함 A(한눈에 세로 스크롤)와 B(검증 줄).
// 잰 값 한 줄씩을 돌려주면 operations.md의 「검수 지적 완료 조건」 표로 들어간다.
import { expect, type Locator, type Page } from "@playwright/test";
import { NARROW, WIDE, openSettings, shot, type Theme } from "./agent-profile-assembly-guides-helpers";
import {
  listPitch, meanDifference, overviewCenter, pressableAlignment, reportRow, settleScroll, stickyGeometry, summarizeWheel, titleVisibility, treeGeometry, wheelOverview,
  type WheelSummary,
} from "./agent-profile-assembly-guides-measure";

const assembly = (page: Page) => page.getByTestId("agent-context-assembly");
const f1 = (value: number) => value.toFixed(1);
const f2 = (value: number) => value.toFixed(2);

async function openProfile(page: Page, width: number, height: number, extra: { assemblyState?: string; theme?: Theme } = {}) {
  await openSettings(page, { width, height, category: "에이전트 프로필", ...extra });
  await expect(assembly(page).getByTestId("agent-context-skills")).toBeVisible({ timeout: 15_000 });
}
async function openSkills(page: Page, width: number, height: number, guidesState = "normal", theme: Theme = "light") {
  await openSettings(page, { width, height, category: "스킬과 카탈로그", guidesState, theme });
  if (guidesState === "normal" || guidesState === "verifyfail" || guidesState === "conflict") {
    await expect(page.getByTestId("skill-catalog-skeleton")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator("button[data-settings-list-row]").first()).toBeVisible();
  }
}

/** 결함 1과 4, 권함 1: 구성 소스 줄 제목과 펼친 문서 트리. 한 번 열어 창 크기만 바꿔 가며 잰다. */
async function sourceRows(page: Page): Promise<string[]> {
  const lines: string[] = [];
  await openProfile(page, 1440, 900);
  await assembly(page).locator("button[aria-expanded]").nth(0).click();
  for (const [width, height] of [[1440, 900], [800, 900], [360, 800]] as const) {
    await page.setViewportSize({ width, height });
    // 목록 폭을 지켜보는 관찰자가 줄 모양을 바꾸길 기다린다.
    await expect.poll(async () => {
      const rows = (await titleVisibility(assembly(page))).filter(item => item.text !== "전체");
      return Math.min(...rows.map(item => item.ratio)) >= (width === 1440 ? 0.99 : 0.5);
    }, { message: `${width}px: 제목 보이는 폭이 전체 폭의 절반 미만`, timeout: 10_000 }).toBe(true);
    const rows = (await titleVisibility(assembly(page))).filter(item => item.text !== "전체");
    const min = Math.min(...rows.map(item => item.ratio));
    const longest = rows.reduce((a, b) => a.natural > b.natural ? a : b);
    const tree = await treeGeometry(page, 0);
    expect(tree.rowToTree).toBeLessThan(tree.treeToNext!);
    expect(tree.leftInside && tree.rightInside).toBe(true);
    expect(tree.titleStartDelta).toBeLessThanOrEqual(1);
    // 실린 방식이 모두 같으면 머리에 한 번, 줄에는 되풀이하지 않는다.
    expect(await assembly(page).getByTestId("agent-context-documents-how").allTextContents()).toEqual(["본문까지"]);
    expect(await assembly(page).getByTestId("agent-context-documents").first().getByText(/본문까지|이름과 설명만|제목만/).count()).toBe(0);
    if (width !== 800) await shot(page, `states/profile-expanded-${width === 1440 ? "wide" : "narrow"}.png`);
    lines.push(`구성 줄 ${width}px: 가장 긴 제목 보이는 폭/전체 폭 ${Math.round(longest.visible)}/${Math.round(longest.natural)}(${f2(longest.ratio)}), 줄 전체 가운데 최소 비율 ${f2(min)}${width === 1440 ? "(모두 다 보임, 1440 모양 그대로)" : "(짧은 제목은 모두 다 보임)"}. 펼친 트리: 줄→트리 ${f1(tree.rowToTree)}px < 트리→다음 줄 ${f1(tree.treeToNext!)}px, 좌우 끝이 줄 상자 안, 문서명과 제목 시작선 차이 ${f1(tree.titleStartDelta)}px, 실린 방식은 머리에 한 번(줄마다 0번)`);
  }
  return lines;
}

async function openOverviewAt(page: Page, width: number, height: number, theme: Theme) {
  await openProfile(page, width, height, { theme });
  await page.getByRole("button", { name: "한눈에", exact: true }).click();
  const frame = page.getByTestId("agent-context-overview");
  await expect(frame.locator("table")).toBeVisible({ timeout: 15_000 });
  return frame;
}

/** 휠 측정 요약 한 줄: 무엇이 얼마나 움직였고, 열 머리와 마지막 줄이 보이는 자리 안에 있었는가. */
const wheelLine = (summary: WheelSummary) => {
  const end = summary.end;
  return `상세 칸 ${f1(summary.detailMoved)}px, 표 틀 ${f1(summary.frameMoved)}px 움직임. 열 머리와 모서리 칸이 보이는 자리 밖에 나간 단계 ${summary.headHidden.length}번(열 머리 위끝과 보이는 위끝 차이 최소 ${f1(summary.minHeadGap)}px), 끝에 「스킬 목록」 줄 아래끝 ${f1(end.lastBottom)}(보이는 아래끝, 곧 하단 막대 위끝 ${f1(end.viewBottom)}, 표 틀 안쪽 아래끝 ${f1(end.frameInnerBottom)}), 열 머리 위끝 ${f1(end.headTop)}(보이는 위끝, 곧 설정 머리 아래끝 ${f1(end.viewTop)}). 표 위에서 굴렸는데 아무것도 못 움직이고 가려진 단계 ${summary.stuck.length}번`;
};

/** 휠 측정의 판정: 먼저 무언가 움직였는가, 그다음 열 머리, 막힘, 끝 줄. */
function expectWheel(summary: WheelSummary, label: string, { mustMove }: { mustMove: boolean }) {
  if (mustMove) expect(summary.moved, `${label}: 휠이 아무것도 움직이지 못함`).toBeGreaterThan(0);
  expect(summary.headHidden, `${label}: 열 머리나 모서리 칸이 보이는 자리 밖으로 나간 단계`).toEqual([]);
  expect(summary.stuck, `${label}: 표가 가려졌는데 휠이 아무것도 움직이지 못한 단계`).toEqual([]);
  expect(summary.lastShown, `${label}: 끝까지 굴린 뒤에도 마지막 줄이 가려짐`).toBe(true);
}

const OVERVIEW_SIZES = [[360, 800, "light"], [360, 800, "dark"], [390, 844, "light"], [1366, 768, "light"], [1440, 700, "light"], [1440, 900, "light"]] as const;

/**
 * 2차 결함 A(검수 시나리오 B overview): 한눈에 표 가운데에 포인터를 두고 휠을 250씩 12번 굴리는 동안
 * 열 머리와 모서리 칸이 상세 칸의 보이는 자리 안에 있고, 끝에 마지막 줄이 하단 막대 위에 다 보인다. scrollTop은 넣지 않는다.
 */
async function overviewChecks(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const [width, height, theme] of OVERVIEW_SIZES) {
    const frame = await openOverviewAt(page, width, height, theme);
    const rows = await frame.locator("tbody tr").count();
    expect(rows - 2).toBeGreaterThan(20);
    const label = `한눈에 ${width}x${height} ${theme === "light" ? "밝음" : "어두움"}`;
    const before = await frame.boundingBox();
    const corner = frame.locator("thead th.guides-matrix-corner");
    const sideways = width === NARROW.width && theme === "light";
    const rest = sideways ? await corner.screenshot({ timeout: 30_000 }) : null;
    const point = await overviewCenter(page);
    const summary = summarizeWheel(await wheelOverview(page, point));
    console.log(`${label}: ${wheelLine(summary)}`);
    expectWheel(summary, label, { mustMove: true });
    lines.push(`${label}(공유 소스 ${rows - 2}줄 + 따로 둔 두 줄, 표 틀 ${Math.round(before!.y)}~${Math.round(before!.y + before!.height)}): 표 가운데(${point.x}, ${point.y})에서 휠 250×12. ${wheelLine(summary)}`);
    if (width === 1440 && height === 700) await shot(page, "states/overview-scrolled-700.png");
    if (sideways) {
      await shot(page, "states/overview-scrolled-360.png");
      // 끝까지 내린 채 가로로도 굴려 줄 이름 칸과 모서리 칸이 붙어 있고 뒤 칸이 비치지 않는지 본다.
      await page.mouse.wheel(240, 0);
      await settleScroll(page);
      const left = await frame.evaluate(element => element.scrollLeft);
      expect(left, "가로 휠이 표를 움직이지 못함").toBeGreaterThan(0);
      const sticky = await stickyGeometry(frame);
      const diff = await meanDifference(page, rest!, await corner.screenshot({ timeout: 30_000 }));
      expect(Math.abs(sticky.nameLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(sticky.cornerLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(sticky.headTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(sticky.cornerTop)).toBeLessThanOrEqual(1);
      expect(diff, "모서리 칸 위로 스크롤한 칸이 비침").toBeLessThan(12);
      await shot(page, "states/overview-scrolled-360-left.png");
      lines.push(`한눈에 360 가로: 끝까지 내린 채 가로 휠 240으로 표가 ${f1(left)}px 움직인 뒤 줄 이름 칸 ${f1(sticky.nameLeft)}px, 모서리 칸 왼쪽 ${f1(sticky.cornerLeft)}px 위쪽 ${f1(sticky.cornerTop)}px, 열 머리 위쪽 ${f1(sticky.headTop)}px(틀 안쪽 가장자리와의 차이). 모서리 칸 캡처를 스크롤 전후로 견준 평균 채널 차이 ${f2(diff)}/255(뒤 칸이 비치면 커진다)`);
    }
    if (width === WIDE.width && height === WIDE.height) lines.push(...await nodeSwitch(page));
  }
  return lines;
}

/** 실행 노드 전환: 한눈에 칸이 그 노드의 설정 전용 프로필로 바뀐다. 한눈에가 1440x900으로 열려 있을 때 부른다. */
async function nodeSwitch(page: Page): Promise<string[]> {
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

/**
 * 2차 결함 A(검수 시나리오 B2 wheel chaining control): 표 밖(「에이전트」 제목)에서 먼저 굴려 표가 포인터 밑에 와도 멈추지 않고,
 * 이어서 표 가운데에서 굴리면 끝 줄까지 보인다.
 */
async function overviewChaining(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const [width, height] of [[1440, 700], [360, 800]] as const) {
    await openOverviewAt(page, width, height, "light");
    const heading = (await page.getByRole("heading", { name: "에이전트 프로필", exact: true }).boundingBox())!;
    const outsidePoint = { x: Math.round(heading.x + 10), y: Math.round(heading.y + heading.height / 2) };
    const outside = summarizeWheel(await wheelOverview(page, outsidePoint));
    console.log(`연쇄 ${width}x${height} 표 밖: ${wheelLine(outside)}`);
    expect(outside.moved, `${width}x${height}: 표 밖 휠이 아무것도 움직이지 못함`).toBeGreaterThan(0);
    expect(outside.headHidden, `${width}x${height}: 표 밖 휠 동안 열 머리가 보이는 자리 밖으로 나감`).toEqual([]);
    expect(outside.stuck, `${width}x${height}: 표가 포인터 밑에 온 뒤 휠이 멈춤`).toEqual([]);
    const over = summarizeWheel(await wheelOverview(page, await overviewCenter(page)));
    console.log(`연쇄 ${width}x${height} 표 위: ${wheelLine(over)}`);
    expectWheel(over, `${width}x${height} 표 밖 다음 표 위`, { mustMove: false });
    await shot(page, `states/overview-chaining-${width}x${height}.png`);
    lines.push(`한눈에 연쇄 ${width}x${height}: 「에이전트」 제목(${outsidePoint.x}, ${outsidePoint.y})에서 먼저 휠 250×12로 상세 칸 ${f1(outside.detailMoved)}px, 표 틀 ${f1(outside.frameMoved)}px 움직이고 막힌 단계 ${outside.stuck.length}번. 이어서 표 가운데에서 250×12: ${wheelLine(over)}`);
  }
  return lines;
}

/** 한 칸 폭이면 먼저 상세에서 목록으로 돌아간다. */
async function toList(page: Page) {
  const back = page.getByRole("button", { name: "목록으로" });
  if (await back.isVisible()) await back.click();
}

/** 결함 3: 「경고 있는 것만」 켬은 default, 끔은 outline. 열려 있는 스킬 탭에서 잰다. */
async function warningsToggle(page: Page, theme: Theme): Promise<string[]> {
  const style = (button: Locator) => button.evaluate(element => { const s = getComputedStyle(element); return { bg: `${s.backgroundColor} ${s.backgroundImage === "none" ? "" : "+ 그라데이션 바탕"}`.trim(), color: s.color, opacity: s.opacity }; });
  const toggle = page.getByRole("button", { name: "경고 있는 것만" });
  await page.mouse.move(0, 0);
  const off = await style(toggle);
  // disabled는 같은 단추에 disabled를 잠깐 걸어 계산된 모양을 읽는다(목록을 불러오는 중에 단추가 이 모양이 된다).
  const disabled = await toggle.evaluate(element => {
    (element as HTMLButtonElement).disabled = true;
    const s = getComputedStyle(element);
    const value = { bg: `${s.backgroundColor} ${s.backgroundImage === "none" ? "" : "+ 그라데이션 바탕"}`.trim(), opacity: s.opacity };
    (element as HTMLButtonElement).disabled = false;
    return value;
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.blur();
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await style(toggle)).opacity).toBe("1");
  const on = await style(toggle);
  expect(on.bg).not.toBe(off.bg);
  expect(on.bg).not.toBe(disabled.bg);
  expect(Number(disabled.opacity)).toBeLessThan(1);
  await page.getByTestId("skill-catalog-frame").locator("aside").screenshot({ path: `../.local/shots/states/warnings-toggle-${theme}.png`, timeout: 30_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  return [`경고 있는 것만 ${theme}: 끔 바탕 ${off.bg}, 켬 바탕 ${on.bg}(글 ${on.color}), disabled 바탕 ${disabled.bg}·불투명도 ${disabled.opacity}. 켬은 끔·disabled와 바탕이 다르고 불투명도 1`];
}

/** 결함 5: 눌리는 줄 시작선, 눌림 바탕, 줄 높이, 배지 칸. 열려 있는 스킬 탭을 지금 창 폭에서 잰다. */
async function pressableRows(page: Page): Promise<string[]> {
  const lines: string[] = [];
  const width = page.viewportSize()!.width;
  await toList(page);
  // 카탈로그 상세 「쓰는 스킬」: 쓰는 스킬이 있는 카탈로그를 고른다.
  await page.getByRole("tab", { name: "카탈로그", exact: true }).click();
  const rowsNow = page.locator("button[data-settings-list-row]");
  const group = (title: string) => page.locator("p.mb-2", { hasText: title }).locator("..");
  let picked = false;
  for (let index = 0; index < 8 && !picked; index += 1) {
    await toList(page);
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

  // 스킬 연결 탭: 나가는 연결과 들어오는 연결.
  await toList(page);
  await page.getByRole("tab", { name: "스킬", exact: true }).click();
  let linked = false;
  for (let index = 0; index < 16 && !linked; index += 1) {
    await toList(page);
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
  return lines;
}

/** 권함 2: 좁은 폭의 긴 이름과 설명을 접어 본문 칸을 지킨다. 열려 있는 스킬 탭을 360 폭에서 잰다. */
async function narrowBody(page: Page, longName: string): Promise<string[]> {
  await toList(page);
  await page.getByRole("tab", { name: "스킬", exact: true }).click();
  const row = page.locator("button[data-settings-list-row]").filter({ hasText: longName });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByRole("heading", { name: longName })).toBeVisible();
  await page.getByRole("tab", { name: "본문" }).click();
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

/** 결함 6: 빈 상태 안내는 한 번만. 한 번 열고 창 크기만 바꿔 넓은 폭과 한 칸 폭을 잰다. */
async function emptyOnce(page: Page): Promise<string[]> {
  const lines: string[] = [];
  await openSkills(page, WIDE.width, WIDE.height, "empty");
  for (const [width, height, label] of [[WIDE.width, WIDE.height, "넓은 폭"], [NARROW.width, NARROW.height, "한 칸 폭"]] as const) {
    await page.setViewportSize({ width, height });
    const visible = page.getByTestId("skill-catalog-settings").getByText("항목이 없습니다.").filter({ visible: true });
    await expect(visible).toHaveCount(1);
    if (width === WIDE.width) await shot(page, "states/empty-skills.png");
    lines.push(`빈 상태 ${label}(${width}px): 보이는 「항목이 없습니다.」 ${await visible.count()}번`);
  }
  return lines;
}

/** 스킬 탭을 밝은 테마로 한 번 열어 토글, 눌리는 줄(넓은 폭과 한 칸 폭), 좁은 폭 본문 칸을 잰다. */
async function skillScreens(page: Page, longName: string): Promise<string[]> {
  const lines: string[] = [];
  await openSkills(page, WIDE.width, WIDE.height, "normal", "light");
  lines.push(...await warningsToggle(page, "light"));
  lines.push(...await pressableRows(page));
  await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
  lines.push(...await pressableRows(page));
  lines.push(...await narrowBody(page, longName));
  await openSkills(page, WIDE.width, WIDE.height, "normal", "dark");
  lines.push(...await warningsToggle(page, "dark"));
  return lines;
}

/**
 * 1차 못 본 것과 2차 결함 B(검수 시나리오 G report row states on phones): 다시 검증이 202도 409도 아닌 실패(500)일 때
 * 날짜와 「검증」은 한 줄이고, 단추는 그 줄 오른쪽 끝에 초점을 지닌 채 남고, 안내는 다 보이며 단추와 겹치지 않는다.
 */
async function verifyFailed(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const [width, height] of [[1440, 900], [390, 844], [360, 800]] as const) {
    await openSkills(page, width, height, "verifyfail");
    const verify = page.getByRole("button", { name: "다시 검증" });
    await verify.click();
    const head = page.getByTestId("skill-catalog-report");
    await expect(head.getByRole("alert")).toContainText("요청하지 못했습니다");
    await expect(verify).toBeVisible();
    await expect(verify).toBeFocused();
    await expect(head).not.toContainText("검증 중");
    const row = await reportRow(page);
    console.log(`다시 검증 실패 ${width}: ${JSON.stringify(row)}`);
    const button = row.button!;
    const notice = row.notice!;
    const buttonMid = (button.top + button.bottom) / 2;
    const dateMid = (row.date.top + row.date.bottom) / 2;
    const noticeMid = (notice.top + notice.bottom) / 2;
    const label = `${width}px`;
    expect(row.dateText, label).toMatch(/\d+월 \d+일 \d{2}:\d{2} 검증$/);
    expect(row.dateLines, `${label}: 날짜와 「검증」이 줄 중간에서 쪼개짐`).toBe(1);
    expect(Math.abs(button.right - row.rowRight), `${label}: 단추가 줄 오른쪽 끝에 없음`).toBeLessThanOrEqual(1);
    expect(Math.abs(buttonMid - dateMid), `${label}: 단추가 날짜 줄에 없음`).toBeLessThanOrEqual(2);
    expect(row.buttonFocused, `${label}: 초점이 단추에 없음`).toBe(true);
    expect(notice.lines, `${label}: 안내가 쪼개짐`).toBe(1);
    expect(notice.clipped || !notice.inRow, `${label}: 안내가 잘림`).toBe(false);
    const overlaps = notice.left < button.right && notice.right > button.left && notice.top < button.bottom && notice.bottom > button.top;
    expect(overlaps, `${label}: 안내가 단추와 겹침`).toBe(false);
    // 넓은 폭은 안내가 단추 왼쪽 같은 줄에 선다(모양 그대로). 한 칸 폭은 다음 줄 끝으로 내려간다.
    if (width === WIDE.width) {
      expect(Math.abs(noticeMid - buttonMid)).toBeLessThanOrEqual(2);
      expect(notice.right).toBeLessThanOrEqual(button.left);
    } else {
      expect(notice.top).toBeGreaterThanOrEqual(button.bottom - 1);
      expect(Math.abs(notice.right - row.rowRight)).toBeLessThanOrEqual(1);
    }
    if (width !== 390) await shot(page, `states/verify-failed-${width}.png`);
    const where = width === WIDE.width ? `단추 왼쪽 같은 줄(안내 가운데 ${f1(noticeMid)}, 단추 가운데 ${f1(buttonMid)})` : `다음 줄 끝(안내 위끝 ${f1(notice.top)} ≥ 단추 아래끝 ${f1(button.bottom)}, 오른쪽 끝 차이 ${f1(Math.abs(notice.right - row.rowRight))}px)`;
    lines.push(`다시 검증 실패 ${label}(견본 500): 「${row.dateText}」 ${row.dateLines}줄, 줄 높이 ${Math.round(row.rowHeight)}px. 단추 x ${f1(button.left)}~${f1(button.right)}(줄 오른쪽 끝 ${f1(row.rowRight)}), 날짜 줄과 세로 가운데 차이 ${f1(Math.abs(buttonMid - dateMid))}px, 초점은 단추에 남음. 「요청하지 못했습니다」 ${notice.lines}줄, 잘림 없음, 단추와 겹치지 않고 ${where}`);
  }
  // 같은 줄의 다른 상태(409 안내, 검증 중)도 가장 좁은 폭에서 날짜가 한 줄이다.
  for (const [state, text] of [["conflict", "검증 작업이 없습니다"], ["normal", "검증 중"]] as const) {
    await openSkills(page, NARROW.width, NARROW.height, state);
    await page.getByRole("button", { name: "다시 검증" }).click();
    await expect(page.getByTestId("skill-catalog-report").getByText(text).first()).toBeVisible({ timeout: 15_000 });
    const row = await reportRow(page);
    expect(row.dateLines, `360 ${state}: 날짜가 쪼개짐`).toBe(1);
    if (row.notice) expect(row.notice.clipped || !row.notice.inRow, `360 ${state}: 안내가 잘림`).toBe(false);
    lines.push(`360 ${state === "conflict" ? "409(검증 작업 없음)" : "검증 중"}: 「${row.dateText}」 ${row.dateLines}줄, 줄 높이 ${Math.round(row.rowHeight)}px${row.notice ? `, 안내 ${row.notice.lines}줄 잘림 없음` : ""}`);
  }
  return lines;
}

const PARTS: Array<[string, (page: Page, longName: string) => Promise<string[]>]> = [
  ["sourceRows", page => sourceRows(page)], ["overviewChecks", page => overviewChecks(page)], ["overviewChaining", page => overviewChaining(page)], ["skillScreens", skillScreens],
  ["emptyOnce", page => emptyOnce(page)], ["verifyFailed", page => verifyFailed(page)],
];

/** FIXES_PARTS=이름,이름 으로 일부만 돌릴 수 있다(개발용). 기본은 전부. */
export async function measureFixes(page: Page, longName: string): Promise<string[]> {
  const only = process.env.FIXES_PARTS?.split(",");
  const lines: string[] = [];
  for (const [name, run] of PARTS) if (!only || only.includes(name)) lines.push(...await run(page, longName));
  return lines;
}
