/**
 * Agent caller_info v1 빌더 (atom card `ed3a216d-2811-4792-bfbe-f15043c7faba` 정본).
 *
 * MCP 위임 진입점(create_agent_session, send_message_to_session, create_remote_agent_session)이
 * 공유하는 단일 표면. Python `build_agent_caller_info`
 * (`packages/soul-common/src/soul_common/auth/caller_info.py` L166-209)와 *키 호환*.
 *
 * 정본 단일성 (design-principles §3):
 * - `AgentCallerInfo`는 `CallerInfo`의 narrowed sub-type. `TaskManager.createTask`의
 *   `callerInfo?: CallerInfo` 자리에 as 캐스트 없이 전달 가능.
 * - `task_models.ts`의 `CallerInfo` 인터페이스(L40-49)는 *건드리지 않는다*.
 */
import type { CallerInfo } from "./task/task_models.js";

/**
 * Agent origin caller_info — v1 promote 키가 명시 nullable이고 source가 narrow.
 *
 * Python build_agent_caller_info의 반환 dict와 1:1 키 호환:
 * source / agent_node / agent_id / agent_name / display_name / user_id / avatar_url.
 *
 * `[k: string]: unknown` index signature는 `CallerInfo`로부터 상속 — 향후 v1 추가 필드
 * 대비 graceful 표면 유지.
 */
export interface AgentCallerInfo extends CallerInfo {
  source: "agent";
  agent_node: string;
  /**
   * v1 정본 필드 — Python `build_agent_caller_info` 호환. Python은 None을 박지만 TS는
   * `undefined`로 두어 `CallerInfo`(L40-49 `string?` optional)와 type 호환 (design-principles
   * §3 정본 하나 — CallerInfo 인터페이스는 *건드리지 않는다*).
   *
   * JSON.stringify에서 undefined 키는 omit — atom card ed3a216d "기존 데이터(신규 필드 없음)는
   * graceful" 정합. 클라이언트(buildCallerInfoLines, CallerAvatar)는 키 누락을 if-가드로 처리.
   */
  agent_id?: string;
  agent_name?: string;
  display_name?: string;
  user_id?: string;
  avatar_url?: string;
}

export interface BuildAgentCallerInfoParams {
  agentNode: string;
  /** null / undefined 모두 받음 — caller_task가 DB에 없거나 profile이 registry에 없는 경우. */
  agentId: string | null | undefined;
  agentName: string | null | undefined;
  /** AgentProfile.portrait_path. truthy + agentId truthy일 때만 avatar_url 부여. */
  portraitPath?: string | null;
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
  const { agentNode, agentId, agentName, portraitPath } = params;
  const aid = agentId ?? undefined;
  const aname = agentName ?? undefined;
  const avatarUrl =
    portraitPath && aid
      ? `/api/nodes/${agentNode}/agents/${aid}/portrait`
      : undefined;
  return {
    source: "agent",
    agent_node: agentNode,
    agent_id: aid,
    agent_name: aname,
    display_name: aname,
    user_id: aid,
    avatar_url: avatarUrl,
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
    } | undefined;
  };
  agentRegistry: {
    get(id: string): { name?: string | null; portrait_path?: string | null } | undefined;
  };
}, callerSessionId: string): AgentCallerInfo {
  const callerTask = deps.taskManager.getTask(callerSessionId);
  const callerProfile = callerTask?.profileId
    ? deps.agentRegistry.get(callerTask.profileId)
    : undefined;
  return buildAgentCallerInfo({
    agentNode: deps.nodeId,
    agentId: callerTask?.profileId ?? null,
    agentName: callerProfile?.name ?? null,
    portraitPath: callerProfile?.portrait_path ?? null,
  });
}
