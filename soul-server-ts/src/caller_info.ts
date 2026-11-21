import type { CallerInfo } from "./task/task_models.js";

export interface AgentCallerInfo extends CallerInfo {
  source: "agent";
  agent_node: string;
  agent_id?: string;
  agent_name?: string;
  display_name?: string;
  user_id?: string;
  avatar_url?: string;
  email?: string;
}

export interface BuildAgentCallerInfoParams {
  agentNode: string;
  /** null / undefined 모두 받음 — caller_task가 DB에 없거나 profile이 registry에 없는 경우. */
  agentId: string | null | undefined;
  agentName: string | null | undefined;
  /** AgentProfile.portrait_path. truthy + agentId truthy일 때만 avatar_url 부여. */
  portraitPath?: string | null;
  /** 원 caller(browser/JWT)의 email. service-token orch access 평가에서 신원으로 쓰인다. */
  email?: string | null;
  /** Registered external ownership proof; does not identify the internal sender. */
  externalAgentId?: string | null;
}

/**
 * Agent origin caller_info v1 dict 조립.
 *
 * Python `build_agent_caller_info` 동작 정합 — avatar_url은 portraitPath와 agentId가 모두
 * truthy일 때만 orch 프록시 경로(`/api/nodes/{node}/agents/{id}/portrait`)로 부여.
 * 그 외는 null (graceful, 클라이언트가 source 기반 fallback 아이콘으로 다운그레이드).
 *
 * @returns v1 caller_info dict. source/agent_node는 항상 채움.
 */
export function buildAgentCallerInfo(
  params: BuildAgentCallerInfoParams,
): AgentCallerInfo {
  const { agentNode, agentId, agentName, portraitPath, email, externalAgentId } = params;
  const aid = agentId ?? undefined;
  const aname = agentName ?? undefined;
  const sourceEmail = email ?? undefined;
  const avatarUrl =
    portraitPath && aid
      ? `/api/nodes/${agentNode}/agents/${aid}/portrait`
      : undefined;
  return {
    source: "agent",
    agent_node: agentNode,
    ...(aid === undefined ? {} : {
      agent_id: aid,
      user_id: aid,
    }),
    ...(aname === undefined ? {} : {
      agent_name: aname,
      display_name: aname,
    }),
    ...(avatarUrl === undefined ? {} : { avatar_url: avatarUrl }),
    ...(sourceEmail === undefined ? {} : { email: sourceEmail }),
    ...(externalAgentId ? { external_agent_id: externalAgentId } : {}),
  };
}

/**
 * MCP 도구 진입점이 caller_session_id로부터 v1 caller_info를 조립할 때 사용하는 helper.
 *
 * `taskManager.getTask` → `agentRegistry.get` → builder 호출의 *동일한* 정책을 cogito 도구
 * (session_mgmt, multi_node)가 *각자 인라인*으로 보유했던 결함을 닫는다 (code-reviewer P2-1,
 * design-principles §3 정본 하나).
 *
 * 메모리에 없는 evict된 caller task에 대한 on-demand DB 로드는 본 카드 범위 외 (P2-2 후속 카드).
 *
 * @param deps `runtime`이 의존하는 두 객체만 — McpRuntime 전체를 받지 않아 테스트 표면 단순.
 */
export function buildCallerInfoFromCallerSession(deps: {
  nodeId: string;
  taskManager: {
    getTask(sessionId: string): {
      profileId?: string | null;
      callerInfo?: CallerInfo | null;
      agentProfileSnapshot?: {
        id?: string | null;
        name?: string | null;
        portrait_path?: string | null;
      };
      agentProfileHasDbPortrait?: boolean;
    } | undefined;
  };
  agentRegistry: {
    get(id: string): {
      id?: string | null;
      name?: string | null;
      portrait_path?: string | null;
    } | undefined;
  };
}, callerSessionId: string): AgentCallerInfo {
  const callerTask = deps.taskManager.getTask(callerSessionId);
  const callerProfile = callerTask?.agentProfileSnapshot ?? (callerTask?.profileId
    ? deps.agentRegistry.get(callerTask.profileId)
    : undefined);
  return buildAgentCallerInfo({
    agentNode: deps.nodeId,
    agentId: callerProfile?.id ?? callerTask?.profileId ?? null,
    agentName: callerProfile?.name ?? null,
    portraitPath: callerTask?.agentProfileHasDbPortrait
      ? `/api/agents/${callerProfile?.id ?? callerTask.profileId}/portrait`
      : callerProfile?.portrait_path ?? null,
    email: extractEmail(callerTask?.callerInfo),
    externalAgentId: typeof callerTask?.callerInfo?.external_agent_id === "string" ? callerTask.callerInfo.external_agent_id : undefined,
  });
}

function extractEmail(callerInfo: CallerInfo | null | undefined): string | undefined {
  const email = callerInfo?.email;
  return typeof email === "string" ? email : undefined;
}

/**
 * 시스템 origin caller_info v1 dict 조립.
 *
 * Python `build_system_caller_info(node_id=...)`와 키·값을 맞춘다. LLM proxy처럼 외부
 * 시스템 호출자가 caller_info를 생략한 경로에서도 세션 metadata에 감사 가능한 발신자가 남는다.
 */
export function buildSystemCallerInfo(nodeId: string): CallerInfo {
  return {
    source: "system",
    agent_node: nodeId,
    display_name: "Soulstream",
    user_id: null,
    avatar_url: "/api/system/portraits/system",
  };
}
