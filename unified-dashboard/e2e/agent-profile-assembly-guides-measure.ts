// 지침과 스킬 보기 시각 검수의 측정 도구. 화면에서 값을 재 돌려주고, 판정(expect)은 부르는 쪽이 한다.
import type { Locator, Page } from "@playwright/test";

export interface TitleVisibility { text: string; natural: number; visible: number; ratio: number; lines: number }

/** 소스 줄 제목마다 「보이는 폭 / 전체 폭」을 잰다. 전체 폭은 한 줄로 펼쳤을 때의 폭, 보이는 폭은 줄 폭 곱하기 보이는 줄 수다. */
export async function titleVisibility(scope: Locator): Promise<TitleVisibility[]> {
  return scope.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('[data-assembly-title="true"]')).map((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    Object.assign(clone.style, { position: "absolute", visibility: "hidden", whiteSpace: "nowrap", display: "inline-block", overflow: "visible", webkitLineClamp: "none", width: "auto", maxWidth: "none" });
    element.parentElement!.append(clone);
    const natural = clone.getBoundingClientRect().width;
    clone.remove();
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
    const lines = Math.max(1, Math.round(element.clientHeight / lineHeight));
    const visible = Math.min(natural, element.clientWidth * lines);
    return { text: (element.textContent ?? "").trim(), natural, visible, ratio: natural === 0 ? 1 : visible / natural, lines };
  }));
}

export interface TreeGeometry { rowToTree: number; treeToNext: number | null; leftInside: boolean; rightInside: boolean; titleStartDelta: number }

/** 펼친 소스 하나에서 줄과 트리의 관계: 줄에서 트리까지, 트리에서 다음 줄까지 간격, 트리 좌우 끝이 줄 상자 안인가, 문서명이 제목 시작선에서 시작하는가. */
export async function treeGeometry(page: Page, itemIndex: number): Promise<TreeGeometry> {
  return page.evaluate((index) => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="agent-context-source"]'));
    const item = items[index]!;
    const row = item.querySelector<HTMLElement>("button[data-status]")!;
    const tree = item.querySelector<HTMLElement>('[data-testid="agent-context-documents"]')!.parentElement!;
    const next = items[index + 1]?.querySelector<HTMLElement>("button[data-status]") ?? null;
    const rowBox = row.getBoundingClientRect();
    const treeBox = tree.getBoundingClientRect();
    const textLeft = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects()[0]!.left; };
    const rowTitle = row.querySelector<HTMLElement>('[data-assembly-title="true"]')!;
    const firstDoc = tree.querySelector<HTMLElement>("li span.truncate")!;
    return {
      rowToTree: treeBox.top - rowBox.bottom,
      treeToNext: next ? next.getBoundingClientRect().top - treeBox.bottom : null,
      leftInside: treeBox.left >= rowBox.left - 0.5,
      rightInside: treeBox.right <= rowBox.right + 0.5,
      titleStartDelta: Math.abs(textLeft(firstDoc) - textLeft(rowTitle)),
    };
  }, itemIndex);
}

export interface StickyGeometry { headTop: number; cornerTop: number; cornerLeft: number; nameLeft: number }

/** 한눈에 표의 지금 스크롤 그대로, 열 머리, 모서리 칸, 줄 이름 칸이 틀 가장자리에 붙어 있는가(틀 안쪽 가장자리와의 차이). 스크롤은 바꾸지 않는다. */
export async function stickyGeometry(frame: Locator): Promise<StickyGeometry> {
  return frame.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const head = element.querySelector<HTMLElement>("thead th.guides-matrix-profile")!.getBoundingClientRect();
    const corner = element.querySelector<HTMLElement>("thead th.guides-matrix-corner")!.getBoundingClientRect();
    const name = element.querySelector<HTMLElement>("tbody th")!.getBoundingClientRect();
    return { headTop: head.top - box.top - element.clientTop, cornerTop: corner.top - box.top - element.clientTop, cornerLeft: corner.left - box.left - element.clientLeft, nameLeft: name.left - box.left - element.clientLeft };
  });
}

const OVERVIEW = '[data-testid="agent-context-overview"]';
const DETAIL = "section.config-detail";

export interface OverviewView {
  detailScroll: number; frameScroll: number; frameLeft: number;
  /** 상세 칸(설정 머리 아래, 하단 막대 위)의 보이는 위끝과 아래끝. */
  viewTop: number; viewBottom: number;
  frameTop: number; frameInnerBottom: number;
  headTop: number; headBottom: number; cornerTop: number; cornerBottom: number;
  lastTop: number; lastBottom: number;
  /** 휠을 굴리는 자리 밑에 표 틀이 있는가. */
  pointerOverFrame: boolean;
}

