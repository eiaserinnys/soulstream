import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import { projectAttachmentDescriptor, type AttachmentAssetRow } from "../attachments/attachment_read_service.js";
import {
  collectCardLegacyLocations,
  rewriteMarkdownLegacySourceUrls,
  type CardLegacyLocation,
} from "./card_attachment_legacy_refs.js";
import { attachmentRefIds, attachmentRefsOf, cardAttachmentIdLinks } from "./card_attachment_refs.js";
import type { RepositorySql } from "./control_plane/card_types.js";

export type CardEvidenceReadContext = { type: "card"; id: string };

export type CardAssetEvidenceView =
  | {
      type: "image" | "link";
      label: string;
      url: string;
      attachment_id: string;
      descriptor: AttachmentDescriptor;
      read_context: CardEvidenceReadContext;
      previewUrl: string | null;
      originalUrl: string;
    }
  | {
      type: "image" | "link";
      label: string;
      url: "";
      attachment_id: string;
      read_context: CardEvidenceReadContext;
      availability: "missing" | "unavailable";
      previewUrl: null;
      originalUrl: "";
    };

type AssetProjectionRow = {
  id: string;
  original_name: string;
  mime_type: string;
  byte_size: number | string;
  width: number | null;
  height: number | null;
  checksum_sha256: string | null;
  upload_status: string;
};
type LegacySourceBody = {
  rowIndex: number;
  field: "request" | "body";
  cardId: string;
  body: string;
  sourceIds: ReadonlySet<string>;
};
type LegacyAliasProjection = { assetId: unknown; availability: unknown };

export function cardAttachmentUrls(
  cardId: string,
  id: string,
  descriptor: AttachmentDescriptor,
): { previewUrl: string | null; originalUrl: string } {
  const content = "/api/attachments/" + encodeURIComponent(id) + "/content?context_type=card&context_id=" + encodeURIComponent(cardId);
  return {
    previewUrl: descriptor.preview_kind === "image" ? content : null,
    originalUrl: content + "&download=true",
  };
}

