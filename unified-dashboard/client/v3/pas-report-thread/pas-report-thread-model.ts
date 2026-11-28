import type { useTranslation } from "react-i18next";
import type { CardComment, CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CARD_QUESTION_KEY_PREFIX, type PersistentReportEntry } from "../../../../packages/wire-schema/src/persistent_report";
import { isOpenCardQuestion } from "../CardQuestionBlock";
import type { AgendaKind, RailGroups, ThreadItem } from "@seosoyoung/soul-ui/lib/pas-report-thread-core";

export type ReportEntry = PersistentReportEntry & { card_id?: string; card_status?: string };

export interface Agenda {
  cardId: string;
  number: number | null;
  title: string;
  kind: AgendaKind;
  /** 이 PAS 판의 장. 카드 목록에서만 온 진행 중 안건은 null이다. */
  entry: ReportEntry | null;
  /** 사용자가 미뤄 둔 시각(ms). 미루지 않았으면 null. 지금보다 뒤인지는 groupAgendas가 가린다. */
  snoozedUntil: number | null;
  agentId: string | null;
  portraitUrl: string | null;
  updatedAt: number;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function agendaBase(card: CardRow | undefined, entry: ReportEntry | null, cardId: string): Omit<Agenda, "kind"> {
  return {
    cardId,
    number: card?.number ?? entry?.card_numbers[0] ?? null,
    title: card?.title ?? entry?.title ?? "",
    entry,
    snoozedUntil: parseTime(card?.snoozedUntil),
    agentId: card?.assigneeAgent?.agentId ?? card?.assigneeAgentId ?? null,
    portraitUrl: card?.assigneeAgent?.portraitUrl ?? null,
    updatedAt: parseTime(entry?.updated_at) ?? parseTime(card?.updatedAt) ?? 0,
  };
}

function kindOfStatus(status: string | undefined): AgendaKind | null {
  if (status === "review") return "review";
  if (status === "blocked") return "blocked";
  if (status === "running") return "running";
  if (status === "awaiting_verification") return "verifying";
  return null;
}

/** 판의 한 장을 안건으로 바꾼다. card_id가 없는 PAS 자체 장과 닫힌 질문 장은 안건이 아니다. */
export function entryAgenda(entry: ReportEntry, card: CardRow | undefined): Agenda | null {
  if (!entry.card_id) return null;
  if (entry.key.startsWith(CARD_QUESTION_KEY_PREFIX)) {
    if ((entry.state ?? "open") !== "open") return null;
    return { ...agendaBase(card, entry, entry.card_id), kind: entry.question_kind === "request" ? "request" : "question" };
  }
  const kind = kindOfStatus(card?.status ?? entry.card_status);
  return kind ? { ...agendaBase(card, entry, entry.card_id), kind } : null;
}

/** 카드 목록의 진행 중과 검증 대기 카드. 그 밖의 상태는 안건이 아니다. */
export function cardAgenda(card: CardRow): Agenda | null {
  const kind = card.status === "running" ? "running" : card.status === "awaiting_verification" ? "verifying" : null;
  return kind ? { ...agendaBase(card, null, card.id), kind } : null;
}

/**
 * 결재 대기는 판 순서, 미뤄 둠은 되돌아올 시각 순, 진행 중은 최근 갱신 순이다.
 * 진행 중은 결재 대기와 미뤄 둠에 없는 카드만 담는다.
 */
export function groupAgendas(boardAgendas: readonly Agenda[], cards: readonly CardRow[], now: number): RailGroups<Agenda> {
  const seen = new Set<string>();
  const board = boardAgendas.filter(agenda => !seen.has(agenda.cardId) && seen.add(agenda.cardId));
  const snoozed = board.filter(agenda => agenda.snoozedUntil !== null && agenda.snoozedUntil > now)
    .sort((a, b) => a.snoozedUntil! - b.snoozedUntil!);
  const snoozedIds = new Set(snoozed.map(agenda => agenda.cardId));
  const pending = board.filter(agenda => !snoozedIds.has(agenda.cardId));
  const running = cards.flatMap(card => seen.has(card.id) ? [] : cardAgenda(card) ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { pending, running, snoozed, holdCount: cards.filter(card => card.status === "on_hold").length };
}

type Translate = ReturnType<typeof useTranslation>["t"];

export function formatThreadTime(at: number, withDate: boolean, locale: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (withDate) Object.assign(options, { month: "numeric", day: "numeric" });
  return new Date(at).toLocaleString(locale, options);
}

export function formatReturnTime(at: number, now: number, t: Translate, locale: string): string {
  const target = new Date(at), today = new Date(now);
  const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((dayOf(target) - dayOf(today)) / 86_400_000);
  const time = formatThreadTime(at, diffDays > 1, locale);
  return diffDays === 1 ? t("persistent.thread.tomorrowAt", { time }) : time;
}

const ORDER: Record<ThreadItem<unknown, unknown>["kind"], number> = { request: 0, milestone: 1, question: 2, comments: 3, notes: 4 };

/**
 * 카드 상세를 한 줄기 시간순 스레드로 합친다.
 * 이정표는 상황판 문구, 상태 전환, 담당이 아닌 세션의 위임이다. statusHistory가 아직 없는 응답은 그 이정표만 뺀다.
 * 질문 글타래의 커멘트는 질문 블록이 그리므로 따로 두지 않는다. 노트는 이어진 것끼리 한 덩이로 묶는다.
 */
export function buildThread(detail: CardDetail, t: Translate): ThreadItem<CardComment, CardQuestion>[] {
  const card = detail.card;
  const flat: ThreadItem<CardComment, CardQuestion>[] = [];
  if (card.request.trim()) flat.push({ id: "request", at: parseTime(card.createdAt) ?? 0, kind: "request" });
  const nowEntries = detail.nowHistory?.length ? detail.nowHistory
    : card.now ? [{ text: card.now.text, at: card.now.updatedAt }] : [];
  const seenNow = new Set<string>();
  nowEntries.forEach((entry, index) => {
    const key = `${entry.at}\0${entry.text}`;
    if (!entry.text?.trim() || seenNow.has(key)) return;
    seenNow.add(key);
    flat.push({ id: `now:${entry.at}:${index}`, at: parseTime(entry.at) ?? 0, kind: "milestone", tone: "now", text: entry.text });
  });
  (detail.statusHistory ?? []).forEach((entry, index) => {
    flat.push({ id: `status:${entry.at}:${index}`, at: parseTime(entry.at) ?? 0, kind: "milestone", tone: "status",
      text: t("persistent.thread.statusChanged", { status: t(`persistent.thread.status.${entry.status}`, { defaultValue: entry.status }) }) });
  });
  for (const session of detail.sessions) {
    if (session.sessionId === card.assigneeSessionId) continue;
    flat.push({ id: `session:${session.sessionId}`, at: parseTime(session.createdAt) ?? 0, kind: "milestone", tone: "delegate",
      text: t("persistent.thread.delegated", { agent: session.agentName ?? session.agentId }) });
  }
  const questionIds = new Set(detail.questions.map(question => question.id));
  for (const question of detail.questions) flat.push({ id: `question:${question.id}`, at: parseTime(question.askedAt) ?? 0, kind: "question", question });
  const all = new Map<string, CardComment>();
  for (const comment of [...(detail.comments ?? []), ...(detail.notes ?? [])]) all.set(comment.id, comment);
  const lines = [...all.values()].filter(comment => !(comment.questionId && questionIds.has(comment.questionId)));
  type Entry = { at: number; order: number; id: string; item?: ThreadItem<CardComment, CardQuestion>; comment?: CardComment };
  const entries: Entry[] = [
    ...flat.map(item => ({ at: item.at, order: ORDER[item.kind], id: item.id, item })),
    ...lines.map(comment => ({ at: parseTime(comment.createdAt) ?? 0, order: comment.kind === "note" ? ORDER.notes : ORDER.comments, id: comment.id, comment })),
  ].sort((a, b) => a.at - b.at || a.order - b.order || a.id.localeCompare(b.id));
  // 커멘트와 노트는 서로 이어진 것끼리 묶고, 사이에 이정표나 질문이 끼면 새 덩이로 시작한다.
  const thread: ThreadItem<CardComment, CardQuestion>[] = [];
  for (const { item, comment } of entries) {
    if (item) { thread.push(item); continue; }
    const last = thread[thread.length - 1];
    if (comment!.kind === "note") {
      if (last?.kind === "notes") last.notes.push(comment!);
      else thread.push({ id: `notes:${comment!.id}`, at: parseTime(comment!.createdAt) ?? 0, kind: "notes", notes: [comment!] });
    } else if (last?.kind === "comments") last.comments.push(comment!);
    else thread.push({ id: `comments:${comment!.id}`, at: parseTime(comment!.createdAt) ?? 0, kind: "comments", comments: [comment!] });
  }
  return thread;
}

/** 열린 질문(여럿이면 판의 질문 장에 맞는 것, 없으면 가장 앞). */
export function openQuestionOf(detail: CardDetail | undefined, entry: ReportEntry | null): CardQuestion | null {
  const open = (detail?.questions ?? []).filter(isOpenCardQuestion);
  return (entry?.question_id ? open.find(question => question.id === entry.question_id) : undefined) ?? open[0] ?? null;
}
