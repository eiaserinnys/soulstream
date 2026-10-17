import type { AttachmentRef } from "@soulstream/wire-schema/attachments";
import { normalizeAttachmentLegacyPath } from "../attachments/attachment_read_service.js";
import { requireCardAttachmentTx } from "./card_attachment_policy.js";
import type { FolderActorParams, RepositorySql } from "./control_plane/card_types.js";

// 카드 source에 남은 legacy /api/attachments/files URL을 resolved alias로 실제 asset에 연결한다. 원형은 보존한다.
const LEGACY_FILE_PATH = "/api/attachments/files";

export type CardLegacyLocation = { nodeId: string; path: string };
export type CardLegacyAttachmentRef = AttachmentRef & { legacy_url: string };
type MarkdownLegacyTarget = {
  start: number;
  end: number;
  location: CardLegacyLocation;
  wrapped: boolean;
};
type TextRange = { start: number; end: number };

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
  if (input.format === "html") {
    for (const target of htmlTargets(input.body)) add(parseCardLegacyFileUrl(target));
  } else {
    for (const target of markdownLegacyTargets(input.body)) add(target.location);
  }
  return order.map((key) => chosen.get(key)!);
}

export function rewriteMarkdownLegacySourceUrls(
  body: string,
  resolve: (location: CardLegacyLocation) => string | null,
): string {
  const targets = markdownLegacyTargets(body);
  let result = body;
  for (const target of [...targets].reverse()) {
    const projected = resolve(target.location);
    if (projected === null) continue;
    const replacement = target.wrapped ? `<${projected}>` : projected;
    result = result.slice(0, target.start) + replacement + result.slice(target.end);
  }
  return result;
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
function markdownLegacyTargets(body: string): MarkdownLegacyTarget[] {
  const codeRanges = markdownCodeRanges(body);
  const targets: MarkdownLegacyTarget[] = [];
  const seen = new Set<string>();
  const add = (start: number, end: number, raw: string): void => {
    if (codeRanges.some((range) => rangesOverlap(range, { start, end }))) return;
    const location = parseCardLegacyFileUrl(raw);
    if (location === null) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ start, end, location, wrapped: raw.startsWith("<") && raw.endsWith(">") });
  };

  for (const match of body.matchAll(/(!?\[[^\]\n]*\]\(\s*)(<[^<>\n]*>|[^()\s]+)/g)) {
    if (match[1] !== undefined && match[2] !== undefined && match.index !== undefined) {
      const start = match.index + match[1].length;
      add(start, start + match[2].length, match[2]);
    }
  }
  for (const line of linesWithOffsets(body)) {
    const match = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/.exec(line.text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const start = line.start + match[1].length;
      add(start, start + match[2].length, match[2]);
    }
  }
  for (const match of body.matchAll(/<([^<>\s]+)>/g)) {
    if (match[0] !== undefined && match.index !== undefined)
      add(match.index, match.index + match[0].length, match[0]);
  }
  return targets.sort((left, right) => left.start - right.start);
}
function htmlTargets(body: string): string[] {
  const targets: string[] = [];
  for (const match of body.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) targets.push(value.replace(/&amp;/g, "&"));
  }
  return targets;
}
export function parseCardLegacyFileUrl(raw: string): CardLegacyLocation | null {
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
function markdownCodeRanges(body: string): TextRange[] {
  const fenced: TextRange[] = [];
  let opening: { character: string; length: number; start: number } | null = null;
  for (const line of linesWithOffsets(body)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (opening === null) {
      if (marker?.[1] !== undefined) {
        const character = marker[1][0]!;
        if (character !== "`" || !marker[2]!.includes("`")) {
          opening = { character, length: marker[1].length, start: line.start };
        }
      }
      continue;
    }

    const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.text);
    if (closing?.[1] !== undefined
      && closing[1][0] === opening.character
      && closing[1].length >= opening.length) {
      fenced.push({ start: opening.start, end: line.fullEnd });
      opening = null;
    }
  }
  if (opening !== null) fenced.push({ start: opening.start, end: body.length });

  const inline: TextRange[] = [];
  let segmentStart = 0;
  for (const fence of fenced) {
    inline.push(...inlineCodeRanges(body, segmentStart, fence.start));
    segmentStart = fence.end;
  }
  inline.push(...inlineCodeRanges(body, segmentStart, body.length));
  return [...fenced, ...inline].sort((left, right) => left.start - right.start);
}

function inlineCodeRanges(body: string, start: number, end: number): TextRange[] {
  const runs: Array<TextRange & { length: number }> = [];
  const segment = body.slice(start, end);
  for (const match of segment.matchAll(/`+/g)) {
    if (match.index === undefined || match[0] === undefined) continue;
    const runStart = start + match.index;
    if (isEscapedBacktick(body, runStart)) continue;
    runs.push({ start: runStart, end: runStart + match[0].length, length: match[0].length });
  }

  const ranges: TextRange[] = [];
  let index = 0;
  while (index < runs.length) {
    let closing = index + 1;
    while (closing < runs.length && runs[closing]!.length !== runs[index]!.length) closing += 1;
    if (closing === runs.length) {
      index += 1;
      continue;
    }
    ranges.push({ start: runs[index]!.start, end: runs[closing]!.end });
    index = closing + 1;
  }
  return ranges;
}

function linesWithOffsets(body: string): Array<{ text: string; start: number; fullEnd: number }> {
  const lines: Array<{ text: string; start: number; fullEnd: number }> = [];
  let start = 0;
  while (start <= body.length) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline;
    const contentEnd = end > start && body[end - 1] === "\r" ? end - 1 : end;
    lines.push({ text: body.slice(start, contentEnd), start, fullEnd: newline === -1 ? body.length : newline + 1 });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

function isEscapedBacktick(body: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && body[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
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
