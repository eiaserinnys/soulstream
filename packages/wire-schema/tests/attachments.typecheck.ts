import type {
  AttachmentDescriptor,
  AttachmentProjection,
  AttachmentReadContext,
  AttachmentRef,
  AttachmentRegistrationScope,
  AttachmentScope,
  SessionEventAttachmentResponse,
  SessionEventAttachmentView,
} from "@soulstream/wire-schema/attachments";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";

const scope: AttachmentScope = { type: "session", id: "session-1" };
const registrationScope: AttachmentRegistrationScope = { type: "folder", id: "folder-1" };
const readContext: AttachmentReadContext = { type: "owner" };
const descriptor: AttachmentDescriptor = {
  attachment_id: "asset-1",
  name: "image.png",
  mime_type: "image/png",
  byte_size: 128,
  checksum_sha256: null,
  width: 10,
  height: 10,
  preview_kind: "image",
  preview_mime_type: "image/png",
};
const attachmentRef: AttachmentRef = { attachment_id: descriptor.attachment_id };
const assetProjection: AttachmentProjection = {
  kind: "asset",
  descriptor,
  read_context: scope,
};
const unresolvedLegacyProjection: AttachmentProjection = {
  kind: "legacy",
  node_id: "node-1",
  path: "legacy/image.png",
  name: "image.png",
  mime_type: null,
  byte_size: null,
  availability: "unresolved",
};
const missingLegacyProjection: AttachmentProjection = {
  ...unresolvedLegacyProjection,
  availability: "missing",
};
const legacyCardAttachment: CardAttachment = {
  nodeId: "node-1",
  path: "legacy/image.png",
  name: "image.png",
  mimeType: "image/png",
};

const sessionReadContext: AttachmentReadContext = { type: "session", id: "session-1" };
const sessionAssetAttachment: SessionEventAttachmentView = {
  ...assetProjection,
  read_context: sessionReadContext,
  legacy_sources: [{ node_id: "node-1", path: "legacy/image.png" }],
};
const sessionLegacyAttachment: SessionEventAttachmentView = {
  ...unresolvedLegacyProjection,
  read_context: sessionReadContext,
};
const unavailableAssetAttachment: SessionEventAttachmentView = {
  kind: "unavailable",
  attachment_id: "asset-missing",
  name: null,
  availability: "unavailable",
  read_context: sessionReadContext,
};
const unavailableLegacyAttachment: SessionEventAttachmentView = {
  kind: "unavailable_legacy",
  path: "legacy/unknown-node.txt",
  name: "unknown-node.txt",
  availability: "unavailable",
  read_context: sessionReadContext,
};
const sessionEventAttachmentResponse: SessionEventAttachmentResponse = {
  event_id: 42,
  items: [
    sessionAssetAttachment,
    sessionLegacyAttachment,
    unavailableAssetAttachment,
    unavailableLegacyAttachment,
  ],
};

function assertExhaustiveAttachmentView(item: SessionEventAttachmentView): string {
  switch (item.kind) {
    case "asset":
      return item.descriptor.attachment_id;
    case "legacy":
      return item.path;
    case "unavailable":
      return item.attachment_id;
    case "unavailable_legacy":
      return item.path;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

// @ts-expect-error Session event attachment IDs use the canonical snake_case field.
const invalidAttachmentId: SessionEventAttachmentView = { ...unavailableAssetAttachment, attachmentId: "asset-1" };
// @ts-expect-error Availability belongs to the event projection, not the descriptor.
const invalidDescriptorAvailability: AttachmentDescriptor = { ...descriptor, availability: "ready" };
// @ts-expect-error Existing legacy projection node IDs remain required and non-null.
const invalidNullableLegacyNode: AttachmentProjection = { ...unresolvedLegacyProjection, node_id: null };
void [
  scope,
  registrationScope,
  readContext,
  descriptor,
  attachmentRef,
  assetProjection,
  unresolvedLegacyProjection,
  missingLegacyProjection,
  legacyCardAttachment,
  sessionReadContext,
  sessionAssetAttachment,
  sessionLegacyAttachment,
  unavailableAssetAttachment,
  unavailableLegacyAttachment,
  sessionEventAttachmentResponse,
  assertExhaustiveAttachmentView,
  invalidAttachmentId,
  invalidDescriptorAvailability,
  invalidNullableLegacyNode,
];
