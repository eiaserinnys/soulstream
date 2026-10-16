import type { AttachmentRef } from "@soulstream/wire-schema/attachments";
import { requireCardAttachmentTx } from "./card_attachment_policy.js";
import type { RepositorySql } from "./control_plane/card_types.js";

// 카드 source(요청/보고/커멘트) 본문이 가리키는 내부 첨부만 식별한다. 임의 파일 경로나
// 외부 URL, HTML은 건드리지 않고, legacy node-path URL은 다음 단위가 다룬다.
const ATTACHMENT_CONTENT_PREFIX = "/api/attachments/";
const ATTACHMENT_CONTENT_PATH = /^\/api\/attachments\/([A-Za-z0-9_-]+)\/content$/;
const CONTEXT_QUERY_KEYS = ["context_type", "context_id"];

type SourceLink = { id: string; cardId: string | null };

export function cardAttachmentIdLinks(body: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const link of scanSource(body).links) {
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    ids.push(link.id);
  }
  return ids;
}

export async function validateCardSourceRefsTx(
  sql: RepositorySql,
  input: {
    cardId: string;
    actorKind: string;
    actorSessionId: string | null;
    body: string;
    existingRefs: readonly AttachmentRef[];
  },
): Promise<AttachmentRef[]> {
  const scan = scanSource(input.body);
  if (scan.invalid) throw invalidReference("허용되지 않는 첨부 URL입니다.");

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const link of scan.links) {
    if (link.cardId !== null && link.cardId !== input.cardId)
      throw invalidReference("다른 카드의 첨부는 이 카드에서 참조할 수 없습니다.");
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    ids.push(link.id);
  }
  if (ids.length === 0) return [];

  const existing = attachmentRefIds(input.existingRefs);
  const refs: AttachmentRef[] = [];
  for (const id of ids) {
    if (existing.has(id)) {
      await assertCommittedAttachmentTx(sql, id);
    } else {
      if (input.actorKind !== "agent" || !input.actorSessionId)
        throw invalidReference("에이전트 세션만 새 첨부를 카드에 연결할 수 있습니다.");
      const card = await readCardAssigneeTx(sql, input.cardId, input.actorSessionId);
      await requireCardAttachmentTx(sql, card, { sessionId: input.actorSessionId }, id, "link");
    }
    refs.push({ attachment_id: id });
  }
  return refs;
}

// 호출자가 이미 검증한 source의 파생 색인이다. 이 함수 자체는 권한을 만들지 않는다.
export function collectCardAttachmentRefs(input: {
  request: string;
  attachments: readonly unknown[];
  items: readonly unknown[];
  previousRefs: readonly unknown[];
  previousItems: readonly unknown[];
}): AttachmentRef[] {
  const currentIds = new Set<string>();
  for (const id of cardAttachmentIdLinks(input.request)) currentIds.add(id);
  for (const attachment of input.attachments) {
    if (isRecord(attachment) && typeof attachment.attachment_id === "string")
      currentIds.add(attachment.attachment_id);
  }
  for (const item of input.items) {
    for (const id of itemAttachmentIds(item)) currentIds.add(id);
  }

  const previousItemIds = new Set<string>();
  for (const item of input.previousItems) {
    for (const id of itemAttachmentIds(item)) previousItemIds.add(id);
  }

  const order: string[] = [];
  const chosen = new Map<string, Record<string, unknown>>();
  const add = (id: string, ref: Record<string, unknown>): void => {
    if (id.length === 0) return;
    const existing = chosen.get(id);
    if (existing === undefined) {
      order.push(id);
      chosen.set(id, ref);
      return;
    }
    if (Object.keys(existing).length === 1 && Object.keys(ref).length > 1) chosen.set(id, ref);
  };

  for (const id of currentIds) add(id, { attachment_id: id });
  for (const ref of input.previousRefs) {
    if (!isRecord(ref)) continue;
    const id = typeof ref.attachment_id === "string" ? ref.attachment_id : "";
    if (Object.keys(ref).length === 1 && previousItemIds.has(id) && !currentIds.has(id)) continue;
    add(id, { ...ref });
  }
  return order.map((id) => chosen.get(id)!) as unknown as AttachmentRef[];
}

export function attachmentRefsOf(value: unknown): AttachmentRef[] {
  return (Array.isArray(value) ? value.filter(isRecord) : []) as unknown as AttachmentRef[];
}

export function attachmentRefIds(refs: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (isRecord(ref) && typeof ref.attachment_id === "string" && ref.attachment_id.length > 0)
      ids.add(ref.attachment_id);
  }
  return ids;
}

