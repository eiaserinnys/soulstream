import {
  agentPortraitUrl,
  normalizeAgentPortraitUrl,
  type AgentPortraitDictionary,
} from '../../../packages/soul-ui/src/lib/agent-portrait';

/**
 * 앱이 초상 주소를 만들거나 바꾸는 규칙 한 곳.
 *
 * 사전이 준비되기 전(저장한 목록도 없고 첫 요청도 끝나지 않음)에는 원래 주소를 그대로 쓰고,
 * 준비된 뒤에는 사전의 버전 주소로 바꾼다. 노드 id로 주소를 만들지 않는다.
 */
export interface AgentPortraitResolver {
  /** 서버가 준 주소(세션 행, 노드 목록, 이벤트 avatar_url)를 정규화한다. 없으면 빈 문자열. */
  normalize(url: string | null | undefined): string;
  /** 에이전트 id로 주소를 만든다. 사전에 없으면 빈 문자열. */
  forAgent(agentId: string | null | undefined): string;
  /** 세션에 저장된 주소가 있으면 정규화하고, 없으면 에이전트 id로 만든다. */
  forSession(storedUrl: string | null | undefined, agentId: string | null | undefined): string;
}

export function createAgentPortraitResolver(
  dictionary: AgentPortraitDictionary,
  ready: boolean,
): AgentPortraitResolver {
  const normalize = (url: string | null | undefined): string =>
    ready ? normalizeAgentPortraitUrl(url, dictionary) : url ?? '';
  const forAgent = (agentId: string | null | undefined): string => {
    if (!agentId) return '';
    // 준비 전에는 노드와 상관없이 중앙 바이트를 주는 에이전트 주소를 쓴다(버전 없음 → memory 캐시).
    return ready ? agentPortraitUrl(agentId, dictionary) : `/api/agents/${encodeURIComponent(agentId)}/portrait`;
  };
  return {
    normalize,
    forAgent,
    forSession: (storedUrl, agentId) => (storedUrl ? normalize(storedUrl) : forAgent(agentId)),
  };
}
