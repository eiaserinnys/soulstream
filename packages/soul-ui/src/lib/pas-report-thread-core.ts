// 카드 #1871: PAS 결재형 보고 창의 웹판과 앱판이 함께 쓰는 순수 선언.
// 웹과 앱이 서로 다른 카드 타입(CardComment, CardQuestion, Agenda)을 쓰므로 그 자리는 타입 매개변수로 받는다.
// 앱 번들이 읽으므로 import 없이 둔다.

/** 보고 창이 다루는 안건의 종류. 데이터로 가른다. */
export type AgendaKind = "question" | "request" | "review" | "blocked" | "running" | "verifying";
export const AGENDA_KIND_LABEL: Readonly<Record<AgendaKind, string>> = {
  question: "질문", request: "부탁", review: "검수", blocked: "막힘", running: "진행", verifying: "검증 대기",
};

/** 안건 하나에서 이 묶음이 읽는 것은 미뤄 둔 시각뿐이다. */
interface Snoozable { snoozedUntil: number | null }

export interface RailGroups<A> {
  pending: A[];
  running: A[];
  snoozed: A[];
  holdCount: number;
}

/** 미루기 시각이 지나 결재 대기로 돌아올 다음 순간(ms). 없으면 null. */
export function nextSnoozeReturn(agendas: readonly Snoozable[], now: number): number | null {
  const later = agendas.flatMap(agenda => agenda.snoozedUntil !== null && agenda.snoozedUntil > now ? [agenda.snoozedUntil] : []);
  return later.length ? Math.min(...later) : null;
}

export type SnoozeOptionId = "hour" | "evening" | "tomorrow" | "three-days";
export interface SnoozeOption { id: SnoozeOptionId; label: string; at: number }

/** 지역 시각 기준 미루기 선택지. 지금이 18시 뒤면 「오늘 저녁」은 뺀다. */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const at = (days: number, hour: number) => {
    const target = new Date(now);
    target.setDate(target.getDate() + days);
    target.setHours(hour, 0, 0, 0);
    return target.getTime();
  };
  return [
    { id: "hour" as const, label: "1시간 뒤", at: now.getTime() + 60 * 60 * 1000 },
    ...(now.getHours() < 18 ? [{ id: "evening" as const, label: "오늘 저녁", at: at(0, 19) }] : []),
    { id: "tomorrow" as const, label: "내일 아침", at: at(1, 9) },
    { id: "three-days" as const, label: "사흘 뒤", at: at(3, 9) },
  ];
}

export type MilestoneTone = "now" | "status" | "delegate";
/** 스레드의 한 덩이. 커멘트와 질문의 타입은 쓰는 쪽(웹, 앱)의 카드 타입을 받는다. */
export type ThreadItem<Comment, Question> =
  | { id: string; at: number; kind: "request" }
  | { id: string; at: number; kind: "milestone"; tone: MilestoneTone; text: string }
  | { id: string; at: number; kind: "comments"; comments: Comment[] }
  | { id: string; at: number; kind: "question"; question: Question }
  | { id: string; at: number; kind: "notes"; notes: Comment[] };

/** 항목 지시 글 머리. 서버가 질문 글타래와 항목을 함께 받지 않으므로 질문이 열려 있으면 글에 번호를 적는다. */
export function itemInstructionBody(itemId: number, text: string): string {
  return `${itemId}번 항목: ${text}`;
}

export interface ProcessedAgenda<A> { agenda: A; label: string }
/** 되돌리기 줄에 쓰는 기록. 완료와 보류는 기존 5초 되돌리기 훅이, 답변 미루기는 컨트롤러가 맡는다. */
export interface SnoozeUndo { cardId: string; number: number | null; expiresAt: number }
export type ThreadLoad = "loading" | "ready" | "error";
export type SendMode = "comment" | "ask" | "answer";
