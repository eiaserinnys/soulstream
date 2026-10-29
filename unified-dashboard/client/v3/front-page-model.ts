import type { CardCheckItem, CardItemDisplay } from "@seosoyoung/soul-ui/cards/card-types";

/** 1면이 받는 카드 한 장. 운영에서는 카드 목록과 상황판에서 채운다. */
export interface FrontPageCard {
  number: number;
  title: string;
  project: string;
  now: string | null;
  ask: string | null;
  statusChangedAt: string;
  items: readonly { title: string; state: CardCheckItem["state"] }[];
  images: readonly string[];
}

export interface FrontPageQuestion {
  number: number;
  cardTitle: string;
  text: string;
  options: readonly string[];
  askedAt: string;
}

/** 사용률은 0~100. 1면은 숫자를 쓰지 않고 막대 길이로만 보인다. */
export interface FrontPageNode {
  id: string;
  label: string;
  cpu: number;
  mem: number;
  disk: number;
}

export interface FrontPageLimit {
  name: string;
  remaining: number;
  rejected: boolean;
}

export interface FrontPageData {
  review: readonly FrontPageCard[];
  running: readonly FrontPageCard[];
  blocked: readonly FrontPageCard[];
  done: readonly FrontPageCard[];
  queued: readonly FrontPageCard[];
  questions: readonly FrontPageQuestion[];
  nodes: readonly FrontPageNode[];
  limits: readonly FrontPageLimit[];
  projectsToday: readonly string[];
  dailyPages: readonly string[];
}

const LEADING_EMOJI = /^(\p{Extended_Pictographic}️?)\s*/u;

/** 폴더 이름 앞의 그림 글자. 프로젝트 줄에서 아이콘으로 쓴다. */
export function projectIcon(project: string): string | null {
  return LEADING_EMOJI.exec(project)?.[1] ?? null;
}

/** 표지(키커)에 쓰는 이름. 그림 글자를 뺀다. */
export function projectName(project: string): string {
  return project.replace(LEADING_EMOJI, "");
}

export function newestFirst<T extends { statusChangedAt: string }>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => Date.parse(b.statusChangedAt) - Date.parse(a.statusChangedAt));
}

/** 리드는 그림이 있는 검수 대기 중 가장 최근 것. 나머지는 최근 순. */
export function splitReview(review: readonly FrontPageCard[]): { lead: FrontPageCard | null; rest: FrontPageCard[] } {
  const sorted = newestFirst(review);
  const lead = sorted.find(card => card.images.length > 0) ?? sorted[0] ?? null;
  return { lead, rest: sorted.filter(card => card !== lead) };
}

const ITEM_DISPLAY: Record<CardCheckItem["state"], CardItemDisplay> = {
  todo: "todo",
  doing: "doing",
  done: "reported",
  dropped: "dropped",
};

/** 확인 항목 점(CardProgressSummary)이 읽는 모양으로 옮긴다. */
export function toCheckItems(card: FrontPageCard): CardCheckItem[] {
  return card.items.map((item, index) => ({
    id: card.number * 100 + index,
    title: item.title,
    state: item.state,
    result: null,
    evidence: [],
    caveat: null,
    rev: 1,
    confirmed: null,
    fixOpen: 0,
    reopened: null,
    from: null,
    createdAt: card.statusChangedAt,
    reportedAt: item.state === "done" ? card.statusChangedAt : null,
    display: ITEM_DISPLAY[item.state],
  }));
}

export function clockTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
}

export function frontPageDate(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long", timeZone }).format(date);
}

export function isoDate(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

/** 사용률 막대가 경고 색으로 바뀌는 문턱. */
export const NODE_USAGE_WARNING = 80;
/** 남은 한도 막대가 경고 색으로 바뀌는 문턱(주간 사용량 표시와 같다). */
export const LIMIT_REMAINING_WARNING = 20;

/** 오늘이면 시각(14:27), 지난 날이면 날짜(10.28). 장부 여백의 고정폭 한 칸에 들어간다. */
export function ledgerStamp(iso: string, now: Date, timeZone?: string): string {
  const day = (date: Date) => isoDate(date, timeZone);
  const date = new Date(iso);
  if (day(date) === day(now)) return clockTime(iso, timeZone);
  const [, month, dayOfMonth] = day(date).split("-");
  return `${month}.${dayOfMonth}`;
}

/** 카드 상세(1면에서 들어간 화면)가 받는 카드. */
export interface FrontCardEvidence {
  type: "image" | "link";
  label: string;
  /** 시안 묶음 안에 남은 그림이면 그 주소. 없으면 이름만 보인다. */
  src: string | null;
}

export interface FrontCardItem {
  id: number;
  title: string;
  state: CardCheckItem["state"];
  result: string | null;
  caveat: string | null;
  evidence: readonly FrontCardEvidence[];
}

export interface FrontCardEntry {
  kind: "comment" | "note";
  authorKind: "agent" | "user";
  body: string;
  createdAt: string;
}

export interface FrontCardSession {
  id: string;
  title: string;
  agentId: string;
  nodeId: string;
  status: string;
  modelPreset: string;
  updatedAt: string;
}

export interface FrontCardDetail {
  number: number;
  title: string;
  status: "todo" | "queued" | "running" | "blocked" | "review" | "done" | "cancelled";
  project: string;
  now: { text: string; ask: string | null; turn: "agent" | "user" | "outside"; sessionId: string | null } | null;
  nodeId: string;
  modelPreset: string;
  items: readonly FrontCardItem[];
  entries: readonly FrontCardEntry[];
  sessions: readonly FrontCardSession[];
}
