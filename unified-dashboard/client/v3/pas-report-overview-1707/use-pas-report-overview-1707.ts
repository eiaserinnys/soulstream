import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";

import {
  INITIAL_PAS_CHAT,
  OVERVIEW_SCENARIOS,
  PROMOTED_DOCUMENT_ID,
  isPendingCard,
  overviewCardRow,
  type OverviewAction,
  type OverviewChatTurn,
  type OverviewComment,
  type OverviewScenario,
} from "./pas-report-overview-1707-data";

export type OverviewTargetKind = "comment" | "item" | "answer" | "askBack" | "session";

export interface OverviewTarget {
  kind: OverviewTargetKind;
  itemId?: number;
}

export interface OverviewUndo {
  cardId: string;
  previousStatus: CardStatus;
  previousBlockedKind: "question" | null;
  previousActiveId: string;
  chatId: string | null;
  commentId: string | null;
  documentId: string | null;
}

export function overviewTargetLabel(target: OverviewTarget | null) {
  if (!target) return "전체 커멘트";
  if (target.kind === "item") return `대상: ${target.itemId}번 항목`;
  if (target.kind === "answer") return "다르게 답하기";
  if (target.kind === "askBack") return "되묻기";
  if (target.kind === "session") return "담당 세션 지시";
  return "전체 커멘트";
}