type ScanResult = { links: SourceLink[]; invalid: boolean };

function scanSource(body: string): ScanResult {
  const links: SourceLink[] = [];
  let invalid = false;
  for (const raw of sourceTargets(body)) {
    const classified = classifyTarget(raw);
    if (classified === "other") continue;
    if (classified === "invalid") {
      invalid = true;
      continue;
    }
    links.push(classified);
  }
  return { links, invalid };
}

// 코드펜스 안의 예시 URL은 링크로 세지 않는다.
function sourceTargets(body: string): string[] {
  const text = stripFencedBlocks(body);
  const targets: string[] = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]+)/g)) {
    const raw = match[1];
    if (raw) targets.push(raw);
  }
  for (const match of text.matchAll(/<([^<>\s]+)>/g)) {
    const raw = match[1];
    if (raw) targets.push(raw);
  }
  for (const match of text.matchAll(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(\S+)/gm)) {
    const raw = match[1];
    if (raw) targets.push(raw);
  }
  return targets;
}

function stripFencedBlocks(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker?.[1]) {
        fence = marker[1][0]!;
        continue;
      }
      kept.push(line);
      continue;
    }
    if (marker?.[1] && marker[1][0] === fence) fence = null;
  }
  return kept.join("\n");
}

function classifyTarget(raw: string): "other" | "invalid" | SourceLink {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  if (!value.startsWith(ATTACHMENT_CONTENT_PREFIX)) return "other";
  const queryIndex = value.indexOf("?");
  const path = queryIndex < 0 ? value : value.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : value.slice(queryIndex + 1);
  const pathMatch = ATTACHMENT_CONTENT_PATH.exec(path);
  if (!pathMatch) return "other";
  const context = classifyQuery(query);
  if (context === "invalid") return "invalid";
  return { id: pathMatch[1]!, cardId: context.cardScoped ? context.cardId : null };
}

function classifyQuery(query: string): { cardScoped: boolean; cardId: string | null } | "invalid" {
  const params = new URLSearchParams(query);
  for (const key of params.keys()) if (!CONTEXT_QUERY_KEYS.includes(key)) return "invalid";
  if (params.getAll("context_type").length > 1 || params.getAll("context_id").length > 1)
    return "invalid";
  const contextType = params.get("context_type");
  const contextId = params.get("context_id");
  if (contextType === null || contextType === "owner")
    return contextId === null ? { cardScoped: false, cardId: null } : "invalid";
  if (contextType === "card")
    return contextId !== null && contextId.length > 0
      ? { cardScoped: true, cardId: contextId }
      : "invalid";
  return "invalid";
}

function itemAttachmentIds(item: unknown): string[] {
  if (!isRecord(item)) return [];
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const ids: string[] = [];
  for (const entry of evidence) {
    if (!isRecord(entry)) continue;
    if (typeof entry.attachment_id === "string" && entry.attachment_id.length > 0)
      ids.push(entry.attachment_id);
    if (typeof entry.url === "string") {
      const classified = classifyTarget(entry.url);
      if (typeof classified === "object") ids.push(classified.id);
    }
  }
  return ids;
}

async function readCardAssigneeTx(
  sql: RepositorySql,
  cardId: string,
  fallbackSessionId: string,
): Promise<{ id: string; assignee_session_id: string | null }> {
  const rows = await sql<{ id: string; assignee_session_id: string | null }[]>`
    SELECT id, assignee_session_id FROM cards WHERE id = ${cardId} LIMIT 1
  `;
  const row = rows[0];
  // 아직 저장 전인 create_card 단계에서는 actor 세션을 담당으로 본다.
  return row ?? { id: cardId, assignee_session_id: fallbackSessionId };
}

async function assertCommittedAttachmentTx(sql: RepositorySql, id: string): Promise<void> {
  const rows = await sql<{ upload_status: string }[]>`
    SELECT upload_status FROM file_assets
    WHERE id = ${id} AND storage_purpose = 'attachment' AND garbage_collected_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined)
    throw attachmentError(404, "ATTACHMENT_NOT_FOUND", "첨부를 찾을 수 없습니다.");
  if (row.upload_status !== "committed")
    throw attachmentError(409, "ATTACHMENT_NOT_COMMITTED", "아직 커밋되지 않은 첨부입니다.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidReference(message: string): Error {
  return attachmentError(422, "ATTACHMENT_INVALID_CARD_REFERENCE", message);
}

function attachmentError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}
