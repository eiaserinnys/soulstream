import * as Crypto from 'expo-crypto';
import type {
  PlannerBlock,
  PlannerPage,
  PlannerSessionSummary,
} from '../api/plannerTypes';
import { isPlannerDescriptionRoot } from '../lib/planner-description-blocks';

export function pendingPage(id: string, title: string): PlannerPage {
  return {
    id, title: title.trim(), dailyDate: null, version: 0, archived: false,
    metadata: { pending: true }, createdAt: '', updatedAt: '',
  };
}

export function projectDescriptionBlocks(
  blocks: PlannerBlock[],
  pageId: string,
  markdown: string,
): PlannerBlock[] {
  const descriptions = blocks.filter(isPlannerDescriptionRoot);
  const preserved = blocks.filter((block) => !descriptions.includes(block));
  return markdown.trim() ? [pendingBlock(pageId, markdown.trim()), ...preserved] : preserved;
}

export function pendingPlannerSession(
  id: string,
  input: {
    predecessorSessionId?: string;
    nodeId?: string;
    agentId?: string;
    modelPreset?: string;
  },
): PlannerSessionSummary {
  const now = new Date().toISOString();
  return {
    agentSessionId: id, folderId: null, displayName: null,
    nodeId: input.nodeId ?? null, sessionType: null, status: 'pending',
    agentId: input.agentId ?? null, predecessorSessionId: input.predecessorSessionId ?? null,
    modelPreset: input.modelPreset ?? null,
    reviewState: 'not_required', createdAt: now, updatedAt: now,
  };
}

export function pendingId(prefix: string): string {
  if (typeof Crypto.randomUUID !== 'function') throw new Error('UUID 생성 기능을 사용할 수 없습니다.');
  return `soul-app-v3-pending-${prefix}-${Crypto.randomUUID()}`;
}

function pendingBlock(
  pageId: string,
  text: string,
  blockType = 'paragraph',
  properties: Record<string, unknown> = {},
  suffix = 'description',
): PlannerBlock {
  return {
    id: `pending-block-${pageId}${suffix === 'description' ? '' : `-${suffix}`}`,
    pageId, parentId: null, positionKey: '',
    blockType, text, properties, collapsed: false,
  };
}