export async function projectCardAttachmentRows<T extends Record<string, unknown>>(
  sql: RepositorySql,
  rows: readonly T[],
  cardId?: string,
  allowedOrigins: readonly string[] = [],
): Promise<T[]> {
  const cardIds = rows.map((row) => cardId ?? stringValue(row.card_id) ?? stringValue(row.id));
  const refs = rows.map((row) => attachmentRefIds(attachmentRefsOf(row.attachment_refs)));
  const ids = new Set<string>();

  rows.forEach((row, index) => {
    const currentRefs = refs[index]!;
    for (const item of Array.isArray(row.items) ? row.items : []) {
      for (const evidence of evidenceOf(item)) {
        if (isRecord(evidence) && typeof evidence.attachment_id === "string" && currentRefs.has(evidence.attachment_id))
          ids.add(evidence.attachment_id);
      }
    }
    for (const body of sourceBodies(row)) {
      if (body.format === "html") continue;
      for (const id of cardAttachmentIdLinks(body.text)) {
        if (currentRefs.has(id)) ids.add(id);
      }
    }
  });

  const assets = new Map<string, AttachmentAssetRow>();
  if (ids.size > 0) {
    const found = await sql<AssetProjectionRow[]>`
      SELECT id,original_name,mime_type,byte_size,width,height,checksum_sha256,upload_status
      FROM file_assets
      WHERE id=ANY(${[...ids]}::text[])
    `;
    for (const row of found) {
      assets.set(row.id, {
        id: row.id,
        storageKey: "",
        storagePurpose: "attachment",
        storageEndpoint: null,
        storageBucket: null,
        ownerKind: null,
        ownerKey: null,
        registrationScope: null,
        sourceSessionId: null,
        originalName: row.original_name,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        width: row.width,
        height: row.height,
        checksumSha256: row.checksum_sha256,
        uploadStatus: row.upload_status === "committed" ? "committed" : "pending",
      });
    }
  }

  const projectedRows: Array<Record<string, unknown>> = rows.map((row) => ({ ...row }));
  const legacySources: LegacySourceBody[] = [];
  rows.forEach((row, index) => {
    const currentCardId = cardIds[index];
    if (!currentCardId) return;
    const projected = projectedRows[index]!;
    const currentRefs = refs[index]!;
    if (Array.isArray(row.items)) {
      projected.items = row.items.map((item) => projectItem(item, currentCardId, currentRefs, assets));
    }
    if (typeof row.request === "string") {
      const body = projectSourceBody(row.request, currentCardId, currentRefs);
      projected.request = body;
      if (currentRefs.size > 0) legacySources.push({
        rowIndex: index, field: "request", cardId: currentCardId, body, sourceIds: currentRefs,
      });
    }
    if (typeof row.body === "string" && row.format !== "html") {
      const body = projectSourceBody(row.body, currentCardId, currentRefs);
      projected.body = body;
      if (currentRefs.size > 0) legacySources.push({
        rowIndex: index, field: "body", cardId: currentCardId, body, sourceIds: currentRefs,
      });
    }
  });

  const locations = new Map<string, CardLegacyLocation>();
  for (const source of legacySources) {
    for (const location of collectCardLegacyLocations({
      body: source.body,
      format: "markdown",
      allowedOrigins,
    })) {
      locations.set(cardLegacyLocationKey(location), location);
    }
  }
  const aliases = await readCardLegacyAliases(sql, [...locations.values()]);
  for (const source of legacySources) {
    projectedRows[source.rowIndex]![source.field] = rewriteMarkdownLegacySourceUrls(source.body, (location) => {
      const alias = aliases.get(cardLegacyLocationKey(location));
      if (alias?.availability !== "resolved" || typeof alias.assetId !== "string"
        || !source.sourceIds.has(alias.assetId)) return null;
      return "/api/attachments/" + encodeURIComponent(alias.assetId) + "/content?context_type=card&context_id=" +
        encodeURIComponent(source.cardId);
    }, allowedOrigins);
  }
  return projectedRows as T[];
}

function cardLegacyLocationKey(location: CardLegacyLocation): string {
  return `${location.nodeId}\u0000${location.path}`;
}

async function readCardLegacyAliases(
  sql: RepositorySql,
  locations: readonly CardLegacyLocation[],
): Promise<Map<string, LegacyAliasProjection>> {
  const aliases = new Map<string, LegacyAliasProjection>();
  if (locations.length === 0) return aliases;
  const rows = await sql<{
    node_id: unknown;
    normalized_path: unknown;
    asset_id: unknown;
    availability: unknown;
  }[]>`
    SELECT aliases.node_id, aliases.normalized_path, aliases.asset_id, aliases.availability
    FROM attachment_legacy_aliases AS aliases
    JOIN unnest(${locations.map((location) => location.nodeId)}::text[],
                ${locations.map((location) => location.path)}::text[])
      AS requested(node_id, normalized_path)
      ON requested.node_id = aliases.node_id
     AND requested.normalized_path = aliases.normalized_path
  `;
  for (const row of rows) {
    if (typeof row.node_id !== "string" || typeof row.normalized_path !== "string") continue;
    aliases.set(cardLegacyLocationKey({ nodeId: row.node_id, path: row.normalized_path }), {
      assetId: row.asset_id,
      availability: row.availability,
    });
  }
  return aliases;
}

function projectItem(
  item: unknown,
  cardId: string,
  refs: ReadonlySet<string>,
  assets: ReadonlyMap<string, AttachmentAssetRow>,
): unknown {
  if (!isRecord(item) || !Array.isArray(item.evidence)) return item;
  return {
    ...item,
    evidence: item.evidence.map((entry) => {
      if (!isRecord(entry)
        || (entry.type !== "image" && entry.type !== "link")
        || typeof entry.label !== "string"
        || typeof entry.attachment_id !== "string"
        || !refs.has(entry.attachment_id)) return entry;
      return projectEvidence(entry.type, entry.label, entry.attachment_id, cardId, assets.get(entry.attachment_id));
    }),
  };
}

