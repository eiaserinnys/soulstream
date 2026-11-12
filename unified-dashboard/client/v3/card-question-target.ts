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

export function setCardQuestionTarget(cardId: string, target: CardQuestionTarget | null, focus = false) {
  const current = entries.get(cardId) ?? EMPTY;
  entries.set(cardId, { target, focus: focus ? current.focus + 1 : current.focus });
  emit();
}

export function useCardQuestionTarget(cardId: string): Entry {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => entries.get(cardId) ?? EMPTY,
    () => EMPTY,
  );
}
