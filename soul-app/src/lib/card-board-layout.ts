import type { CardStatus } from '../api/cardTypes';

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

export function boardLaneGeometry(viewport: number, paperWidth: number, inset: number, phone: boolean) {
  const laneWidth = paperWidth + inset * 2;
  const gap = phone ? inset : inset * 3;
  return { laneWidth, gap, stride: laneWidth + gap, inset: phone ? inset : 0 };
}

export function boardLaneOffset(index: number, viewport: number, geometry: ReturnType<typeof boardLaneGeometry>, count: number) {
  const max = Math.max(0, geometry.stride * (count - 1) + geometry.laneWidth + geometry.inset * 2 - viewport);
  return Math.max(0, Math.min(max, index * geometry.stride));
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
  const index = Math.floor(local / geometry.stride);
  if (index < 0 || index >= columns.length || local % geometry.stride > geometry.laneWidth) return null;
  const next = columns[index][0];
  return next === from ? null : next;
}
