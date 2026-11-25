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

export interface StickyGeometry { headTop: number; cornerTop: number; cornerLeft: number; nameLeft: number; scrollable: boolean }

/** 한눈에 표를 끝까지 스크롤한 채 열 머리, 모서리 칸, 줄 이름 칸이 틀 가장자리에 붙어 있는가(틀 가장자리와의 차이). */
export async function stickyGeometry(frame: Locator, scroll: { left: number; top: number | "end" }): Promise<StickyGeometry> {
  return frame.evaluate((element, target) => {
    element.scrollLeft = target.left;
    element.scrollTop = target.top === "end" ? element.scrollHeight : target.top;
    const box = element.getBoundingClientRect();
    const head = element.querySelector<HTMLElement>("thead th.guides-matrix-profile")!.getBoundingClientRect();
    const corner = element.querySelector<HTMLElement>("thead th.guides-matrix-corner")!.getBoundingClientRect();
    const name = element.querySelector<HTMLElement>("tbody th")!.getBoundingClientRect();
    return { headTop: head.top - box.top - element.clientTop, cornerTop: corner.top - box.top - element.clientTop, cornerLeft: corner.left - box.left - element.clientLeft, nameLeft: name.left - box.left - element.clientLeft, scrollable: element.scrollHeight > element.clientHeight };
  }, scroll);
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
