import type { ApiClient } from '../api/client';
import type { CardDetail, CardDto, CardStatus } from '../api/cardTypes';
import { captureAuthScope } from './auth-scope';
import { useCardStore } from '../store/cardStore';

// Card IDs identify writes across separately constructed clients and hook instances.
const writes = new Set<string>();
const listeners = new Set<() => void>();
export const cardWritePending = (id: string) => writes.has(id);
export const subscribeCardWrites = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach((listener) => listener());

/** Mirrors the existing human status API guards; blocked requires its dedicated question API. */
export function cardTransitionProblem(detail: CardDetail, next: CardStatus, reason?: string): string | null {
  if (detail.card.archived) return '보관된 카드는 이동할 수 없습니다.';
  if (detail.card.status === next) return '이미 이 단계입니다.';
  if (next === 'blocked') return '막힘은 질문·실행 상태에서 지정합니다.';
  if (next === 'review' && !detail.reports.length) return '검수 대기에는 보고가 필요합니다.';
  if (detail.card.status === 'review' && next === 'running' && !reason?.trim()) return '재실행 사유를 입력해 주세요.';
  return null;
}

export async function performCardTransition(api: ApiClient, source: CardDto, next: CardStatus, operationId: string,
  reason?: string, isActive: () => boolean = () => true) {
  if (writes.has(source.id)) throw new Error('이 카드를 저장 중입니다.');
  writes.add(source.id); notify();
  const scope = captureAuthScope().generation;
  try {
    const detail = await api.getCard(source.id);
    if (!isActive() || captureAuthScope().generation !== scope) throw new Error('카드 이동이 취소되었습니다.');
    useCardStore.getState().putDetail(detail);
    if (detail.card.status !== source.status) throw new Error('카드 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.');
    const problem = cardTransitionProblem(detail, next, reason);
    if (problem) throw new Error(problem);
    const result = await api.setCardStatus(source.id, next, detail.card.version, operationId, reason?.trim() || undefined);
    if (!result.card) throw new Error('저장 결과에 카드가 없습니다. 최신 상태를 다시 확인해 주세요.');
    return result;
  } finally { writes.delete(source.id); notify(); }
}
