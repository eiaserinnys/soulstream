import * as Crypto from 'expo-crypto';
import type { ApiClient } from '../api/client';

export async function savePlannerSessionDefaults(
  api: Pick<ApiClient, 'getPage' | 'applyPageOperations'>,
  pageId: string,
  input: {
    blockId: string | null;
    agentId: string;
    nodeId: string;
    modelPreset?: string | null;
  },
) {
  const agentId = input.agentId.trim();
  const nodeId = input.nodeId.trim();
  if (!agentId || !nodeId) throw new Error('노드와 에이전트를 모두 선택해 주세요.');
  const current = await api.getPage(pageId);
  const modelPreset = input.modelPreset?.trim() || null;
  const properties = {
    agentId,
    nodeId,
    ...(modelPreset ? { modelPreset } : {}),
    scope: 'session',
  };
  return api.applyPageOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: current.stateVector,
    idempotencyKey: operationId('session-defaults-save'),
    reason: 'soul-app v3 task session defaults save',
    operations: [input.blockId ? {
      op: 'update_block_type_and_properties',
      block_id: input.blockId,
      block_type: 'session_defaults',
      properties,
    } : {
      op: 'create_block',
      temp_id: operationId('session-defaults-block'),
      parent_id: null,
      after_block_id: [...current.blocks].reverse()
        .find((block) => block.parentId === null)?.id ?? null,
      block_type: 'session_defaults',
      text: '',
      properties,
      collapsed: false,
    }],
  });
}

function operationId(prefix: string): string {
  if (typeof Crypto.randomUUID !== 'function') throw new Error('UUID 생성 기능을 사용할 수 없습니다.');
  return `soul-app-v3-${prefix}-${Crypto.randomUUID()}`;
}
