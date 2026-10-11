import type {
  AttachmentDescriptor,
  AttachmentProjection,
  AttachmentReadContext,
  AttachmentRef,
  AttachmentRegistrationScope,
  AttachmentScope,
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
];
