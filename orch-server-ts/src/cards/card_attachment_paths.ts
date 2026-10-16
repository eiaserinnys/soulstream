import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";
import type { AdmittedAttachmentInput } from "../attachments/attachment_input_admission.js";

/** Worker paths are local to their upload node. No cross-node file transfer. */
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

    if (attachment.nodeId !== targetNodeId) cardAttachmentPaths([attachment], targetNodeId);
    attachmentPaths.push(attachment.path);
  }

  return {
    attachment_ids: attachmentIds,
    attachment_paths: attachmentPaths,
    attachment_bindings: attachmentBindings,
  };
}
