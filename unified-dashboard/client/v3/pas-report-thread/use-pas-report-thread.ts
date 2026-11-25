import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cardMutationKey, cardQuestionChoiceAnswer, cardQuestionTextAnswer } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CARD_COMPLETION_UNDO_MS } from "../../../../packages/wire-schema/src/persistent_report";
import type { CardCompletionTarget, usePersistentCardCompletion } from "../usePersistentCardCompletion";
import { useCardMembership } from "../use-card-membership";
import {
  itemInstructionBody, nextSnoozeReturn,
  type ProcessedAgenda, type RailGroups, type SendMode, type SnoozeOption, type SnoozeUndo, type ThreadLoad,
} from "@seosoyoung/soul-ui/lib/pas-report-thread-core";
import { entryAgenda, groupAgendas, openQuestionOf, type Agenda, type ReportEntry } from "./pas-report-thread-model";

export interface ItemTarget { itemId: number; trigger: HTMLElement | null }

export interface PasReportThreadInput {
  entries: readonly ReportEntry[];
  completion: ReturnType<typeof usePersistentCardCompletion>;
  dismissReport(key: string): Promise<void>;
  /** 말풍선에서 보고 있던 장의 카드. 이 안건에서 창을 연다. */
  startCardId: string | null;
  /** 견본처럼 카드 목록을 따로 줄 때. 없으면 대시보드의 카드 목록(useCardMembership)을 읽는다. */
  cardSource?: readonly CardRow[];
}

