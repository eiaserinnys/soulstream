/** PAS report storage, message-context, and timeline event contracts. */
export const PERSISTENT_REPORT_METADATA_TYPE = "persistent_report";
export const REPORT_TIMELINE_EVENT_TYPE = "report_timeline";
export type ReportTimelineStatus = "review" | "blocked" | "question" | "done" | "cancelled" | "on_hold" | "report";
export type ReportTimelineLine = {
  line_key: string;
  status: ReportTimelineStatus;
  title: string;
  detail: string;
  card_id: string | null;
  card_number: number | null;
};
export const REPORT_TIMELINE_STATUS_LABEL: Record<ReportTimelineStatus, string> = {
  review: "검수 대기",
  blocked: "막힘",
  question: "질문",
  done: "완료",
  cancelled: "취소",
  on_hold: "보류",
  report: "보고",
};
export function collapseReportTimeline<T>(
  items: readonly T[],
  lineKeyOf: (item: T) => string | null,
  isConversation: (item: T) => boolean,
): T[] {
  const collapsed: T[] = [];
  const positions = new Map<string, number>();
  for (const item of items) {
    if (isConversation(item)) {
      collapsed.push(item);
      positions.clear();
      continue;
    }
    const key = lineKeyOf(item);
    if (key === null) {
      collapsed.push(item);
      continue;
    }
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, collapsed.length);
      collapsed.push(item);
    } else {
      collapsed[position] = item;
    }
  }
  return collapsed;
}
export const PERSISTENT_REPORT_LIMIT = 12;
export const PERSISTENT_REPORT_KEY = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** 카드 질문을 판에 올릴 때 쓰는 예약 key 접두사. `cq_` + 질문 UUID. */
export const CARD_QUESTION_KEY_PREFIX = "cq_";
/** 카드 상태를 판에 올릴 때 쓰는 예약 key 접두사. `card_` + 카드 UUID. */
export const CARD_ENTRY_KEY_PREFIX = "card_";
export interface PersistentReportEntry {
  key: string; kind: "ask" | "see"; title: string; card_numbers: number[];
  context: string; action: string; options: string[]; question_id?: string;
  state: "open" | "answered"; answer: string; updated_at: string;
  /** 서버만 쓰는 카드 연결 칸. PAS 입력으로는 받지 않는다. */
  card_id?: string; card_status?: string;
}
export type PersistentReportEntryInput = Omit<PersistentReportEntry, "updated_at" | "state" | "answer" | "options"> & {
  state?: PersistentReportEntry["state"]; answer?: string; options?: string[];
};
export type PersistentReportIssue = { path: string; reason: string };
export type PersistentReportSummary = Pick<PersistentReportEntry, "key" | "title">;
export type PersistentReportResult =
  | { ok: true; changed: boolean; entries: PersistentReportSummary[]; persistent_report: PersistentReportEntry[] }
  | { ok: false; code: string; errors: PersistentReportIssue[]; entries: PersistentReportSummary[] };
export type PersistentReportReply = { key: string; option: string };
export type PersistentReportVisible = { key: string; title: string };