function projectEvidence(
  type: "image" | "link",
  label: string,
  attachmentId: string,
  cardId: string,
  asset: AttachmentAssetRow | undefined,
): CardAssetEvidenceView {
  const readContext = { type: "card" as const, id: cardId };
  if (asset === undefined) {
    return {
      type, label, url: "", attachment_id: attachmentId, read_context: readContext,
      availability: "missing", previewUrl: null, originalUrl: "",
    };
  }
  if (asset.uploadStatus !== "committed") {
    return {
      type, label, url: "", attachment_id: attachmentId, read_context: readContext,
      availability: "unavailable", previewUrl: null, originalUrl: "",
    };
  }

  const descriptor = projectAttachmentDescriptor(asset);
  const urls = cardAttachmentUrls(cardId, attachmentId, descriptor);
  return {
    type, label, url: type === "image" ? urls.previewUrl ?? urls.originalUrl : urls.originalUrl,
    attachment_id: attachmentId, descriptor, read_context: readContext,
    previewUrl: urls.previewUrl, originalUrl: urls.originalUrl,
  };
}

function projectSourceBody(body: string, cardId: string, refs: ReadonlySet<string>): string {
  const eligibleIds = new Set(cardAttachmentIdLinks(body).filter((id) => refs.has(id)));
  if (eligibleIds.size === 0) return body;
  let fence: string | null = null;
  return body.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker?.[1]) {
        fence = marker[1][0]!;
        return line;
      }
      return rewriteMarkdownLine(line, cardId, eligibleIds);
    }
    if (marker?.[1] && marker[1][0] === fence) fence = null;
    return line;
  }).join("\n");
}

function rewriteMarkdownLine(line: string, cardId: string, ids: ReadonlySet<string>): string {
  const rewrite = (raw: string): string => {
    const wrapped = raw.startsWith("<") && raw.endsWith(">");
    const value = wrapped ? raw.slice(1, -1) : raw;
    const hash = value.indexOf("#");
    const withoutHash = hash < 0 ? value : value.slice(0, hash);
    const query = withoutHash.indexOf("?");
    const path = query < 0 ? withoutHash : withoutHash.slice(0, query);
    const match = /^\/api\/attachments\/([A-Za-z0-9_-]+)\/content$/.exec(path);
    if (!match || !ids.has(match[1]!)) return raw;
    const content = "/api/attachments/" + encodeURIComponent(match[1]!) + "/content?context_type=card&context_id=" + encodeURIComponent(cardId);
    return wrapped ? `<${content}>` : content;
  };

  // Same destination grammar as the source-ref validator (card_attachment_refs
  // sourceTargets): an inline link may carry a title before ")", so the
  // closing paren is not part of the match.
  return line
    .replace(/(!?\[[^\]\n]*\]\(\s*)(<[^<>\n]*>|[^()\s]+)/g,
      (_whole, prefix: string, destination: string) => prefix + rewrite(destination))
    .replace(/^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/,
      (_whole, prefix: string, destination: string) => prefix + rewrite(destination))
    .replace(/<([^<>\s]+)>/g,
      (_whole, destination: string) => `<${rewrite(destination)}>`);
}

function sourceBodies(row: Record<string, unknown>): { text: string; format?: string }[] {
  const bodies: { text: string; format?: string }[] = [];
  if (typeof row.request === "string") bodies.push({ text: row.request });
  if (typeof row.body === "string") bodies.push({
    text: row.body,
    ...(typeof row.format === "string" ? { format: row.format } : {}),
  });
  return bodies;
}

function evidenceOf(item: unknown): unknown[] {
  return isRecord(item) && Array.isArray(item.evidence) ? item.evidence : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
