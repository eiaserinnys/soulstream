// 카드 #1871: PAS 결재형 보고 창의 컨트롤러. 안건 묶음, 고른 안건, 처리됨, 미루기와 되돌리기, 카드 상세 읽기를 한 곳에서 쥔다.
// 웹판 use-pas-report-thread.ts와 같은 뜻이고, 데이터 길만 앱 것(cardStore, ApiClient, usePersistentCardCompletion)이다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CardDetail, CardDto, CardMutationResult, CardQuestion } from '../../api/cardTypes';
import { CARD_COMPLETION_UNDO_MS, type PersistentReportEntry } from '../../../../packages/wire-schema/src/persistent_report';
import { useCardList } from '../../hooks/useCardList';
import { cardOperationId } from '../../hooks/useCardActions';
import { useCardComments } from '../../hooks/useCardComments';
import { useCardItems } from '../../hooks/useCardItems';
import {
  itemInstructionBody, nextSnoozeReturn,
  type ProcessedAgenda, type RailGroups, type SnoozeOption, type SnoozeUndo, type ThreadLoad,
} from '../../../../packages/soul-ui/src/lib/pas-report-thread-core';
import { entryAgenda, groupAgendas, openQuestionOf, type Agenda } from '../../lib/pas-report-thread-model';
import { refreshCard, useCardStore } from '../../store/cardStore';
import { usePlannerStore } from '../../store/plannerStore';
import type { CardCompletion } from '../persistent/usePersistentCardCompletion';

export interface PasReportWindowInput {
  api: ApiClient | null;
  entries: readonly PersistentReportEntry[];
  completion: CardCompletion;
  dismissReport(key: string): Promise<boolean>;
  /** 보고 판에서 보던 장의 카드. 이 안건에서 창을 연다. */
  startCardId: string | null;
  /** 견본이 처리됨 상태를 바로 보일 때만 준다. 운영 화면은 창을 연 뒤 처분한 안건만 쌓는다. */
  initialProcessed?: ProcessedAgenda<Agenda>[];
}

