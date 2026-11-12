// 카드 #1197: 질문 장과 아래 입력창을 잇는 대상. 새 입력창을 만들지 않고 기존 카드 입력창의
// 「대상」 줄(고칠 점 남기기와 같은 줄)에 질문 대상을 더한다.
import { useSyncExternalStore } from "react";

export type CardQuestionTarget =
  | { kind: "ask"; questionId: string }
  | { kind: "append"; questionId: string; label: string };

type Entry = { target: CardQuestionTarget | null; focus: number };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Entry = { target: null, focus: 0 };

function emit() { for (const listener of listeners) listener(); }

/** 대상은 그 화면이 살아 있는 동안만 산다. 화면이 닫히거나 카드·장이 바뀌면 부르는 쪽이 지운다. */
export function setCardQuestionTarget(scope: string, target: CardQuestionTarget | null, focus = false) {
  const current = entries.get(scope) ?? EMPTY;
  entries.set(scope, { target, focus: focus ? current.focus + 1 : current.focus });
  emit();
}

export function clearCardQuestionTarget(scope: string) {
  if (!entries.delete(scope)) return;
  emit();
}

/** 카드 상세의 그 카드와 PAS 펼친 장의 그 장은 서로 다른 화면이다. */
export const cardDetailTargetScope = (cardId: string) => `card:${cardId}`;
export const pasSheetTargetScope = (entryKey: string) => `pas:${entryKey}`;

export function useCardQuestionTarget(scope: string): Entry {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => entries.get(scope) ?? EMPTY,
    () => EMPTY,
  );
}