function useNow(next: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (next === null) return;
    // 타이머 한도(약 24일)를 넘는 시각은 한도까지 기다렸다 다시 센다.
    const wait = Math.min(Math.max(next - Date.now(), 0) + 50, 2 ** 31 - 1);
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

export function usePasReportThread({ entries, completion, dismissReport, startCardId, cardSource }: PasReportThreadInput) {
  const byId = useCardStore(state => state.byId);
  const live = useCardMembership(undefined, [], cardSource === undefined);
  const cards = cardSource ?? live.cards;
  const { loading: cardsLoading, error: cardsError, retry: retryCards } = live;
  const [processed, setProcessed] = useState<ProcessedAgenda<Agenda>[]>([]);
  // 처분한 안건은 판이 따라잡기 전에도 결재 대기에 남지 않는다. 판의 장이 바뀌면(다시 열림) 돌아온다.
  const boardAgendas = useMemo(() => {
    const settled = new Map(processed.map(item => [item.agenda.cardId, item.agenda.updatedAt]));
    return entries.flatMap(entry => {
      const agenda = entry.card_id ? entryAgenda(entry, byId[entry.card_id]) : null;
      return agenda && settled.get(agenda.cardId) !== agenda.updatedAt ? [agenda] : [];
    });
  }, [entries, byId, processed]);
  const [deadline, setDeadline] = useState<number | null>(null);
  const now = useNow(deadline);
  useEffect(() => { setDeadline(nextSnoozeReturn(boardAgendas, now)); }, [boardAgendas, now]);
  const groups: RailGroups<Agenda> = useMemo(() => groupAgendas(boardAgendas, cards, now), [boardAgendas, cards, now]);

  const [activeId, setActiveId] = useState<string | null>(startCardId);
  const [snoozeUndo, setSnoozeUndo] = useState<SnoozeUndo | null>(null);
  const [target, setTarget] = useState<ItemTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const liveIds = new Set([...groups.pending, ...groups.snoozed, ...groups.running].map(agenda => agenda.cardId));
  const processedAgendas = processed.filter(item => !liveIds.has(item.agenda.cardId));
  const active: Agenda | null = [...groups.pending, ...groups.snoozed, ...groups.running, ...processedAgendas.map(item => item.agenda)]
    .find(agenda => agenda.cardId === activeId) ?? groups.pending[0] ?? groups.running[0] ?? null;
  const activeCardId = active?.cardId ?? null;
  const snoozed = active !== null && active.snoozedUntil !== null && active.snoozedUntil > now;

  // 안건을 바꾸면 항목 지시 대상은 버린다.
  useEffect(() => { setTarget(null); setActionError(null); }, [activeCardId]);

  const detail: CardDetail | undefined = useCardStore(state => activeCardId ? state.details[activeCardId] : undefined);
  const [load, setLoad] = useState<{ id: string | null; state: ThreadLoad }>({ id: null, state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!activeCardId) return;
    let current = true;
    // 견본처럼 목록을 따로 주는 호출은 이미 들어 있는 상세로 보이고 서버에 묻지 않는다.
    if (cardSource !== undefined && useCardStore.getState().details[activeCardId]) { setLoad({ id: activeCardId, state: "ready" }); return; }
    setLoad({ id: activeCardId, state: "loading" });
    useCardStore.getState().loadCard(activeCardId)
      .then(() => { if (current) setLoad({ id: activeCardId, state: "ready" }); })
      .catch(() => { if (current) setLoad({ id: activeCardId, state: "error" }); });
    return () => { current = false; };
  }, [activeCardId, attempt, cardSource]);
  const loadState: ThreadLoad = detail ? "ready" : load.id === activeCardId ? load.state : "loading";
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const question: CardQuestion | null = openQuestionOf(detail, active?.entry ?? null);

  const nextAfter = (cardId: string) => {
    const list = groups.pending;
    const index = list.findIndex(agenda => agenda.cardId === cardId);
    return list[index + 1] ?? list[index - 1] ?? null;
  };
  const settle = (agenda: Agenda, label: string) => {
    setProcessed(items => [...items.filter(item => item.agenda.cardId !== agenda.cardId), { agenda, label }]);
    setActiveId(nextAfter(agenda.cardId)?.cardId ?? agenda.cardId);
  };
  const run = async (action: () => Promise<boolean | void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      return (await action()) !== false;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const complete = (agenda: Agenda, status: CardCompletionTarget) => run(async () => {
    const entry = agenda.entry;
    if (!entry?.card_id) return false;
    const next = nextAfter(agenda.cardId);
    // 실패 문구는 모달 뒤 말풍선 알림이 아니라 창 안 결재 상자에 보인다.
    const done = await completion.complete(entry as ReportEntry & { card_id: string }, [...entries], status, setActionError);
    if (!done) return false;
    setSnoozeUndo(null);
    setProcessed(items => [...items.filter(item => item.agenda.cardId !== agenda.cardId), { agenda, label: status === "on_hold" ? "보류" : "완료" }]);
    setActiveId(next?.cardId ?? agenda.cardId);
  });
  const acknowledge = (agenda: Agenda) => run(async () => {
    if (!agenda.entry) return false;
    await dismissReport(agenda.entry.key);
    settle(agenda, "확인함");
  });
  const choose = (agenda: Agenda, option: string) => run(async () => {
    if (!question) return false;
    await useCardStore.getState().mutate(agenda.cardId, `/questions/${encodeURIComponent(question.id)}/answer`, cardQuestionChoiceAnswer(option));
    settle(agenda, option === "했어" ? "했어" : "답함");
  });
  const send = (agenda: Agenda, text: string, mode: SendMode) => run(async () => {
    const body = text.trim();
    if (!body) return false;
    const store = useCardStore.getState();
    if (mode === "answer") {
      if (!question) return false;
      await store.mutate(agenda.cardId, `/questions/${encodeURIComponent(question.id)}/answer`, cardQuestionTextAnswer(body));
      settle(agenda, "답함");
      return true;
    }
    // 열린 질문이 있으면 질문을 닫지 않도록 글에 questionId를 붙인다. 서버는 질문과 항목을 함께 받지 않는다.
    if (question) {
      await store.addComment(agenda.cardId, target ? itemInstructionBody(target.itemId, body) : body, cardMutationKey(), undefined, question.id);
    } else {
      await store.addComment(agenda.cardId, body, cardMutationKey(), target?.itemId);
    }
    setTarget(null);
  });
  const patchSnooze = async (cardId: string, until: string | null) => {
    const store = useCardStore.getState();
    const latest = await store.loadCard(cardId);
    await store.mutate(cardId, "", { snoozedUntil: until, expectedVersion: latest.card.version }, "PATCH");
  };
  const snooze = (agenda: Agenda, option: SnoozeOption) => run(async () => {
    const next = nextAfter(agenda.cardId);
    await patchSnooze(agenda.cardId, new Date(option.at).toISOString());
    setSnoozeUndo({ cardId: agenda.cardId, number: agenda.number, expiresAt: Date.now() + CARD_COMPLETION_UNDO_MS });
    setActiveId(next?.cardId ?? agenda.cardId);
  });
  const unsnooze = (agenda: Agenda) => run(async () => {
    await patchSnooze(agenda.cardId, null);
    setSnoozeUndo(current => current?.cardId === agenda.cardId ? null : current);
    setActiveId(agenda.cardId);
  });
  const undoSnooze = async () => {
    if (!snoozeUndo) return;
    const id = snoozeUndo.cardId;
    const done = await run(async () => { await patchSnooze(id, null); });
    if (done) { setSnoozeUndo(null); setActiveId(id); }
  };
  useEffect(() => {
    if (!snoozeUndo) return;
    const timer = setTimeout(() => setSnoozeUndo(null), Math.max(0, snoozeUndo.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [snoozeUndo]);
  const undoCompletion = async () => {
    const cardId = completion.recent?.cardId;
    setActionError(null);
    // 서버가 되돌림을 받아들인 것을 확인한 뒤에만 처리됨에서 지우고 그 안건으로 돌린다.
    const restored = await completion.undo(setActionError);
    if (!restored || !cardId) return;
    setProcessed(items => items.filter(item => item.agenda.cardId !== cardId));
    setActiveId(cardId);
  };

  // 가장 최근에 만든 되돌리기 하나만 보인다. 완료는 기존 훅의 5초, 미루기는 같은 시간을 쓴다.
  const completionUndo = completion.recent
    ? { kind: "completion" as const, cardId: completion.recent.cardId, label: completion.recent.label, expiresAt: completion.recent.expiresAt }
    : null;
  const snoozeRow = snoozeUndo
    ? { kind: "snooze" as const, cardId: snoozeUndo.cardId, label: snoozeUndo.number === null ? "미뤄 둠" : `#${snoozeUndo.number} 미뤄 둠`, expiresAt: snoozeUndo.expiresAt }
    : null;
  const undo = completionUndo && snoozeRow ? (completionUndo.expiresAt >= snoozeRow.expiresAt ? completionUndo : snoozeRow) : completionUndo ?? snoozeRow;

  return {
    groups, now, processed: processedAgendas, active, activeCardId, snoozed, detail, loadState, retry, question,
    cardsLoading, cardsError, retryCards,
    target, setTarget, busy, actionError,
    select: (cardId: string) => setActiveId(cardId),
    complete, acknowledge, choose, send, snooze, unsnooze,
    undo: undo ? { ...undo, run: undo.kind === "completion" ? undoCompletion : undoSnooze } : null,
    completionBusy: completion.busy,
  };
}

export type PasReportThreadController = ReturnType<typeof usePasReportThread>;