/** 다음 미루기 시각까지 기다렸다 지금을 다시 센다. 타이머 한도(약 24일)를 넘으면 한도까지 기다렸다 다시 센다. */
function useNow(next: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (next === null) return;
    const wait = Math.min(Math.max(next - Date.now(), 0) + 50, 2 ** 31 - 1);
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

export function usePasReportWindow({ api, entries, completion, dismissReport, startCardId, initialProcessed }: PasReportWindowInput) {
  const rows = useCardStore(state => state.rows);
  const list = useCardList(api);
  const cards: readonly CardDto[] = list.cards;
  const [processed, setProcessed] = useState<ProcessedAgenda<Agenda>[]>(initialProcessed ?? []);
  // 처분한 안건은 판이 따라잡기 전에도 결재 대기에 남지 않는다. 판의 장이 바뀌면(다시 열림) 돌아온다.
  const boardAgendas = useMemo(() => {
    const settled = new Map(processed.map(item => [item.agenda.cardId, item.agenda.updatedAt]));
    return entries.flatMap(entry => {
      const agenda = entry.card_id ? entryAgenda(entry, rows[entry.card_id]) : null;
      return agenda && settled.get(agenda.cardId) !== agenda.updatedAt ? [agenda] : [];
    });
  }, [entries, rows, processed]);
  const [deadline, setDeadline] = useState<number | null>(null);
  const now = useNow(deadline);
  useEffect(() => { setDeadline(nextSnoozeReturn(boardAgendas, now)); }, [boardAgendas, now]);
  const groups: RailGroups<Agenda> = useMemo(() => groupAgendas(boardAgendas, cards, now), [boardAgendas, cards, now]);

  const [activeId, setActiveId] = useState<string | null>(startCardId);
  const [snoozeUndo, setSnoozeUndo] = useState<SnoozeUndo | null>(null);
  const [targetItemId, setTargetItemId] = useState<number | null>(null);
  /** 항목 지시를 연 「고칠 점 남기기」 단추. 입력창을 닫으면 접근성 초점이 여기로 돌아간다. */
  const targetTrigger = useRef<unknown>(null);
  const setTargetItem = useCallback((itemId: number | null, trigger?: unknown) => {
    targetTrigger.current = itemId === null ? null : trigger ?? null;
    setTargetItemId(itemId);
  }, []);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const liveIds = new Set([...groups.pending, ...groups.snoozed, ...groups.running].map(agenda => agenda.cardId));
  const processedAgendas = processed.filter(item => !liveIds.has(item.agenda.cardId));
  const active: Agenda | null = [...groups.pending, ...groups.snoozed, ...groups.running, ...processedAgendas.map(item => item.agenda)]
    .find(agenda => agenda.cardId === activeId) ?? groups.pending[0] ?? groups.running[0] ?? null;
  const activeCardId = active?.cardId ?? null;
  const snoozed = active !== null && active.snoozedUntil !== null && active.snoozedUntil > now;

  // 안건을 바꾸면 항목 지시 대상과 지난 실패 안내는 버린다.
  useEffect(() => { setTargetItemId(null); setActionError(null); }, [activeCardId]);

  const detail: CardDetail | undefined = useCardStore(state => activeCardId ? state.details[activeCardId] : undefined);
  const [load, setLoad] = useState<{ id: string | null; state: ThreadLoad }>({ id: null, state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!activeCardId || !api) return;
    let current = true;
    setLoad({ id: activeCardId, state: 'loading' });
    refreshCard(api, activeCardId)
      .then(() => { if (current) setLoad({ id: activeCardId, state: 'ready' }); })
      .catch(() => { if (current) setLoad({ id: activeCardId, state: 'error' }); });
    return () => { current = false; };
  }, [activeCardId, attempt, api]);
  const loadState: ThreadLoad = detail ? 'ready' : load.id === activeCardId ? load.state : 'loading';
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const question: CardQuestion | null = openQuestionOf(detail, active?.entry ?? null);

  const nextAfter = (cardId: string) => {
    const pending = groups.pending;
    const index = pending.findIndex(agenda => agenda.cardId === cardId);
    return pending[index + 1] ?? pending[index - 1] ?? null;
  };
  const settle = (agenda: Agenda, label: string) => {
    setProcessed(items => [...items.filter(item => item.agenda.cardId !== agenda.cardId), { agenda, label }]);
    setActiveId(nextAfter(agenda.cardId)?.cardId ?? agenda.cardId);
  };
  /** 한 번에 하나만. 실패는 결재 상자 안에 알리고 안건과 단추는 그대로 둔다. */
  const run = async (action: () => Promise<boolean | void>, failure: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const ok = (await action()) !== false;
      if (!ok) setActionError(failure);
      return ok;
    } catch (error) {
      setActionError(error instanceof Error && error.message ? error.message : failure);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const apply = async (mutation: () => Promise<CardMutationResult>) => {
    const result = await mutation();
    if (result.card) useCardStore.getState().putMutationCard(result.card);
    usePlannerStore.getState().invalidate('folder');
    if (result.card && api) { try { await refreshCard(api, result.card.id); } catch { /* 카드 갱신 알림이 이어서 읽는다. */ } }
  };

  const complete = (agenda: Agenda, target: 'done' | 'on_hold') => run(async () => {
    const entry = agenda.entry;
    if (!entry) return false;
    const next = nextAfter(agenda.cardId);
    const done = await completion.complete(entry, [...entries], target);
    if (!done) return false;
    setSnoozeUndo(null);
    setProcessed(items => [...items.filter(item => item.agenda.cardId !== agenda.cardId), { agenda, label: target === 'on_hold' ? '보류' : '완료' }]);
    setActiveId(next?.cardId ?? agenda.cardId);
  }, target === 'on_hold' ? '카드를 보류하지 못했어.' : '카드를 완료하지 못했어.');
  const acknowledge = (agenda: Agenda) => run(async () => {
    if (!agenda.entry) return false;
    if (!(await dismissReport(agenda.entry.key))) return false;
    settle(agenda, '확인함');
  }, '보고를 내리지 못했어.');
  const choose = (agenda: Agenda, option: string) => run(async () => {
    if (!api || !question) return false;
    await apply(() => api.answerCardQuestion(agenda.cardId, question.id, { mode: 'choice', option, idempotencyKey: cardOperationId() }));
    settle(agenda, option === '했어' ? '했어' : '답함');
  }, '답을 보내지 못했어.');
  /** 입력창이 보낸 글 답(다르게 답하기)이 받아들여졌으면 안건을 처리됨으로 옮긴다. */
  const answeredByText = (agenda: Agenda) => settle(agenda, '답함');

  // 입력창 부품(CardCommentComposer)에 넘기는 보내기. 질문이 열려 있으면 서버가 질문과 항목을 함께 받지 않으므로
  // 질문 글타래로 붙이고, 항목 지시는 글 앞에 번호를 적는다. 질문을 닫는 보내기는 다르게 답하기뿐이다.
  const comments = useCardComments(api, activeCardId ?? '');
  const sendComment = useCallback((body: string, onAccepted?: () => void, target?: { itemId?: number; questionId?: string }) => {
    if (question && target?.questionId === undefined) {
      const text = target?.itemId !== undefined ? itemInstructionBody(target.itemId, body) : body;
      return comments.send(text, onAccepted, { questionId: question.id });
    }
    return comments.send(body, onAccepted, target);
  }, [comments, question]);
  const runMutation = useCallback((mutation: () => Promise<CardMutationResult>, onAccepted?: () => void) => {
    if (busyRef.current) return Promise.resolve(false);
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    onAccepted?.();
    return mutation().then(async result => {
      if (result.card) useCardStore.getState().putMutationCard(result.card);
      usePlannerStore.getState().invalidate('folder');
      if (result.card && api) { try { await refreshCard(api, result.card.id); } catch { /* 카드 갱신 알림이 이어서 읽는다. */ } }
      return true;
    }).catch(error => {
      setActionError(error instanceof Error && error.message ? error.message : '답을 보내지 못했어.');
      return false;
    }).finally(() => { busyRef.current = false; setBusy(false); });
  }, [api]);

  const patchSnooze = async (cardId: string, until: string | null) => {
    if (!api) throw new Error('서버에 연결되지 않았어.');
    const latest = await refreshCard(api, cardId);
    await apply(() => api.updateCard(cardId, { snoozedUntil: until }, latest.card.version, cardOperationId()));
  };
  const snooze = (agenda: Agenda, option: SnoozeOption) => run(async () => {
    const next = nextAfter(agenda.cardId);
    await patchSnooze(agenda.cardId, new Date(option.at).toISOString());
    setSnoozeUndo({ cardId: agenda.cardId, number: agenda.number, expiresAt: Date.now() + CARD_COMPLETION_UNDO_MS });
    setActiveId(next?.cardId ?? agenda.cardId);
  }, '답변을 미루지 못했어.');
  const unsnooze = (agenda: Agenda) => run(async () => {
    await patchSnooze(agenda.cardId, null);
    setSnoozeUndo(current => current?.cardId === agenda.cardId ? null : current);
    setActiveId(agenda.cardId);
  }, '미루기를 풀지 못했어.');
  const undoSnooze = async () => {
    if (!snoozeUndo) return;
    const id = snoozeUndo.cardId;
    const done = await run(async () => { await patchSnooze(id, null); }, '되돌리지 못했어.');
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
    const restored = await completion.undo();
    if (!restored) { setActionError('되돌리지 못했어.'); return; }
    if (!cardId) return;
    // 되돌리기 훅은 되돌리기 전에 읽은 완료 상태를 저장소에 넣어 둔다. 되돌린 카드를 다시 읽어야 안건이 결재 대기에 다시 선다.
    if (api) { try { await refreshCard(api, cardId); } catch { /* 카드 갱신 알림이 이어서 읽는다. */ } }
    setProcessed(items => items.filter(item => item.agenda.cardId !== cardId));
    setActiveId(cardId);
  };

  // 가장 최근에 만든 되돌리기 하나만 보인다. 완료는 기존 훅의 5초, 미루기는 같은 시간을 쓴다.
  const completionUndo = completion.recent
    ? { kind: 'completion' as const, cardId: completion.recent.cardId, label: completion.recent.label, expiresAt: completion.recent.expiresAt }
    : null;
  const snoozeRow = snoozeUndo
    ? { kind: 'snooze' as const, cardId: snoozeUndo.cardId, label: snoozeUndo.number === null ? '미뤄 둠' : `#${snoozeUndo.number} 미뤄 둠`, expiresAt: snoozeUndo.expiresAt }
    : null;
  const undo = completionUndo && snoozeRow ? (completionUndo.expiresAt >= snoozeRow.expiresAt ? completionUndo : snoozeRow) : completionUndo ?? snoozeRow;

  const itemActions = useCardItems(api, activeCardId ?? '');
  return {
    api, groups, now, processed: processedAgendas, active, activeCardId, snoozed, detail, loadState, retry, question,
    cardsLoading: list.loading, cardsError: list.error, retryCards: list.refresh,
    targetItemId, setTargetItem, targetTrigger, busy, actionError, setActionError,
    select: (cardId: string) => setActiveId(cardId),
    complete, acknowledge, choose, answeredByText, snooze, unsnooze, sendComment, runMutation,
    commentsPending: comments.pending, itemActions,
    undo: undo ? { ...undo, run: undo.kind === 'completion' ? undoCompletion : undoSnooze } : null,
    completionBusy: completion.busy,
  };
}

export type PasReportWindowController = ReturnType<typeof usePasReportWindow>;
