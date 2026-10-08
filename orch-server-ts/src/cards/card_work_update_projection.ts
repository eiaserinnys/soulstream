import type { CardItem, CardItemDisplay, CardItemState, CardNow } from "./card_item_rules.js";
import { getCardItemDisplay } from "./card_item_rules.js";
import type { CardRow, FolderOperationRow } from "./control_plane/card_types.js";
import { serializeCardRow } from "../folders/folder_contracts.js";

export type CardWorkProjectionRecords = {
  report?: { id: string; title: string };
  question?: { id: string; text: string; options: string[] | null };
  reply?: { id: string; body: string };
};

export type CardWorkItemProjection = {
  id: number;
  title: string;
  rev: number;
  state: CardItemState;
  result: string | null;
  evidence: CardItem["evidence"];
  caveat: string | null;
  confirmed: CardItem["confirmed"];
  fixOpen: number;
  display: CardItemDisplay;
};

export type CardWorkRemainingItem = {
  id: number;
  title: string;
  state: CardItemState;
  rev: number;
  confirmed: CardItem["confirmed"];
  fixOpen: number;
  needsConfirmation: boolean;
};

export type CardWorkUpdateVerification = { checked: string[]; unchecked: string[] };

type CardWorkUpdateBase = {
  schema: "card_work_update.v1";
  event_id: string;
  saved_at: string;
  card: Pick<CardRow, "id" | "number" | "title" | "version" | "status">;
  now: CardNow | null;
  detail_ref: { card_id: string; operation_id: string };
  verification: CardWorkUpdateVerification | null;
  summary: string | null;
  remaining: CardWorkRemainingItem[];
};

type CardWorkCard = Pick<CardRow, "id" | "number" | "title" | "version" | "status" | "items" | "now" | "blocked_kind" | "blocked_detail">;

export type CardWorkUpdate = CardWorkUpdateBase & (
  | { kind: "item_result"; item: CardWorkItemProjection }
  | { kind: "report"; report: { id: string; title: string; summary: string | null; detailRequired: boolean } }
  | { kind: "question"; question: { id: string; text: string; options: string[] | null } }
  | { kind: "blocked"; blocked: { kind: CardRow["blocked_kind"]; detail: string | null } }
  | { kind: "review" | "done" | "cancelled"; items: CardWorkItemProjection[] }
  | { kind: "reply"; reply: { id: string; body: string } }
  | { kind: "attention" }
);

type CardWorkOperationPayload = {
  item_id?: number;
  state?: string;
  report_id?: string;
  question_id?: string;
  comment_id?: string;
  author_kind?: string;
  status?: string;
  summary?: unknown;
  verification?: unknown;
};

type SerializedOperationTimestamp = { createdAt: string };

function projectItem(item: CardItem): CardWorkItemProjection {
  return {
    id: item.id,
    title: item.title,
    rev: item.rev,
    state: item.state,
    result: item.result,
    evidence: item.evidence.map((evidence) => ({ ...evidence })),
    caveat: item.caveat,
    confirmed: item.confirmed === null ? null : { ...item.confirmed },
    fixOpen: item.fixOpen,
    display: getCardItemDisplay(item),
  };
}

function projectRemaining(items: readonly CardItem[]): CardWorkRemainingItem[] {
  return items
    .filter((item) => item.state !== "dropped" && (
      item.state === "todo" || item.state === "doing" || item.fixOpen > 0 ||
      (item.state === "done" && item.confirmed === null)
    ))
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      rev: item.rev,
      confirmed: item.confirmed === null ? null : { ...item.confirmed },
      fixOpen: item.fixOpen,
      needsConfirmation: item.state === "done" && item.confirmed === null,
    }));
}

function makeBase(operation: FolderOperationRow, card: CardWorkCard, payload: CardWorkOperationPayload): CardWorkUpdateBase {
  const serializedOperation = serializeCardRow({ created_at: operation.created_at }) as SerializedOperationTimestamp;
  const storedVerification = payload.verification as CardWorkUpdateVerification | null | undefined;
  const verification = storedVerification == null
    ? null
    : { checked: [...storedVerification.checked], unchecked: [...storedVerification.unchecked] };
  return {
    schema: "card_work_update.v1",
    event_id: operation.id,
    saved_at: serializedOperation.createdAt,
    card: { id: card.id, number: card.number, title: card.title, version: card.version, status: card.status },
    now: card.now === null ? null : { ...card.now },
    detail_ref: { card_id: card.id, operation_id: operation.id },
    verification,
    summary: typeof payload.summary === "string" ? payload.summary : null,
    remaining: projectRemaining(card.items),
  };
}

function matchingRowId(operation: string, expectedId: string | undefined, actualId: string | undefined): string {
  if (expectedId === undefined || actualId !== expectedId)
    throw new Error(`Cannot project ${operation}: saved row ID does not match operation`);
  return expectedId;
}

export function projectCardWorkUpdate(
  operation: FolderOperationRow,
  card: Pick<CardRow, "id" | "number" | "title" | "version" | "status" | "items" | "now" | "blocked_kind" | "blocked_detail">,
  records: CardWorkProjectionRecords = {},
): CardWorkUpdate | null {
  if (operation.target_kind !== "card" || operation.target_id !== card.id) return null;

  const payload = operation.payload_json as CardWorkOperationPayload;
  const base = () => makeBase(operation, card, payload);

  switch (operation.operation_type) {
    case "report_card_item": {
      if (payload.state !== "done" && payload.state !== "dropped") return null;
      const item = card.items.find((candidate) => candidate.id === payload.item_id);
      if (!item) throw new Error("Cannot project report_card_item: saved item ID does not match operation");
      return { ...base(), kind: "item_result", item: projectItem(item) };
    }
    case "add_card_report": {
      const id = matchingRowId("add_card_report", payload.report_id, records.report?.id);
      const summary = typeof payload.summary === "string" ? payload.summary : null;
      return {
        ...base(),
        kind: "report",
        report: { id, title: records.report!.title, summary, detailRequired: summary === null },
      };
    }
    case "ask_card_question": {
      const id = matchingRowId("ask_card_question", payload.question_id, records.question?.id);
      const question = records.question!;
      return { ...base(), kind: "question", question: { id, text: question.text, options: question.options === null ? null : [...question.options] } };
    }
    case "set_card_status": {
      switch (payload.status) {
        case "blocked":
          return { ...base(), kind: "blocked", blocked: { kind: card.blocked_kind, detail: card.blocked_detail } };
        case "review":
        case "done":
        case "cancelled":
          return { ...base(), kind: payload.status, items: card.items.slice(-6).map(projectItem) };
        default:
          return null;
      }
    }
    case "add_card_comment": {
      if (payload.author_kind !== "agent") return null;
      const id = matchingRowId("add_card_comment reply", payload.comment_id, records.reply?.id);
      return { ...base(), kind: "reply", reply: { id, body: records.reply!.body } };
    }
    case "update_card_now":
      return card.now?.turn === "user" || card.now?.turn === "outside" ? { ...base(), kind: "attention" } : null;
    default:
      return null;
  }
}

export function formatCardWorkUpdateMessage(update: CardWorkUpdate): string {
  return `[카드 결과 알림]\n${JSON.stringify(update)}`;
}
