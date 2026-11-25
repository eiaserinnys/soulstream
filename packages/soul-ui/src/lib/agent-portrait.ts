/**
 * 중앙 에이전트 초상 주소 도우미 (React 없는 순수 TS, 웹과 앱이 함께 쓴다).
 *
 * 서버의 GET /api/agent-portraits 목록으로 사전을 만들고, 그 사전의 버전 주소
 * (/api/agent-portraits/{id}?v={sha256})만 이미지 주소로 쓴다. 노드 id로 주소를 만들지 않는다.
 */

export interface AgentPortraitItem {
  agent_id: string;
  sha256: string;
  mime: string;
  byte_size: number;
  updated_at: string;
  url: string;
}

export interface AgentPortraitListResponse {
  portraits: AgentPortraitItem[];
}

export interface AgentPortraitEntry {
  agentId: string;
  sha256: string;
  mime: string;
  byteSize: number;
  updatedAt: string;
  /** 서버 상대 경로의 버전 주소. */
  url: string;
}

export type AgentPortraitDictionary = ReadonlyMap<string, AgentPortraitEntry>;

export const EMPTY_AGENT_PORTRAIT_DICTIONARY: AgentPortraitDictionary = new Map();

export function buildAgentPortraitDictionary(
  response: AgentPortraitListResponse | null | undefined,
): AgentPortraitDictionary {
  const dictionary = new Map<string, AgentPortraitEntry>();
  for (const item of response?.portraits ?? []) {
    if (typeof item?.agent_id !== "string" || item.agent_id === "") continue;
    dictionary.set(item.agent_id, {
      agentId: item.agent_id,
      sha256: item.sha256,
      mime: item.mime,
      byteSize: item.byte_size,
      updatedAt: item.updated_at,
      url: typeof item.url === "string" && item.url !== "" ? item.url : versionedPath(item.agent_id, item.sha256),
    });
  }
  return dictionary;
}

function versionedPath(agentId: string, sha256: string): string {
  return `/api/agent-portraits/${encodeURIComponent(agentId)}?v=${sha256}`;
}

/** 에이전트의 버전 주소. 사전에 없으면 빈 문자열. */
export function agentPortraitUrl(
  agentId: string | null | undefined,
  dictionary: AgentPortraitDictionary,
): string {
  if (!agentId) return "";
  return dictionary.get(agentId)?.url ?? "";
}

const AGENT_PORTRAIT_PATH = new RegExp(
  "^(https?://[^/?#]+)?/api/(?:" +
    "nodes/[^/?#]+/agents/([^/?#]+)/portrait|" +
    "agents/([^/?#]+)/portrait|" +
    "agent-portraits/([^/?#]+)" +
  ")(?:[?#].*)?$",
);

/**
 * 옛 노드 주소, 옛 에이전트 주소, 중앙 주소(v 있든 없든)를 사전의 지금 버전 주소로 바꾼다.
 * 사전에 없는 에이전트면 빈 문자열. 이 꼴이 아닌 주소(구글 사진, 시스템 초상 등)는 그대로 돌려준다.
 * 앞에 붙은 서버 출처(https://...)는 지킨다.
 */
export function normalizeAgentPortraitUrl(
  url: string | null | undefined,
  dictionary: AgentPortraitDictionary,
): string {
  if (!url) return "";
  const match = AGENT_PORTRAIT_PATH.exec(url);
  if (match === null) return url;
  const origin = match[1] ?? "";
  const encodedId = match[2] ?? match[3] ?? match[4] ?? "";
  let agentId: string;
  try {
    agentId = decodeURIComponent(encodedId);
  } catch {
    return "";
  }
  const current = dictionary.get(agentId);
  return current === undefined ? "" : `${origin}${current.url}`;
}
