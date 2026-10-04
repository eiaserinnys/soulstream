import type { CardStatus } from '../api/cardTypes';
import { completedGridLayout } from '../../../packages/soul-ui/src/cards/completed-cards';

export const BOARD_COLUMNS = [
  ['todo', '드래프트'], ['queued', '대기'], ['running', '실행 중'],
  ['blocked', '막힘'], ['review', '검수 대기'], ['done', '완료'],
] as const;
export const BOARD_LONG_PRESS_MS = 350;
export const BOARD_DRAG_SLOP = 8; // Existing queue gesture threshold.
export type BoardFrame = { x: number; y: number; width: number; height: number };
export type BoardPosition = { x: number; lane?: CardStatus; lanes: Partial<Record<CardStatus, number>> };
export function boardVisibleColumns(includeCompleted: boolean) {
  return BOARD_COLUMNS.filter(([status]) => includeCompleted || status !== 'done');
}

export function boardLaneGeometry(viewport: number, paperWidth: number, inset: number, phone: boolean,
  columns?:readonly (readonly [CardStatus,string])[],gridGap=inset) {
  const laneWidth = paperWidth + inset * 2;
  const gap = phone ? inset : inset * 3;
  const outerInset=phone?inset:0;
  const completed=completedGridLayout(viewport-outerInset*2,paperWidth,gridGap,inset);
  let start=0;
  const lanes=(columns??BOARD_COLUMNS).map(([status])=>{
    const width=columns&&status==='done'?completed.width:laneWidth;
    const lane={status,start,width};start+=width+gap;return lane;
  });
  const maxScroll=Math.max(0,start-gap+outerInset*2-viewport);
  return { laneWidth, gap, stride: laneWidth + gap, inset: outerInset,lanes,maxScroll,completedColumns:completed.columns };
}

export function boardLaneOffset(index: number, viewport: number, geometry: ReturnType<typeof boardLaneGeometry>, count: number) {
  const last=geometry.lanes[count-1];
  const max = Math.max(0,last.start+last.width+geometry.inset*2-viewport);
  return Math.max(0, Math.min(max, geometry.lanes[index].start));
}

export function boardSnapOffsets(viewport: number, geometry: ReturnType<typeof boardLaneGeometry>, count: number) {
  return [...new Set(Array.from({ length: count }, (_, index) => boardLaneOffset(index, viewport, geometry, count)))];
}

export function boardNearestLane(offset: number, offsets: readonly number[]) {
  return offsets.reduce((nearest, value, index) => Math.abs(value - offset) <= Math.abs(offsets[nearest] - offset) ? index : nearest, 0);
}

export function boardDropStatus(x: number, y: number, frame: BoardFrame, geometry: ReturnType<typeof boardLaneGeometry>,
  scrollX: number, from: CardStatus, columns: readonly (readonly [CardStatus, string])[] = BOARD_COLUMNS): CardStatus | null {
  if (x < frame.x || x > frame.x + frame.width || y < frame.y || y > frame.y + frame.height) return null;
  const local = x - frame.x + scrollX - geometry.inset;
  const index = geometry.lanes.slice(0,columns.length).findIndex(lane=>local>=lane.start&&local<=lane.start+lane.width);
  if (index < 0) return null;
  const next = columns[index][0];
  return next === from && next !== 'running' ? null : next;
}
