import type { AttachmentEventSignalFields } from "../shared/tree-nodes";

interface AttachmentEventWireFields {
  attachment_ids?: string[];
  attachment_count?: number;
  attachments?: string[];
  node_id?: string;
}

export interface AttachmentMessageSignalFields extends AttachmentEventSignalFields {
  attachmentDisplayIds?: readonly string[];
}

export function mapAttachmentEventSignals(event: AttachmentEventWireFields): AttachmentEventSignalFields {
  return {
    ...(event.attachment_ids !== undefined ? { attachmentIds: event.attachment_ids } : {}),
    ...(event.attachment_count !== undefined ? { attachmentCount: event.attachment_count } : {}),
    ...(event.attachments !== undefined ? { attachmentPaths: event.attachments } : {}),
    ...(event.node_id !== undefined ? { attachmentNodeId: event.node_id } : {}),
  };
}

export function mapAttachmentMessageSignals(
  signals: AttachmentEventSignalFields,
  includeDisplayIds = false,
): AttachmentMessageSignalFields {
  return {
    ...(signals.attachmentIds !== undefined ? { attachmentIds: signals.attachmentIds } : {}),
    ...(signals.attachmentCount !== undefined ? { attachmentCount: signals.attachmentCount } : {}),
    ...(signals.attachmentPaths !== undefined ? { attachmentPaths: signals.attachmentPaths } : {}),
    ...(signals.attachmentNodeId !== undefined ? { attachmentNodeId: signals.attachmentNodeId } : {}),
    ...(includeDisplayIds && signals.attachmentIds !== undefined
      ? { attachmentDisplayIds: signals.attachmentIds }
      : {}),
  };
}

export function sameAttachmentMessageSignals(
  a: AttachmentMessageSignalFields,
  b: AttachmentMessageSignalFields,
): boolean {
  return a.attachmentIds === b.attachmentIds
    && a.attachmentCount === b.attachmentCount
    && a.attachmentPaths === b.attachmentPaths
    && a.attachmentNodeId === b.attachmentNodeId
    && a.attachmentDisplayIds === b.attachmentDisplayIds;
}
