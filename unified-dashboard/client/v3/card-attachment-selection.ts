import type { CardItemEvidence } from "@seosoyoung/soul-ui/cards/card-types";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
export type AttachmentReadContext = Extract<ChatAttachmentItem["source"], { kind: "asset" }>["context"];

export function cardAttachmentSelectionFromEvidence(_evidence: CardItemEvidence): ChatAttachmentItem | null {
  const attachmentId = _evidence.attachment_id;
  const context = _evidence.read_context;
  if (!attachmentId || !context || context.type !== "card") return null;

  const descriptor = _evidence.descriptor;
  if (_evidence.availability) {
    return {
      key: `asset:${attachmentId}`,
      name: descriptor?.name ?? null,
      mimeType: descriptor?.mime_type ?? null,
      byteSize: descriptor?.byte_size ?? null,
      previewKind: descriptor?.preview_kind ?? "info",
      availability: _evidence.availability,
      previewUrl: null,
      originalUrl: null,
      legacySources: [],
      source: { kind: "unavailable", attachmentId, context },
    };
  }
  if (!descriptor) return null;

  return {
    key: `asset:${attachmentId}`,
    name: descriptor.name,
    mimeType: descriptor.mime_type,
    byteSize: descriptor.byte_size,
    previewKind: descriptor.preview_kind,
    availability: "ready",
    previewUrl: _evidence.previewUrl ?? null,
    originalUrl: _evidence.originalUrl ?? null,
    legacySources: [],
    source: { kind: "asset", attachmentId, context },
  };
}

export function cardAttachmentSelectionFromUrl(
  url: string,
  currentCardId: string,
  origin: string,
): { attachmentId: string; context: AttachmentReadContext } | null {
  let parsed: URL;
  let expectedOrigin: string;
  try {
    parsed = new URL(url, origin);
    expectedOrigin = new URL(origin).origin;
  } catch {
    return null;
  }
  if (parsed.origin !== expectedOrigin) return null;
  const match = /^\/api\/attachments\/([^/]+)\/content$/.exec(parsed.pathname);
  if (!match) return null;
  const context = attachmentContextFromUrl(parsed, currentCardId);
  if (!context) return null;
  let attachmentId: string;
  try {
    attachmentId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!attachmentId.trim()) return null;
  return { attachmentId, context };
}

export function cardLegacyAttachmentSelectionFromUrl(
  url: string,
  currentCardId: string,
  origin: string,
): { nodeId: string; path: string; context: AttachmentReadContext } | null {
  let parsed: URL;
  let expectedOrigin: string;
  try {
    parsed = new URL(url, origin);
    expectedOrigin = new URL(origin).origin;
  } catch {
    return null;
  }
  if (parsed.origin !== expectedOrigin || parsed.pathname !== "/api/attachments/files") return null;
  const nodeIds = parsed.searchParams.getAll("nodeId");
  const paths = parsed.searchParams.getAll("path");
  if (nodeIds.length !== 1 || !nodeIds[0]?.trim() || paths.length !== 1 || !paths[0]) return null;
  const context = attachmentContextFromUrl(parsed, currentCardId);
  return context ? { nodeId: nodeIds[0], path: paths[0], context } : null;
}

export function attachmentUrlHasContext(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === new URL(origin).origin
      && (parsed.searchParams.has("context_type") || parsed.searchParams.has("context_id"));
  } catch {
    return false;
  }
}

function attachmentContextFromUrl(parsed: URL, currentCardId: string): AttachmentReadContext | null {
  const types = parsed.searchParams.getAll("context_type");
  const ids = parsed.searchParams.getAll("context_id");
  if (types.length === 0 && ids.length === 0) {
    return currentCardId ? { type: "card", id: currentCardId } : null;
  }
  if (types.length !== 1) return null;
  const type = types[0];
  if (type === "owner") return ids.length === 0 ? { type: "owner" } : null;
  if (ids.length !== 1 || !ids[0]?.trim()) return null;
  switch (type) {
    case "session":
    case "card":
    case "page":
    case "board_item":
      return { type, id: ids[0] };
    default:
      return null;
  }
}
