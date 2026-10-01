import type { Session } from '../../api/types';

export interface SessionAgentOption {
  id: string;
  name: string | null;
  portraitUrl?: string;
  default_preset?: string;
}

interface BuildOptimisticSessionArgs {
  agentSessionId: string;
  prompt: string;
  folderId?: string | null;
  nodeId?: string | null;
  agent?: SessionAgentOption | null;
  modelPreset?: string | null;
  now?: string;
}

/**
 * createSession 성공 직후 SSE session_created가 도착하기 전까지 채팅 화면이
 * running 상태와 선택 에이전트 portrait를 즉시 렌더할 수 있게 하는 임시 entry.
 */
export function buildOptimisticSession({
  agentSessionId,
  prompt,
  folderId,
  nodeId,
  agent,
  modelPreset,
  now = new Date().toISOString(),
}: BuildOptimisticSessionArgs): Session {
  return {
    agentSessionId,
    displayName: null,
    status: 'running',
    reviewRequired: false,
    reviewState: 'not_required',
    createdAt: now,
    updatedAt: now,
    folderId: folderId ?? null,
    nodeId: nodeId ?? undefined,
    prompt,
    lastMessage: {
      type: 'user_message',
      preview: prompt,
      timestamp: now,
    },
    agentId: agent?.id ?? null,
    agentName: agent?.name ?? null,
    agentPortraitUrl: agent?.portraitUrl ?? null,
    modelPreset: modelPreset ?? null,
  };
}

export function resolveOptimisticAgent(
  selectedAgentId: string | null,
  agents: SessionAgentOption[],
): SessionAgentOption | null {
  if (selectedAgentId) {
    return agents.find((a) => a.id === selectedAgentId) ?? null;
  }
  return agents.length === 1 ? agents[0] : null;
}
