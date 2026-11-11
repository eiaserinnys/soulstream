import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { AttachmentRef } from "@soulstream/wire-schema/attachments";
import { attachmentRefsOf, collectCardAttachmentRefs, validateCardSourceRefsTx } from "./card_attachment_refs.js";
import { mergeCardSourceAttachmentRefs, resolveCardLegacySourceRefsTx } from "./card_attachment_legacy_refs.js";
import { assertNoPendingCardExecution } from "./card_execution_reservation.js";
import { makeCardNow, type CardItem } from "./card_item_rules.js";
import type { CardRow, CardStatus, FolderActorParams, FolderOperationRow, RepositorySql } from "./control_plane/card_types.js";

export type BulkStatus = "todo" | "queued" | "on_hold" | "cancelled";

/** The only statuses a card may hold before its first start. */
const UNSTARTED_STATUSES: readonly CardStatus[] = ["todo", "queued", "on_hold"];

export type CardCommentRow = {
  id: string;
  card_id: string;
  author_kind: "user" | "agent";
  author_id: string | null;
  session_id: string | null;
  kind: "comment" | "spoken" | "note";
  body: string;
  attachment_refs: AttachmentRef[];
  item_id: number | null;
  delivered_at: Date | null;
  created_at: Date;
} & Record<string, unknown>;

export function cardLabel(card: Pick<CardRow, "id" | "number">): string {
  return card.number === null ? card.id : `#${card.number}`;
}

export function cardNotFound(input: string): Error {
  return Object.assign(new Error(`카드 ${input}를 찾을 수 없습니다.`), { statusCode: 404, code: "CARD_NOT_FOUND" });
}

export function invalidMaintenance(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_REQUEST" });
}

export function requireMaintenanceSession(params: FolderActorParams): string {
  if (params.actorKind !== "agent" || !params.actorSessionId?.trim())
    throw Object.assign(new Error("card mutation requires an agent session"), { statusCode: 403 });
  return params.actorSessionId;
}

export async function readCardTx(sql: RepositorySql, cardId: string): Promise<CardRow | null> {
  return (await sql<CardRow[]>`SELECT * FROM cards WHERE id=${cardId}`)[0] ?? null;
}

export async function lockCardTx(sql: RepositorySql, cardId: string, input = cardId): Promise<CardRow> {
  const rows = await sql<CardRow[]>`SELECT * FROM cards WHERE id=${cardId} FOR UPDATE`;
  if (!rows[0]) throw cardNotFound(input);
  return rows[0];
}

/** Locks every merge participant in UUID string order so overlapping merges cannot deadlock. */
export async function lockCardsTx(sql: RepositorySql, cardIds: readonly string[], inputs: ReadonlyMap<string, string>): Promise<Map<string, CardRow>> {
  const ids = [...new Set(cardIds)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const rows = await sql<CardRow[]>`SELECT * FROM cards WHERE id = ANY(${sql.array(ids)}::text[]) ORDER BY id COLLATE "C" FOR UPDATE`;
  const locked = new Map(rows.map(row => [row.id, row]));
  for (const id of ids) if (!locked.has(id)) throw cardNotFound(inputs.get(id) ?? id);
  return locked;
}

export async function readOperationTx(sql: RepositorySql, idempotencyKey: string): Promise<FolderOperationRow | null> {
  return (await sql<FolderOperationRow[]>`SELECT * FROM folder_operations WHERE idempotency_key=${idempotencyKey} LIMIT 1`)[0] ?? null;
}

export async function readMergeCommentsTx(sql: RepositorySql, cardIds: readonly string[]): Promise<CardCommentRow[]> {
  return await sql<CardCommentRow[]>`SELECT * FROM card_comments
    WHERE card_id = ANY(${sql.array([...cardIds])}::text[])
      AND (kind='note' OR (author_kind='user' AND kind IN ('comment','spoken')))
    ORDER BY created_at,id`;
}

export async function assertUnstartedCardTx(sql: RepositorySql, card: CardRow): Promise<void> {
  const condition = card.archived ? "보관됨"
    : card.assignee_kind === "human" ? "사람 담당"
    : card.assignee_session_id !== null ? "담당 세션 연결됨"
    : UNSTARTED_STATUSES.includes(card.status) ? null : `현재 상태 ${card.status}`;
  if (condition !== null)
    throw Object.assign(new Error(`카드 ${cardLabel(card)}은 ${condition}으로 시작 전 카드가 아닙니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.`),
      { statusCode: 409, code: "CARD_NOT_UNSTARTED" });
  try {
    await assertNoPendingCardExecution(sql, card.id);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "CARD_EXECUTION_PENDING") throw error;
    throw Object.assign(new Error(`카드 ${cardLabel(card)}은 실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.`),
      { statusCode: 409, code: "CARD_EXECUTION_PENDING" });
  }
}

