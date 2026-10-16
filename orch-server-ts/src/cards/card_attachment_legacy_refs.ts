import type { AttachmentRef } from "@soulstream/wire-schema/attachments";
import { normalizeAttachmentLegacyPath } from "../attachments/attachment_read_service.js";
import { requireCardAttachmentTx } from "./card_attachment_policy.js";
import type { FolderActorParams, RepositorySql } from "./control_plane/card_types.js";

// 카드 source에 남은 legacy /api/attachments/files URL을 resolved alias로 실제 asset에 연결한다. 원형은 보존한다.
const LEGACY_FILE_PATH = "/api/attachments/files";

export type CardLegacyLocation = { nodeId: string; path: string };
export type CardLegacyAttachmentRef = AttachmentRef & { legacy_url: string };

export function collectCardLegacyLocations(input: {
  body: string;
  format: "markdown" | "html";
  attachments?: readonly unknown[];
}): CardLegacyLocation[] {
  const order: string[] = [];
  const chosen = new Map<string, CardLegacyLocation>();
  const add = (location: CardLegacyLocation | null): void => {
    if (location === null) return;
    const key = `${location.nodeId}\u0000${location.path}`;
    if (!chosen.has(key)) { order.push(key); chosen.set(key, location); }
  };
  for (const attachment of input.attachments ?? []) {
    if (!isRecord(attachment)) continue;
    const nodeId = typeof attachment.nodeId === "string" ? attachment.nodeId : "";
    const path = typeof attachment.path === "string" ? attachment.path : "";
    if (nodeId.length === 0 || path.length === 0) continue;
    add({ nodeId, path: normalizeAttachmentLegacyPath(path) });
  }
  for (const target of input.format === "html" ? htmlTargets(input.body) : markdownTargets(input.body)) {
    add(parseLegacyFileUrl(target));
  }
  return order.map((key) => chosen.get(key)!);
}
export async function resolveCardLegacySourceRefsTx(
  sql: RepositorySql,
  input: {
    cardId: string;
    assigneeSessionId: string | null;
    actor: FolderActorParams;
    body: string;
    format: "markdown" | "html";
    attachments?: readonly unknown[];
  },
): Promise<CardLegacyAttachmentRef[]> {
  const locations = collectCardLegacyLocations({
    body: input.body,
    format: input.format,
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  });
  if (locations.length === 0) return [];
  const order: string[] = [];
  const origins = new Map<string, CardLegacyLocation>();
  for (const location of locations) {
    const rows = await sql<{ asset_id: unknown; availability: unknown }[]>`
      SELECT asset_id, availability FROM attachment_legacy_aliases
      WHERE node_id = ${location.nodeId} AND normalized_path = ${location.path} LIMIT 1`;
    const row = rows[0];
    if (row === undefined || row.availability !== "resolved") continue;
    const assetId = typeof row.asset_id === "string" ? row.asset_id : "";
    if (assetId.length === 0) throw legacyError(422, "ATTACHMENT_INVALID_LEGACY_ALIAS");
    if (!origins.has(assetId)) { order.push(assetId); origins.set(assetId, location); }
  }
  const refs: CardLegacyAttachmentRef[] = [];
  for (const assetId of order) {
    await authorizeLegacyAssetTx(sql, input, assetId);
    refs.push({ attachment_id: assetId, legacy_url: legacyRelativeUrl(origins.get(assetId)!) });
  }
  return refs;
}
export function mergeCardSourceAttachmentRefs(
  idRefs: readonly AttachmentRef[],
  legacyRefs: readonly CardLegacyAttachmentRef[],
): AttachmentRef[] {
  const order: string[] = [];
  const chosen = new Map<string, Record<string, unknown>>();
  const add = (ref: Record<string, unknown>): void => {
    const id = typeof ref.attachment_id === "string" ? ref.attachment_id : "";
    if (id.length === 0) return;
    const existing = chosen.get(id);
    if (existing === undefined) { order.push(id); chosen.set(id, ref); return; }
    if (Object.keys(existing).length === 1 && Object.keys(ref).length > 1) chosen.set(id, ref);
  };
  for (const ref of idRefs) add(ref as unknown as Record<string, unknown>);
  for (const ref of legacyRefs) add(ref as unknown as Record<string, unknown>);
  return order.map((id) => chosen.get(id)!) as unknown as AttachmentRef[];
}

