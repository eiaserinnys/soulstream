import type { CardAttachment } from '../api/cardTypes';
import type { ChatAttachment } from '../hooks/useChatAttachments';

/** Call after attachmentsReady: original files and display URLs never enter the DTO. */
export function cardFiles(files: readonly ChatAttachment[]): CardAttachment[] {
  return files.map(({ path, name, nodeId, mimeType }) => ({ path, name, nodeId: nodeId!, mimeType: mimeType ?? 'application/octet-stream' }));
}