function assigneeRunning(card: CardRow): Error {
  return Object.assign(new Error(`카드 ${cardLabel(card)}의 담당이 실행 중입니다. 담당 세션이 지금 턴을 돌고 있습니다. 후속 지시는 dispatch_work로 전하거나 턴이 끝난 뒤 다시 시도하세요.`),
    { statusCode: 409, code: "CARD_ASSIGNEE_RUNNING" });
}

/** The bulk-only gate: a connected assignee may be held/cancelled only while idle. */
export async function assertBulkStatusGuardTx(sql: RepositorySql, card: CardRow, status: CardStatus): Promise<void> {
  if (card.assignee_kind === "human")
    throw Object.assign(new Error("사람이 담당인 카드는 bulk_set_card_status로 바꿀 수 없습니다."), { statusCode: 403 });
  if (card.assignee_session_id === null) return;
  if (card.status === "running") throw assigneeRunning(card);
  const session = (await sql<{ status: string | null }[]>`SELECT status FROM sessions WHERE session_id=${card.assignee_session_id}`)[0];
  if (!session)
    throw Object.assign(new Error("담당 세션을 찾을 수 없습니다. 현재 담당을 확인하세요."), { statusCode: 409 });
  if (session.status === "running" || session.status === "initializing") throw assigneeRunning(card);
  if (status === "todo" || status === "queued")
    throw Object.assign(new Error("담당 세션이 있는 카드는 보류·취소만 가능합니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요."), { statusCode: 403 });
}

export async function updateAttachmentRefsTx(
  sql: RepositorySql,
  card: CardRow,
  body: string,
  actor: FolderActorParams,
): Promise<AttachmentRef[]> {
  const existingRefs = attachmentRefsOf(card.attachment_refs);
  await validateCardSourceRefsTx(sql, {
    cardId: card.id, actorKind: actor.actorKind ?? "agent", actorSessionId: actor.actorSessionId, body, existingRefs,
  });
  const legacyRefs = await resolveCardLegacySourceRefsTx(sql, {
    cardId: card.id, assigneeSessionId: card.assignee_session_id, actor, body, format: "markdown",
    attachments: card.attachments ?? [],
  });
  return mergeCardSourceAttachmentRefs(collectCardAttachmentRefs({
    request: body, attachments: card.attachments ?? [], items: card.items ?? [],
    previousRefs: existingRefs, previousItems: card.items ?? [],
  }), legacyRefs);
}

export function describeCard(card: CardRow): string {
  return `${cardLabel(card)} 「${card.title}」`;
}

export function appendRequestSection(request: string, source: CardRow, comments: readonly CardCommentRow[]): string {
  let merged = `${request}\n\n## 합친 카드 ${describeCard(source)}\n\n${source.request}`;
  if (comments.length > 0) {
    merged += `\n\n### ${cardLabel(source)}의 커멘트`;
    for (const comment of comments)
      merged += `\n\n[작성자 종류: ${comment.author_kind}, 기록 종류: ${comment.kind}]\n\n${comment.body}`;
  }
  return merged;
}

export function appendBriefSection(brief: string, source: CardRow): string {
  if (source.brief.trim() === "") return brief;
  return `${brief}\n\n## 합친 카드 ${describeCard(source)}의 인계\n\n${source.brief}`;
}

const attachmentKey = (attachment: CardAttachment) => JSON.stringify([attachment.nodeId, attachment.path]);

export function unionAttachments(target: readonly CardAttachment[], sources: readonly CardAttachment[]): { attachments: CardAttachment[]; added: number } {
  const seen = new Set<string>();
  const attachments: CardAttachment[] = [];
  for (const attachment of [...target, ...sources]) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    attachments.push(attachment);
  }
  const targetKeys = new Set(target.map(attachmentKey));
  const addedKeys = new Set<string>();
  for (const attachment of sources) {
    const key = attachmentKey(attachment);
    if (!targetKeys.has(key)) addedKeys.add(key);
  }
  return { attachments, added: addedKeys.size };
}

export function mergeCardItems(target: readonly CardItem[], sources: readonly CardRow[]): { items: CardItem[]; itemIdMap: Map<string, number> } {
  const items = (target ?? []).map(item => ({ ...item }));
  let nextId = Math.max(0, ...items.map(item => item.id)) + 1;
  const itemIdMap = new Map<string, number>();
  for (const source of sources) for (const item of source.items ?? []) {
    itemIdMap.set(`${source.id}:${item.id}`, nextId);
    items.push({ ...item, id: nextId++ });
  }
  return { items, itemIdMap };
}

/** "#T 카드에 합쳐 닫았습니다" stays within makeCardNow's 60-code-point limit. */
export function mergedCloseNow(target: CardRow, at: string, sessionId: string | null) {
  return makeCardNow({ text: `${cardLabel(target)} 카드에 합쳐 닫았습니다`, turn: "outside" }, at, sessionId);
}