/** 한눈에 표와 상세 칸의 지금 자리: 열 머리, 모서리 칸, 마지막 줄을 상세 칸의 보이는 사각형과 견줄 값. */
export async function overviewView(page: Page, point: { x: number; y: number }): Promise<OverviewView> {
  return page.evaluate(({ x, y, overview, detailSelector }) => {
    const detail = document.querySelector<HTMLElement>(detailSelector)!;
    const frame = document.querySelector<HTMLElement>(overview)!;
    const rect = (element: Element) => element.getBoundingClientRect();
    const d = rect(detail);
    const f = rect(frame);
    const head = rect(frame.querySelector("thead th.guides-matrix-profile")!);
    const corner = rect(frame.querySelector("thead th.guides-matrix-corner")!);
    const last = rect(frame.querySelector("tbody tr:last-child")!);
    const hit = document.elementFromPoint(x, y);
    const viewTop = d.top + detail.clientTop;
    return {
      detailScroll: detail.scrollTop, frameScroll: frame.scrollTop, frameLeft: frame.scrollLeft,
      viewTop, viewBottom: viewTop + detail.clientHeight,
      frameTop: f.top, frameInnerBottom: f.top + frame.clientTop + frame.clientHeight,
      headTop: head.top, headBottom: head.bottom, cornerTop: corner.top, cornerBottom: corner.bottom,
      lastTop: last.top, lastBottom: last.bottom,
      pointerOverFrame: hit !== null && frame.contains(hit),
    };
  }, { ...point, overview: OVERVIEW, detailSelector: DETAIL });
}

/** 표 틀이 상세 칸 안에서 보이는 부분의 가운데. 휠을 굴릴 자리다. */
export async function overviewCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(({ overview, detailSelector }) => {
    const d = document.querySelector<HTMLElement>(detailSelector)!.getBoundingClientRect();
    const f = document.querySelector<HTMLElement>(overview)!.getBoundingClientRect();
    const top = Math.max(d.top, f.top);
    const bottom = Math.min(d.bottom, f.bottom);
    return { x: Math.round((f.left + f.right) / 2), y: Math.round((top + bottom) / 2) };
  }, { overview: OVERVIEW, detailSelector: DETAIL });
}

/** 휠 한 번 뒤 상세 칸과 표 틀의 스크롤이 멈출 때까지 기다린다(부드러운 스크롤과 휠 묶음이 끝나게 200ms 이상). */
export async function settleScroll(page: Page) {
  await page.evaluate(({ overview, detailSelector }) => new Promise<void>((resolve) => {
    const detail = document.querySelector<HTMLElement>(detailSelector)!;
    const frame = document.querySelector<HTMLElement>(overview)!;
    const start = performance.now();
    let last = "";
    let same = 0;
    const tick = () => {
      const now = `${detail.scrollTop},${frame.scrollTop},${frame.scrollLeft}`;
      same = now === last ? same + 1 : 0;
      last = now;
      const elapsed = performance.now() - start;
      if ((same >= 6 && elapsed >= 200) || elapsed > 2000) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { overview: OVERVIEW, detailSelector: DETAIL });
}

/** 한 자리에서 세로 휠을 count번 굴리며 매번 자리를 잰다. 첫 값은 굴리기 전이다. scrollTop은 넣지 않는다. */
export async function wheelOverview(page: Page, point: { x: number; y: number }, count = 12, delta = 250): Promise<OverviewView[]> {
  await page.mouse.move(point.x, point.y);
  const views = [await overviewView(page, point)];
  for (let index = 0; index < count; index += 1) {
    await page.mouse.wheel(0, delta);
    await settleScroll(page);
    views.push(await overviewView(page, point));
  }
  return views;
}

export const headVisible = (view: OverviewView) => view.headTop >= view.viewTop - 1 && view.headBottom <= view.viewBottom + 1
  && view.cornerTop >= view.viewTop - 1 && view.cornerBottom <= view.viewBottom + 1;
export const lastVisible = (view: OverviewView) => view.lastBottom <= Math.min(view.viewBottom, view.frameInnerBottom) + 1
  && view.lastTop >= Math.max(view.viewTop, view.headBottom) - 1;

export interface WheelSummary {
  /** 상세 칸과 표 틀이 움직인 세로 거리의 합. */
  moved: number; detailMoved: number; frameMoved: number;
  /** 열 머리나 모서리 칸이 보이는 자리 밖으로 나간 단계(0은 굴리기 전). */
  headHidden: number[];
  /** 표 위에서 굴렸는데 아무것도 움직이지 않았고 마지막 줄이 아직 가려진 단계. */
  stuck: number[];
  minHeadGap: number; end: OverviewView; lastShown: boolean;
}

export function summarizeWheel(views: OverviewView[]): WheelSummary {
  const first = views[0]!;
  const end = views[views.length - 1]!;
  const stuck: number[] = [];
  for (let index = 1; index < views.length; index += 1) {
    const before = views[index - 1]!;
    const after = views[index]!;
    const still = Math.abs(after.detailScroll - before.detailScroll) < 0.5 && Math.abs(after.frameScroll - before.frameScroll) < 0.5;
    if (before.pointerOverFrame && still && !lastVisible(after)) stuck.push(index);
  }
  const detailMoved = end.detailScroll - first.detailScroll;
  const frameMoved = end.frameScroll - first.frameScroll;
  return {
    moved: detailMoved + frameMoved, detailMoved, frameMoved,
    headHidden: views.flatMap((view, index) => headVisible(view) ? [] : [index]),
    stuck, minHeadGap: Math.min(...views.map(view => view.headTop - view.viewTop)), end, lastShown: lastVisible(end),
  };
}

export interface ReportRowGeometry {
  dateText: string; dateLines: number; rowHeight: number; rowRight: number;
  date: { top: number; bottom: number };
  button: { left: number; right: number; top: number; bottom: number } | null;
  /** 안내 글(role=alert 또는 status)의 글자 범위. 없으면 null. */
  notice: { left: number; right: number; top: number; bottom: number; lines: number; clipped: boolean; inRow: boolean } | null;
  buttonFocused: boolean;
}

/** 「스킬과 카탈로그」 머리 줄(보고 시각, 안내, 다시 검증): 날짜 글의 줄 수, 단추와 안내의 자리. */
export async function reportRow(page: Page): Promise<ReportRowGeometry> {
  return page.getByTestId("skill-catalog-report").evaluate((row) => {
    const textRects = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return Array.from(range.getClientRects()).filter(r => r.width > 0); };
    const box = (rects: DOMRect[]) => ({ left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)), top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) });
    const rowRect = row.getBoundingClientRect();
    const date = row.querySelector<HTMLElement>(":scope > p:first-child")!;
    const dateRects = textRects(date);
    const button = row.querySelector<HTMLElement>("button");
    const notice = row.querySelector<HTMLElement>(':scope > [role="alert"], :scope > [role="status"]');
    const noticeRects = notice ? textRects(notice) : [];
    const noticeBox = noticeRects.length > 0 ? box(noticeRects) : null;
    return {
      dateText: (date.textContent ?? "").trim(),
      dateLines: new Set(dateRects.map(r => Math.round(r.top))).size,
      rowHeight: rowRect.height, rowRight: rowRect.right,
      date: { top: box(dateRects).top, bottom: box(dateRects).bottom },
      button: button ? (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(button.getBoundingClientRect()) : null,
      notice: notice && noticeBox ? {
        ...noticeBox, lines: new Set(noticeRects.map(r => Math.round(r.top))).size, clipped: notice.scrollWidth > notice.clientWidth + 0.5,
        inRow: noticeBox.left >= rowRect.left - 0.5 && noticeBox.right <= rowRect.right + 0.5 && noticeBox.top >= rowRect.top - 0.5 && noticeBox.bottom <= rowRect.bottom + 0.5,
      } : null,
      buttonFocused: button !== null && document.activeElement === button,
    };
  });
}

