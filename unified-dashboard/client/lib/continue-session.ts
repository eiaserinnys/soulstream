import type {
  AgentInfo,
  CatalogState,
  DashboardAgentConfig,
  SessionSummary,
} from "@seosoyoung/soul-ui";

export const CONTINUE_SESSION_AGENT_MISSING_REASON =
  "이 세션에는 에이전트 정보가 없어 이어서 시작할 수 없습니다.";
export const CONTINUE_SESSION_NODE_MISSING_REASON =
  "이 세션에는 노드 정보가 없어 이어서 시작할 수 없습니다.";
export const CONTINUE_SESSION_NOT_FOUND_REASON =
  "세션 정보를 찾을 수 없어 이어서 시작할 수 없습니다.";

type ContinueSessionMode = "single" | "orchestrator";

type AgentLike = Pick<DashboardAgentConfig | AgentInfo, "id" | "name" | "portraitUrl" | "backend">;

export interface ResolveContinueSessionTargetInput {
  session: SessionSummary | null | undefined;
  catalog: CatalogState | null;
  agents: AgentLike[];
  mode: ContinueSessionMode;
  localNodeId: string | null;
}

export interface ContinueSessionTarget {
  disabledReason: string | null;
  nodeId?: string;
  agentId?: string | null;
  agentName?: string | null;
  agentPortraitUrl?: string | null;
  backend?: string | null;
  folderId?: string | null;
}

export function buildContinueSessionPrompt(sessionId: string): string {
  return `세션 ${sessionId}의 기록을 조회해 맥락을 파악한 뒤, 사용자의 지시를 대기해주세요.`;
}

export function resolveContinueSessionTarget({
  session,
  catalog,
  agents,
  mode,
  localNodeId,
}: ResolveContinueSessionTargetInput): ContinueSessionTarget {
  if (!session) {
    return { disabledReason: CONTINUE_SESSION_NOT_FOUND_REASON };
  }

  const nodeId = session.nodeId ?? (mode === "single" ? localNodeId ?? undefined : undefined);
  if (mode === "orchestrator" && !nodeId) {
    return { disabledReason: CONTINUE_SESSION_NODE_MISSING_REASON };
  }

  const fallbackAgent = session.agentId
    ? null
    : mode === "single" && agents.length === 1
      ? agents[0]
      : null;
  const agentId = session.agentId ?? fallbackAgent?.id ?? null;
  if (!agentId) {
    return { disabledReason: CONTINUE_SESSION_AGENT_MISSING_REASON };
  }

  return {
    disabledReason: null,
    nodeId,
    agentId,
    agentName: session.agentName ?? fallbackAgent?.name ?? null,
    agentPortraitUrl: session.agentPortraitUrl ?? fallbackAgent?.portraitUrl ?? null,
    backend: session.backend ?? fallbackAgent?.backend ?? null,
    folderId: session.folderId ?? catalog?.sessions?.[session.agentSessionId]?.folderId ?? null,
  };
}
