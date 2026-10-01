import type { CardStatus } from '../api/cardTypes';

export const BOARD_COLUMNS = [
  ['todo', '드래프트'], ['queued', '대기'], ['running', '실행 중'],
  ['blocked', '막힘'], ['review', '검수 대기'], ['done', '완료'],
] as const;
export const BOARD_LONG_PRESS_MS = 350;
export const BOARD_DRAG_SLOP = 8; // Existing queue gesture threshold.
export type BoardFrame = { x: number; y: number; width: number; height: number };
export type BoardPosition = { x: number; lanes: Partial<Record<CardStatus, number>> };

export function boardLaneGeometry(viewport: number, paperWidth: number, inset: number, phone: boolean) {
  const laneWidth = paperWidth + inset * 2;
  const gap = phone ? inset : inset * 3;
  return { laneWidth, gap, stride: laneWidth + gap, inset: phone ? Math.max(inset, (viewport - laneWidth) / 2) : 0 };
}

export function boardDropStatus(x: number, y: number, frame: BoardFrame, geometry: ReturnType<typeof boardLaneGeometry>,
  scrollX: number, from: CardStatus): CardStatus | null {
  if (x < frame.x || x > frame.x + frame.width || y < frame.y || y > frame.y + frame.height) return null;
  const local = x - frame.x + scrollX - geometry.inset;
  const index = Math.floor(local / geometry.stride);
  if (index < 0 || index >= BOARD_COLUMNS.length || local % geometry.stride > geometry.laneWidth) return null;
  const next = BOARD_COLUMNS[index][0];
  return next === from ? null : next;
}
