import type { Node, ValidationIssue } from '@soulstream/chat-ui';
import type { McpRuntime } from '../runtime.js';

export async function validateChatUiImages(nodes: Node[], runtime: McpRuntime, sessionId: string, commandId: string | undefined, signal: AbortSignal): Promise<{ ids: string[]; errors: ValidationIssue[] }> {
  const images: Array<{ id: string; path: string }> = [];
  const collect = (items: Node[], path: string) => items.forEach((node, index) => {
    const current = `${path}[${index}]`;
    if (node.kind === 'image') images.push({ id: node.attachment_id, path: `${current}.attachment_id` });
    if (node.kind === 'group') collect(node.children, `${current}.children`);
  });
  collect(nodes, 'body');
  if (!images.length) return { ids: [], errors: [] };
  const service = runtime.producedAttachments;
  if (!commandId || !service?.validateSessionOutput) return { ids: [], errors: images.map(image => ({ path: image.path, reason: '현재 실행의 첨부를 검증할 수 없습니다.' })) };
  const ids: string[] = [];
  const errors: ValidationIssue[] = [];
  for (const image of images) {
    if (ids.includes(image.id)) continue;
    try {
      const result = await service.validateSessionOutput({ attachment_ids: [image.id] }, { sessionId, nodeId: runtime.nodeId, outputCommandId: commandId }, signal);
      if (result.attachment_ids.length !== 1 || result.attachment_ids[0] !== image.id) throw Error('첨부 검증 응답이 일치하지 않습니다.');
      ids.push(image.id);
    } catch (error) {
      errors.push({ path: image.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ids, errors };
}