async function authorizeLegacyAssetTx(
  sql: RepositorySql,
  input: { cardId: string; assigneeSessionId: string | null; actor: FolderActorParams },
  assetId: string,
): Promise<void> {
  if (input.actor.actorKind === "agent") {
    const sessionId = input.actor.actorSessionId;
    if (sessionId === null || sessionId.length === 0) throw legacyError(403, "ATTACHMENT_LINK_DENIED");
    await requireCardAttachmentTx(sql, { id: input.cardId, assignee_session_id: input.assigneeSessionId }, { sessionId }, assetId, "link");
    return;
  }
  if (input.actor.actorKind !== "user") throw legacyError(403, "ATTACHMENT_LINK_DENIED");
  const email = normalizeEmail(input.actor.actorUserId ?? "");
  if (email.length === 0) throw legacyError(403, "ATTACHMENT_LINK_DENIED");
  const rows = await sql<{ owner_kind: unknown; owner_key: unknown; registration_scope: unknown; upload_status: unknown }[]>`
    SELECT owner_kind, owner_key, registration_scope, upload_status FROM file_assets
    WHERE id = ${assetId} AND storage_purpose = 'attachment' AND garbage_collected_at IS NULL LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw legacyError(404, "ATTACHMENT_NOT_FOUND");
  if (row.upload_status !== "committed") throw legacyError(409, "ATTACHMENT_NOT_COMMITTED");
  if (row.owner_kind !== "user_email" || typeof row.owner_key !== "string" || normalizeEmail(row.owner_key) !== email)
    throw legacyError(403, "ATTACHMENT_LINK_DENIED");
  if (!userLegacyScopeAllowed(row.registration_scope, input.cardId)) throw legacyError(403, "ATTACHMENT_LINK_DENIED");
}// scope 없음/session/folder는 업로드 문맥으로 보고, card scope는 현재 카드와 같아야 한다.
function userLegacyScopeAllowed(scope: unknown, cardId: string): boolean {
  if (scope === null || scope === undefined) return true;
  if (!isRecord(scope)) return false;
  if (scope.type === "session" || scope.type === "folder") return true;
  if (scope.type === "card") return typeof scope.id === "string" && scope.id === cardId;
  return false;
}
function markdownTargets(body: string): string[] {
  const text = stripFencedBlocks(body);
  const targets: string[] = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]+)/g)) if (match[1]) targets.push(match[1]);
  for (const match of text.matchAll(/<([^<>\s]+)>/g)) if (match[1]) targets.push(match[1]);
  for (const match of text.matchAll(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(\S+)/gm)) if (match[1]) targets.push(match[1]);
  return targets;
}
function htmlTargets(body: string): string[] {
  const targets: string[] = [];
  for (const match of body.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) targets.push(value.replace(/&amp;/g, "&"));
  }
  return targets;
}
function parseLegacyFileUrl(raw: string): CardLegacyLocation | null {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0 || value.slice(0, queryIndex) !== LEGACY_FILE_PATH) return null;
  const params = new URLSearchParams(value.slice(queryIndex + 1));
  const nodeIds = params.getAll("nodeId");
  const paths = params.getAll("path");
  if (nodeIds.length !== 1 || paths.length !== 1) return null;
  const nodeId = nodeIds[0]!;
  const path = paths[0]!;
  if (nodeId.length === 0 || path.length === 0) return null;
  return { nodeId, path: normalizeAttachmentLegacyPath(path) };
}
function legacyRelativeUrl(location: CardLegacyLocation): string {
  const params = new URLSearchParams();
  params.set("nodeId", location.nodeId);
  params.set("path", location.path);
  return `${LEGACY_FILE_PATH}?${params.toString()}`;
}
function stripFencedBlocks(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker?.[1]) { fence = marker[1][0]!; continue; }
      kept.push(line);
      continue;
    }
    if (marker?.[1] && marker[1][0] === fence) fence = null;
  }
  return kept.join("\n");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
const LEGACY_MESSAGES = {
  ATTACHMENT_LINK_DENIED: "이 첨부를 카드에 연결할 수 없습니다.",
  ATTACHMENT_NOT_FOUND: "첨부를 찾을 수 없습니다.",
  ATTACHMENT_NOT_COMMITTED: "아직 커밋되지 않은 첨부입니다.",
  ATTACHMENT_INVALID_LEGACY_ALIAS: "legacy 첨부 별칭을 확인할 수 없습니다.",
};
function legacyError(statusCode: number, code: keyof typeof LEGACY_MESSAGES): Error {
  return Object.assign(new Error(LEGACY_MESSAGES[code]), { statusCode, code });
}
