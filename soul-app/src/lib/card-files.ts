import type { CardAttachment } from '../../../packages/wire-schema/src/card_attachments';
import type { ChatAttachment } from '../hooks/useChatAttachments';

export function cardFiles(files: readonly ChatAttachment[]): CardAttachment[] {
  return files.map(({ path, name, nodeId, mimeType }) => ({ path, name, nodeId: nodeId!, mimeType: mimeType ?? 'application/octet-stream' }));
}
