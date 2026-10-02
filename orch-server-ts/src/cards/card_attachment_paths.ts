import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";

/** Worker paths are local to their upload node. No cross-node file transfer. */
export function cardAttachmentPaths(attachments: readonly CardAttachment[], nodeId: string): string[] {
  const foreign = attachments.find(attachment => attachment.nodeId !== nodeId);
  if (foreign) throw Object.assign(new Error(`첨부 “${foreign.name}”의 노드 ${foreign.nodeId}와 실행 노드 ${nodeId}가 다릅니다.`), {code:"NODE_REJECTED"});
  return attachments.map(attachment => attachment.path);
}