/** 두 캡처(PNG)의 평균 채널 차이(0~255). 모서리 칸 위로 뒤 칸이 비치는지 가린다. */
export async function meanDifference(page: Page, first: Buffer, second: Buffer): Promise<number> {
  return page.evaluate(async ([a, b]) => {
    const draw = async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [one, two] = [await draw(a!), await draw(b!)];
    let sum = 0;
    for (let index = 0; index < one.length; index += 1) sum += Math.abs(one[index]! - two[index]!);
    return sum / one.length;
  }, [first.toString("base64"), second.toString("base64")] as const);
}

export interface PressableAlignment { titleLeft: number; nameLefts: number[]; badgeLefts: number[]; pitches: number[]; hoverInside: boolean }

/** 눌리는 줄(묶음 안의 button)의 시작선: 묶음 제목 글 시작, 이름 글 시작, 배지 칸 시작, 줄 간격, 눌림 바탕이 상자 안인가. */
export async function pressableAlignment(group: Locator): Promise<PressableAlignment> {
  return group.evaluate((box) => {
    const textLeft = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects()[0]!.left; };
    const boxRect = box.getBoundingClientRect();
    const buttons = Array.from(box.querySelectorAll<HTMLElement>("button"));
    const title = box.querySelector<HTMLElement>(":scope > p")!;
    const nameOf = (button: HTMLElement) => button.querySelector<HTMLElement>("span.truncate") ?? button;
    return {
      titleLeft: textLeft(title),
      nameLefts: buttons.map(button => textLeft(nameOf(button))),
      badgeLefts: buttons.flatMap(button => { const badge = button.querySelector<HTMLElement>('[data-slot="badge"]'); return badge ? [badge.getBoundingClientRect().left] : []; }),
      pitches: buttons.slice(1).map((button, index) => button.getBoundingClientRect().top - buttons[index]!.getBoundingClientRect().top),
      hoverInside: buttons.every(button => { const r = button.getBoundingClientRect(); return r.left >= boxRect.left + 1 && r.right <= boxRect.right - 1; }),
    };
  });
}

/** 글 줄(li)의 줄 간격: 같은 묶음 안 이웃 묶음과 눌리는 줄의 높이를 견준다. */
export async function listPitch(group: Locator, selector: string): Promise<number[]> {
  return group.evaluate((box, query) => {
    const items = Array.from(box.querySelectorAll<HTMLElement>(query));
    return items.slice(1).map((item, index) => item.getBoundingClientRect().top - items[index]!.getBoundingClientRect().top);
  }, selector);
}
