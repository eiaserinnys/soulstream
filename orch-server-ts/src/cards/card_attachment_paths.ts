import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";
import type { AdmittedAttachmentInput } from "../attachments/attachment_input_admission.js";

/** Worker paths are local to their upload node; foreign paths are imported first. */
export function cardAttachmentPaths(attachments: readonly CardAttachment[], nodeId: string): string[] {
  const foreign = attachments.find(attachment => attachment.nodeId !== nodeId);
  if (foreign) throw Object.assign(new Error(`첨부 “${foreign.name}”의 노드 ${foreign.nodeId}와 실행 노드 ${nodeId}가 다릅니다.`), {code:"NODE_REJECTED"});
  return attachments.map(attachment => attachment.path);
}

export async function prepareCardAttachmentInput(
  attachments: readonly CardAttachment[],
  targetNodeId: string,
  options: {
    cardId: string;
    admitSource: (input: { cardId: string; sourceNodeId: string; attachmentPaths: string[] }) => Promise<AdmittedAttachmentInput>;
    /** Session that owns the central asset created by a foreign-attachment import. */
    sourceSessionId?: string;
    importSource?: (input: {
      cardId: string;
      sourceNodeId: string;
      sourceSessionId: string;
      path: string;
      name: string;
      mimeType: string;
    }) => Promise<AttachmentPathBinding>;
  },
): Promise<AdmittedAttachmentInput> {
  const attachmentIds: string[] = [];
  const attachmentPaths: string[] = [];
  const attachmentBindings: AttachmentPathBinding[] = [];
  const seenIds = new Set<string>();
  const seenBindings = new Set<string>();

  for (const attachment of attachments) {
    const admitted = await options.admitSource({
      cardId: options.cardId,
      sourceNodeId: attachment.nodeId,
      attachmentPaths: [attachment.path],
    });
    const binding = admitted.attachment_bindings.find(item =>
      item.node_id === attachment.nodeId && item.path === attachment.path);

    if (binding) {
      if (!seenIds.has(binding.attachment_id)) {
        seenIds.add(binding.attachment_id);
        attachmentIds.push(binding.attachment_id);
      }
      const bindingKey = `${binding.attachment_id}\u0000${binding.node_id}\u0000${binding.path}`;
      if (!seenBindings.has(bindingKey)) {
        seenBindings.add(bindingKey);
        attachmentBindings.push(binding);
      }
      continue;
    }

    if (attachment.nodeId !== targetNodeId) {
      const imported = options.importSource && options.sourceSessionId
        ? await options.importSource({
            cardId: options.cardId,
            sourceNodeId: attachment.nodeId,
            sourceSessionId: options.sourceSessionId,
            path: attachment.path,
            name: attachment.name,
            mimeType: attachment.mimeType,
          })
        : null;
      if (imported === null) {
        cardAttachmentPaths([attachment], targetNodeId);
        continue;
      }
      if (!seenIds.has(imported.attachment_id)) {
        seenIds.add(imported.attachment_id);
        attachmentIds.push(imported.attachment_id);
      }
      const bindingKey = `${imported.attachment_id}\u0000${imported.node_id}\u0000${imported.path}`;
      if (!seenBindings.has(bindingKey)) {
        seenBindings.add(bindingKey);
        attachmentBindings.push(imported);
      }
      continue;
    }
    attachmentPaths.push(attachment.path);
  }

  return {
    attachment_ids: attachmentIds,
    attachment_paths: attachmentPaths,
    attachment_bindings: attachmentBindings,
  };
}
