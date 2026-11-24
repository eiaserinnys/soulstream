import type { FastifyInstance } from "fastify";

import {
  expandAtomContextsWithOrigin,
  loadContextBundlesById,
  type AgentProfileRepository,
  type AtomContextOrigin,
} from "./agent_profile_routes.js";
import type { ContextBundleRepository } from "./context_bundle_routes.js";
import {
  NodeAgentProfileRouteError,
  type NodeAgentProfileProvider,
  type RawNodeAgentProfile,
} from "./node_agent_profile_routes.js";

export type AgentContextOverviewRouteOptions = {
  readonly provider: Pick<NodeAgentProfileProvider, "listAgentProfiles" | "previewAgentContext">;
  readonly profileRepository: Pick<AgentProfileRepository, "list">;
  readonly bundleRepository: Pick<ContextBundleRepository, "list">;
};

export const agentContextOverviewRouteAuthRequirements = {
  "GET /api/nodes/:node_id/agents/context-overview": true,
} as const;

const PARALLEL_PREVIEWS = 4;
type Json = Record<string, unknown>;

export function registerAgentContextOverviewRoutes(app: FastifyInstance, options: AgentContextOverviewRouteOptions): void {
  app.get<{ Params: { node_id: string } }>("/api/nodes/:node_id/agents/context-overview", async (request, reply) => {
    const nodeId = request.params.node_id;
    try {
      return reply.send(await collectContextOverview(options, nodeId, { headers: request.headers }));
    } catch (error) {
      if (error instanceof NodeAgentProfileRouteError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      return reply.code(400).send({ error: {
        code: "NODE_AGENT_PROFILE_ROUTE_ERROR",
        message: error instanceof Error ? error.message : "Node profile route failed",
      } });
    }
  });
}

/** 서버에 간직하지 않는다. 부를 때마다 노드 프로필을 넷씩 나란히 미리보기해 모은다. */
export async function collectContextOverview(
  options: AgentContextOverviewRouteOptions,
  nodeId: string,
  requestOptions: { headers?: Readonly<Record<string, string | string[] | undefined>> },
) {
  const profiles = await options.provider.listAgentProfiles(nodeId);
  if (profiles === undefined) {
    throw new NodeAgentProfileRouteError("NODE_AGENT_CONTEXT_PREVIEW_UNAVAILABLE", `Node ${nodeId} is not connected`, 503);
  }
  const [records, bundlesById] = await Promise.all([
    options.profileRepository.list(),
    loadContextBundlesById(options.bundleRepository),
  ]);
  const recordsById = new Map(records.map((record) => [record.agentId, record]));
  const entries = Object.entries(profiles);
  const collected = new Array<Json>(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const index = next++;
      const [agentId, raw] = entries[index]!;
      collected[index] = await collectProfile(options, nodeId, agentId, raw, requestOptions, () => {
        const record = raw.source === "db" ? recordsById.get(agentId) : undefined;
        return record ? expandAtomContextsWithOrigin(record, bundlesById) : null;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PREVIEWS, entries.length) }, worker));
  return { node_id: nodeId, collected_at: new Date().toISOString(), profiles: collected };
}

async function collectProfile(
  options: AgentContextOverviewRouteOptions,
  nodeId: string,
  agentId: string,
  raw: RawNodeAgentProfile,
  requestOptions: { headers?: Readonly<Record<string, string | string[] | undefined>> },
  expansion: () => ReturnType<typeof expandAtomContextsWithOrigin> | null,
): Promise<Json> {
  const base = {
    agent_id: agentId,
    display_name: typeof raw.name === "string" ? raw.name : null,
    source: raw.source === "db" ? "db" : "yaml",
  };
  try {
    const expanded = expansion();
    const preview = await options.provider.previewAgentContext(nodeId, {
      agent_id: agentId,
      ignore_conditions: true,
      summary_only: true,
      session: { source: "browser", backend: typeof raw.backend === "string" ? raw.backend : "claude", agent: agentId },
    }, requestOptions);
    const sources = ((preview as { manifest?: { sources?: unknown } } | null)?.manifest?.sources);
    if (!Array.isArray(sources)) throw new Error("preview response has no manifest.sources");
    const used = new Set<number>();
    return {
      ...base,
      status: "ok",
      error: null,
      sources: sources.map((source: Json, index: number) => {
        let origin: AtomContextOrigin | { kind: "node_config" } = { kind: "node_config" };
        if (expanded) {
          // 펼친 차례와 node_id로 잇는다. 같은 자리가 맞으면 그것, 아니면 아직 안 쓴 같은 node_id의 첫 칸.
          const at = expanded[index]?.context.node_id === source.node_id && !used.has(index)
            ? index
            : expanded.findIndex((item, position) => !used.has(position) && item.context.node_id === source.node_id);
          if (at >= 0) used.add(at);
          origin = at >= 0 ? expanded[at]!.origin : { kind: "profile" };
        }
        return {
          node_id: source.node_id ?? null,
          title: typeof source.title === "string" ? source.title : null,
          parent_title: typeof source.parent_title === "string" ? source.parent_title : null,
          origin,
          applies_when: source.applies_when ?? null,
          mode: source.mode ?? null,
          depth: source.depth ?? null,
          chars: source.chars ?? null,
          token_estimate: source.token_estimate ?? null,
          status: source.status ?? null,
          documents: Array.isArray(source.documents) ? source.documents : [],
        };
      }),
    };
  } catch (error) {
    return { ...base, status: "error", error: error instanceof Error ? error.message : String(error), sources: [] };
  }
}