const INPUT_KEYS = new Set(["key", "kind", "title", "card_numbers", "context", "action", "options", "question_id", "state", "answer"]);
export function parsePersistentReportEntry(input: unknown):
  { ok: true; value: Omit<PersistentReportEntry, "updated_at"> } | { ok: false; errors: PersistentReportIssue[] } {
  const errors: PersistentReportIssue[] = [];
  if (!record(input)) return { ok: false, errors: [{ path: "entry", reason: "장 객체가 필요합니다" }] };
  for (const key of Object.keys(input)) if (!INPUT_KEYS.has(key)) errors.push({ path: key, reason: "지원하지 않는 칸입니다" });
  if (typeof input.key !== "string" || !PERSISTENT_REPORT_KEY.test(input.key)) errors.push({ path: "key", reason: "소문자·숫자로 시작하는 소문자·숫자·_- 1~48자가 필요합니다" });
  if (input.kind !== "ask" && input.kind !== "see") errors.push({ path: "kind", reason: "ask 또는 see가 필요합니다" });
  for (const [field, max] of [["title",24],["context",120],["answer",40]] as const) {
    const value = field === "answer" ? input[field] ?? "" : input[field];
    if (typeof value !== "string" || Array.from(value).length > max) errors.push({ path: field, reason: `${max}자 이내 문자열이 필요합니다` });
  }
  if (!Array.isArray(input.card_numbers) || input.card_numbers.length > 3 || input.card_numbers.some(n => !Number.isInteger(n))) errors.push({ path: "card_numbers", reason: "정수 0~3개가 필요합니다" });
  if (input.kind === "see" && input.options !== undefined) errors.push({ path: "options", reason: "see 장에는 options를 넣을 수 없습니다" });
  else if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 3 || input.options.some(o => typeof o !== "string" || Array.from(o).length > 12))) errors.push({ path: "options", reason: "각 12자 이내 선택지 0~3개가 필요합니다" });
  if (input.kind === "see" && input.state === "answered") errors.push({ path: "state", reason: "see 장은 answered 상태를 받을 수 없습니다" });
  if (input.question_id !== undefined && (typeof input.question_id !== "string" || !input.question_id)) errors.push({ path: "question_id", reason: "질문 ID 문자열이 필요합니다" });
  if (input.state !== undefined && input.state !== "open" && input.state !== "answered") errors.push({ path: "state", reason: "open 또는 answered가 필요합니다" });
  if (typeof input.action !== "string") errors.push({ path: "action", reason: "문자열이 필요합니다" });
  else errors.push(...validateAction(input.action));
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: {
    key: input.key as string, kind: input.kind as PersistentReportEntry["kind"], title: input.title as string,
    card_numbers: [...input.card_numbers as number[]], context: input.context as string, action: input.action as string,
    options: [...(input.options as string[] | undefined ?? [])],
    ...(input.question_id === undefined ? {} : { question_id: input.question_id as string }),
    state: input.state as PersistentReportEntry["state"] | undefined ?? "open", answer: input.answer as string | undefined ?? "",
  } };
}

function validateAction(action: string): PersistentReportIssue[] {
  if (Array.from(action).length > 1000) return [{ path: "action", reason: "전체 원문은 1,000자까지입니다" }];
  const errors: PersistentReportIssue[] = [];
  let badLink = false;
  let linkCount = 0, labelLength = 0;
  const plain = action.replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    linkCount++;
    labelLength += Array.from(label).length;
    try { if (new URL(url).protocol !== "https:") badLink = true; } catch { badLink = true; }
    return "";
  });
  if (labelLength + Array.from(plain).length > 100) errors.push({ path: "action", reason: "보이는 글은 100자까지입니다(링크 주소 제외)" });
  if (linkCount > 5) errors.push({ path: "action", reason: "링크는 5개까지입니다" });
  if (/!\[/.test(action) || badLink || /[\[\]<>`*]|__|_[^\s_]+_|(^|\n)\s*(?:#{1,6}\s|[-+]\s|\d+\.\s)/.test(plain))
    errors.push({ path: "action", reason: "글과 [글](https://…) 링크만 넣을 수 있습니다" });
  return errors;
}

export function readPersistentReport(metadata: unknown): PersistentReportEntry[] {
  if (!Array.isArray(metadata)) return [];
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (record(entry) && entry.type === PERSISTENT_REPORT_METADATA_TYPE && record(entry.value)) {
      return Array.isArray(entry.value.entries) ? entry.value.entries as PersistentReportEntry[] : [];
    }
  }
  return [];
}

export function parsePersistentReportReply(context: unknown): PersistentReportReply | null {
  if (!Array.isArray(context)) return null;
  for (const item of context) {
    if (!record(item) || item.key !== "persistent_report_reply" || !record(item.content)) continue;
    const { key, option } = item.content;
    if (typeof key === "string" && PERSISTENT_REPORT_KEY.test(key) && typeof option === "string" && Array.from(option).length <= 12) return { key, option };
  }
  return null;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
