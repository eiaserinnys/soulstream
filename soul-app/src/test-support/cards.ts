import type { CardDto } from '../api/cardTypes';
// Mirrors serializeCardRow's camelCase JSON, including explicit nullable fields.
export function cardFixture(overrides: Partial<CardDto> = {}): CardDto {
  return { id: 'card-1', folderId: 'folder-1', title: '카드 제목', request: '요청 원문', brief: '',
    status: 'todo', positionKey: 'a', queuePositionKey: null, blockedKind: null, blockedDetail: null,
    assigneeKind: 'agent', assigneeAgentId: 'roselin', assigneeSessionId: null, assigneeUserId: null,
    nodeId: 'node-1', modelPreset: 'sol', archived: false, version: 1,
    createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z', ...overrides };
}
