import type { CardItemEvidence } from "@seosoyoung/soul-ui/cards/card-types";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";

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
