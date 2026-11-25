import type { SupportedPortraitMime } from "./agent_profile_routes.js";

export type AgentPortraitSource = "upload" | "profile" | "node";

/** 메모리 목록의 한 항목. 바이트는 들지 않는다. */
export type AgentPortraitSummary = {
  readonly agentId: string;
  readonly sha256: string;
  readonly mime: SupportedPortraitMime;
  readonly byteSize: number;
  readonly updatedAt: string;
};

export type AgentPortraitContent = AgentPortraitSummary & { readonly body: Buffer };

export type AgentPortraitWrite = {
  readonly agentId: string;
  readonly body: Buffer;
  readonly mime: SupportedPortraitMime;
  readonly sha256: string;
};

/** 에이전트 id → 버전 주소. 초상이 없으면 빈 문자열. 세션 직렬화처럼 동기적으로 주소를 만드는 곳이 쓴다. */
export type AgentPortraitUrlResolver = (agentId: string) => string;

export type AgentPortraitRepository = {
  /** 이관과 목록 읽기가 끝날 때까지 기다린다. 한 번 성공하면 다시 하지 않는다. */
  readonly ready: () => Promise<void>;
  /** 지운 기록을 뺀 메모리 목록. */
  readonly list: () => readonly AgentPortraitSummary[];
  readonly summary: (agentId: string) => AgentPortraitSummary | null;
  /** 지운 기록도 행으로 친다. */
  readonly hasRecord: (agentId: string) => boolean;
  readonly get: (agentId: string) => Promise<AgentPortraitContent | null>;
  readonly put: (input: AgentPortraitWrite) => Promise<AgentPortraitSummary>;
  /** 지운 기록으로 바꾼다. */
  readonly remove: (agentId: string) => Promise<void>;
  /** 행이 아예 없을 때만 노드 사본을 넣는다. 넣었으면 true. */
  readonly seedFromNode: (input: AgentPortraitWrite) => Promise<boolean>;
};

/** 주소를 만드는 모든 서버 쪽이 쓰는 버전 주소. 클라이언트 도우미(soul-ui)와 같은 꼴이다. */
export function agentPortraitUrl(summary: Pick<AgentPortraitSummary, "agentId" | "sha256">): string {
  return `/api/agent-portraits/${encodeURIComponent(summary.agentId)}?v=${summary.sha256}`;
}

export function agentPortraitUrlFor(
  portraits: Pick<AgentPortraitRepository, "summary">,
  agentId: string,
): string {
  const summary = portraits.summary(agentId);
  return summary === null ? "" : agentPortraitUrl(summary);
}

export function projectAgentPortrait(summary: AgentPortraitSummary): Record<string, unknown> {
  return {
    agent_id: summary.agentId,
    sha256: summary.sha256,
    mime: summary.mime,
    byte_size: summary.byteSize,
    updated_at: summary.updatedAt,
    url: agentPortraitUrl(summary),
  };
}
