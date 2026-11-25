import type {
  AgentPortraitContent,
  AgentPortraitRepository,
  AgentPortraitSummary,
  AgentPortraitWrite,
} from "../src/node/agent_portrait_model.js";

/** 메모리에만 있는 중앙 초상 저장소. null 항목은 지운 기록이다. */
export function createFakeAgentPortraits(
  initial: readonly AgentPortraitWrite[] = [],
): AgentPortraitRepository & { readonly rows: Map<string, AgentPortraitContent | null> } {
  const rows = new Map<string, AgentPortraitContent | null>();
  let tick = 0;
  const store = (input: AgentPortraitWrite): AgentPortraitContent => {
    tick += 1;
    const content: AgentPortraitContent = {
      agentId: input.agentId,
      sha256: input.sha256,
      mime: input.mime,
      byteSize: input.body.length,
      updatedAt: new Date(Date.UTC(2026, 10, 25, 0, 0, tick)).toISOString(),
      body: input.body,
    };
    rows.set(input.agentId, content);
    return content;
  };
  for (const entry of initial) store(entry);
  const summary = (agentId: string): AgentPortraitSummary | null => {
    const row = rows.get(agentId);
    if (row === undefined || row === null) return null;
    const { body: _body, ...rest } = row;
    return rest;
  };
  return {
    rows,
    ready: async () => undefined,
    list: () => [...rows.keys()].flatMap((id) => {
      const entry = summary(id);
      return entry === null ? [] : [entry];
    }).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    summary,
    hasRecord: (agentId) => rows.has(agentId),
    get: async (agentId) => rows.get(agentId) ?? null,
    put: async (input) => {
      store(input);
      return summary(input.agentId)!;
    },
    remove: async (agentId) => {
      rows.set(agentId, null);
    },
    seedFromNode: async (input) => {
      if (rows.has(input.agentId)) return false;
      store(input);
      return true;
    },
  };
}