function readReportRoute() {
  try {
    if (window.location.hash.replace(/^#/, "") === "report") return true;
  } catch {
    /* 해시를 읽지 못하는 환경 */
  }
  try {
    if (window.parent !== window && window.parent.location.hash.replace(/^#/, "") === "report") return true;
  } catch {
    /* 교차 출처 부모 */
  }
  try {
    if (new URLSearchParams(window.location.search).get("view") === "report") return true;
  } catch {
    /* 쿼리를 읽지 못하는 환경 */
  }
  return false;
}

function cloneScenarios(): OverviewScenario[] {
  return OVERVIEW_SCENARIOS.map(scenario => ({
    ...scenario,
    items: scenario.items.map(item => ({ ...item })),
    comments: scenario.comments.map(comment => ({ ...comment })),
    turns: scenario.turns.map(turn => ({ ...turn })),
    question: scenario.question
      ? { ...scenario.question, options: scenario.question.options.map(option => ({ ...option })) }
      : null,
  }));
}

export function usePasReportOverview({
  returnFocus,
  fallbackFocus,
}: {
  returnFocus: RefObject<HTMLButtonElement | null>;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [cards, setCards] = useState<OverviewScenario[]>(cloneScenarios);
  const [activeId, setActiveId] = useState(OVERVIEW_SCENARIOS[0]!.id);
  const [open, setOpen] = useState(readReportRoute);
  const [target, setTarget] = useState<OverviewTarget | null>(null);
  const [composer, setComposer] = useState("");
  const [undo, setUndo] = useState<OverviewUndo | null>(null);
  const [chatLog, setChatLog] = useState<OverviewChatTurn[]>(INITIAL_PAS_CHAT);
  const [questionReset, setQuestionReset] = useState(0);
  const lastActionRef = useRef<{ key: string; at: number } | null>(null);
  const commentSeq = useRef(0);
  const chatSeq = useRef(0);

  const activeCard = cards.find(card => card.id === activeId) ?? cards[0]!;
  const pendingCards = useMemo(() => cards.filter(isPendingCard), [cards]);
  // 시트의 스트립은 다섯 장을 늘 오간다. 처분한 안건도 다시 펼쳐 읽을 수 있다.
  const stripCards = cards;
  const taskCards = useMemo<CardRow[]>(() => cards.map(overviewCardRow), [cards]);

  useEffect(() => {
    const sync = () => setOpen(readReportRoute());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        window.history.replaceState(null, "", "#report");
      } catch {
        /* 기록을 바꾸지 못하는 환경 */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(current => (current === undo ? null : current)), 20000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const appendChat = useCallback((text: string, role: "assistant" | "user") => {
    const id = `pas-chat-live-${++chatSeq.current}`;
    setChatLog(log => [...log, { id, role, text, time: "지금" }]);
    return id;
  }, []);

  useEffect(() => {
    const onPasChat = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim();
      if (text) appendChat(text, "user");
    };
    window.addEventListener("pas-ro1707:pas-chat", onPasChat);
    return () => window.removeEventListener("pas-ro1707:pas-chat", onPasChat);
  }, [appendChat]);

  const openOverview = useCallback((cardId?: string) => {
    if (cardId && cards.some(card => card.id === cardId)) setActiveId(cardId);
    setTarget(null);
    setOpen(true);
  }, [cards]);

  const closeOverview = useCallback(() => {
    setOpen(false);
    try {
      window.history.replaceState(null, "", "#pas");
    } catch {
      /* 기록을 바꾸지 못하는 환경 */
    }
    const pending = cards.filter(isPendingCard);
    if (pending.length > 0 && !pending.some(card => card.id === activeId)) setActiveId(pending[0]!.id);
    window.requestAnimationFrame(() => {
      (returnFocus.current ?? fallbackFocus.current)?.focus({ preventScroll: true });
    });
  }, [cards, activeId, returnFocus, fallbackFocus]);

  const setActive = useCallback((cardId: string) => {
    setActiveId(cardId);
    setTarget(null);
  }, []);

  const stepWithin = useCallback((list: OverviewScenario[], step: number) => {
    if (list.length === 0) return;
    const index = Math.max(0, list.findIndex(card => card.id === activeCard.id));
    const next = list[(index + step + list.length) % list.length]!;
    setActiveId(next.id);
    setTarget(null);
  }, [activeCard]);

  const go = useCallback((step: number) => stepWithin(stripCards, step), [stepWithin, stripCards]);
  // 말풍선의 앞뒤는 미결 안건만 돈다. 처분한 안건은 말풍선의 장 수에 들지 않는다.
  const goPending = useCallback((step: number) => {
    stepWithin(pendingCards.length > 0 ? pendingCards : [activeCard], step);
  }, [stepWithin, pendingCards, activeCard]);

  // 같은 처분을 연달아 누른 경우만 막는다. 다른 안건으로 넘어가는 다음 처분은
  // 바로 이어서 눌러도 된다.
  const guard = useCallback((key: string) => {
    const now = Date.now();
    const last = lastActionRef.current;
    if (last && last.key === key && now - last.at < 400) return false;
    lastActionRef.current = { key, at: now };
    return true;
  }, []);

  const applyDisposition = useCallback((
    action: Pick<OverviewAction, "label" | "effect">,
    extras: { commentBody?: string; question?: boolean; itemId?: number } = {},
  ) => {
    const card = cards.find(item => item.id === activeId);
    if (!card || !isPendingCard(card)) return false;
    if (!guard(`${card.id}:${action.label}`)) return false;
    const nextStatus: CardStatus = action.effect === "awaiting_verification" ? "awaiting_verification" : "done";
    const commentId = extras.commentBody ? `c-live-${++commentSeq.current}` : null;
    const comment: OverviewComment | null = commentId === null ? null : {
      id: commentId,
      author: "user",
      authorName: "서소영",
      at: "방금",
      body: extras.commentBody!,
      itemId: extras.itemId ?? null,
      question: extras.question,
    };
    const chatText = action.effect === "promote"
      ? `#${card.number} ${card.title}을 폴더 문서로 남기고 완료했습니다.`
      : action.effect === "awaiting_verification"
        ? `#${card.number} ${card.title}을 검증 대기로 옮겼습니다. ${action.label}.`
        : `#${card.number} ${card.title}을 완료했습니다.`;
    const chatId = appendChat(chatText, "assistant");
    setCards(list => list.map(item => item.id === card.id ? {
      ...item,
      status: nextStatus,
      blockedKind: null,
      comments: comment ? [...item.comments, comment] : item.comments,
    } : item));
    setUndo({
      cardId: card.id,
      previousStatus: card.status,
      previousBlockedKind: card.blockedKind,
      previousActiveId: card.id,
      chatId,
      commentId,
      documentId: action.effect === "promote" ? PROMOTED_DOCUMENT_ID : null,
    });
    const remaining = cards.filter(item => item.id !== card.id && isPendingCard(item));
    setActiveId(remaining[0]?.id ?? card.id);
    setTarget(null);
    return true;
  }, [cards, activeId, appendChat, guard]);

  const chooseOption = useCallback(async (label: string) => {
    const card = cards.find(item => item.id === activeId);
    if (!card?.question || !isPendingCard(card)) return false;
    return applyDisposition(
      { label, effect: "done" },
      { commentBody: `선택지 응답: ${label}`, question: true },
    );
  }, [cards, activeId, applyDisposition]);

  const applyAction = useCallback((action: OverviewAction) => applyDisposition(action), [applyDisposition]);

  const sendInstruction = useCallback(() => {
    const text = composer.trim();
    if (!text) return false;
    const card = cards.find(item => item.id === activeId);
    if (!card || !isPendingCard(card)) return false;
    const kind = target?.kind ?? "comment";
    if (!guard(`${card.id}:send:${kind}:${target?.itemId ?? ""}`)) return false;
    const itemId = target?.kind === "item" ? target.itemId : null;
    const commentId = `c-live-${++commentSeq.current}`;
    const nextStatus: CardStatus = kind === "comment"
      ? card.status
      : kind === "answer" ? "done" : "running";
    const chatText = kind === "comment"
      ? `#${card.number}에 커멘트를 남겼습니다.`
      : kind === "answer"
        ? `#${card.number} 질문에 다른 답을 보냈습니다.`
        : `#${card.number}에 ${overviewTargetLabel(target)} 지시를 보냈습니다. 실행 중으로 옮겼습니다.`;
    const chatId = appendChat(chatText, "assistant");
    setCards(list => list.map(item => item.id === card.id ? {
      ...item,
      status: nextStatus,
      blockedKind: kind === "comment" ? item.blockedKind : null,
      comments: [...item.comments, {
        id: commentId,
        author: "user",
        authorName: "서소영",
        at: "방금",
        body: text,
        itemId,
        question: kind === "answer" || kind === "askBack" ? true : undefined,
      }],
    } : item));
    setUndo({
      cardId: card.id,
      previousStatus: card.status,
      previousBlockedKind: card.blockedKind,
      previousActiveId: card.id,
      chatId,
      commentId,
      documentId: null,
    });
    setComposer("");
    setTarget(null);
    if (kind !== "comment") {
      const remaining = cards.filter(item => item.id !== card.id && isPendingCard(item));
      setActiveId(remaining[0]?.id ?? card.id);
    }
    return true;
  }, [composer, cards, activeId, target, appendChat, guard]);

  const undoLast = useCallback(() => {
    if (!undo) return;
    setCards(list => list.map(card => card.id === undo.cardId ? {
      ...card,
      status: undo.previousStatus,
      blockedKind: undo.previousBlockedKind,
      comments: undo.commentId ? card.comments.filter(comment => comment.id !== undo.commentId) : card.comments,
    } : card));
    if (undo.chatId) setChatLog(log => log.filter(turn => turn.id !== undo.chatId));
    setActiveId(undo.previousActiveId);
    setUndo(null);
    setQuestionReset(value => value + 1);
  }, [undo]);

  const confirmItem = useCallback((itemId: number, confirmed: boolean) => {
    setCards(list => list.map(card => card.id === activeId ? {
      ...card,
      items: card.items.map(item => item.id === itemId
        ? { ...item, display: confirmed ? "confirmed" as const : "reported" as const }
        : item),
    } : card));
  }, [activeId]);

  return {
    cards,
    activeCard,
    activeId,
    setActive,
    pendingCards,
    stripCards,
    taskCards,
    chatLog,
    open,
    openOverview,
    closeOverview,
    go,
    goPending,
    target,
    setTarget,
    composer,
    setComposer,
    chooseOption,
    applyAction,
    sendInstruction,
    undo,
    undoLast,
    confirmItem,
    questionReset,
    appendChat,
  };
}
