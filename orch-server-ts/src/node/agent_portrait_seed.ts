import { asRecord } from "@soulstream/wire-schema/json-record";

import type { AgentPortraitRepository } from "./agent_portrait_model.js";
import { detectPortraitMime, parsePortraitBytes } from "./agent_profile_routes.js";
import type { NodeRegistryEvent } from "./registry.js";
import type { NodeCommandRegistryPort } from "./registry_types.js";

/**
 * 노드가 등록할 때 올리는 portrait_b64를 중앙 초상 저장소의 씨앗으로 쓴다.
 * 그 에이전트 행이 아예 없을 때만(지운 기록도 행이다) 넣고, 이미 있으면 노드 사본은 무시한다.
 * 이관(agent_profiles 칸에서 옮기기)은 ready()가 먼저 끝낸다.
 */
export function createAgentPortraitSeedSink(options: {
  readonly portraits: AgentPortraitRepository;
  readonly registry: Pick<NodeCommandRegistryPort, "getConnectedNode">;
  readonly warn: (message: string) => void;
}): (events: readonly NodeRegistryEvent[]) => Promise<void> {
  const warned = new Set<string>();
  return async (events) => {
    const nodeIds = new Set<string>();
    for (const event of events) {
      if (event.type === "node_registered" || event.type === "node_updated") nodeIds.add(event.nodeId);
    }
    if (nodeIds.size === 0) return;
    await options.portraits.ready();
    for (const nodeId of nodeIds) {
      const node = options.registry.getConnectedNode(nodeId);
      for (const candidate of node?.agents ?? []) {
        const agent = asRecord(candidate);
        const agentId = typeof agent?.id === "string" ? agent.id : "";
        const encoded = agent?.portrait_b64;
        if (agentId === "" || typeof encoded !== "string" || encoded === "") continue;
        if (options.portraits.hasRecord(agentId)) continue;
        const decoded = Buffer.from(encoded, "base64");
        const mime = detectPortraitMime(decoded);
        const parsed = mime === null
          ? { ok: false as const, error: "unsupported image bytes" }
          : parsePortraitBytes({ data_base64: encoded, mime });
        if (!parsed.ok) {
          const key = `${nodeId}:${agentId}:${encoded.length}`;
          if (!warned.has(key)) {
            warned.add(key);
            options.warn(`agent portrait seed skipped (${nodeId}/${agentId}): ${parsed.error}`);
          }
          continue;
        }
        await options.portraits.seedFromNode({ agentId, ...parsed.value });
      }
    }
  };
}
