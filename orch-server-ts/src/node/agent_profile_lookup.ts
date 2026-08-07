import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "./registry.js";
import type { AgentProfileRecord } from "./agent_profile_routes.js";

export type AgentProfileIdentityOverlay = Pick<
  AgentProfileRecord,
  "agentId" | "name" | "defaultPreset" | "aliases" | "hasPortrait"
>;

export type RegisteredAgentProfile = {
  readonly nodeId: string;
  readonly id: string;
  readonly backend: string;
  readonly defaultPreset?: string;
  readonly agent: Record<string, unknown>;
};

export function findNodeAgentProfile(
  node: NodeConnectionSnapshot,
  requestedId: string,
  overlays: readonly AgentProfileIdentityOverlay[] = [],
): RegisteredAgentProfile | undefined {
  const profiles = node.agents.flatMap((candidate) => {
    const agent = asRecord(candidate);
    const id = nonEmptyString(agent?.id);
    const overlay = id
      ? overlays.find((candidate) => candidate.agentId === id)
      : undefined;
    return agent && id ? [{ agent, id, overlay }] : [];
  });

  const canonical = profiles.find((profile) => profile.id === requestedId);
  if (canonical) {
    return resolvedProfile(
      node.nodeId,
      canonical.agent,
      canonical.id,
      undefined,
      canonical.overlay,
    );
  }

  for (const profile of profiles) {
    const alias = effectiveAliases(profile.agent, profile.overlay)
      .find((candidate) => candidate.id === requestedId);
    if (!alias) continue;
    return resolvedProfile(
      node.nodeId,
      profile.agent,
      profile.id,
      alias.defaultPreset,
      profile.overlay,
    );
  }
  return undefined;
}

export function findRegisteredAgentProfile(
  registry: InMemoryNodeRegistry,
  requestedId: string,
  preferredNodeId?: string,
  overlays: readonly AgentProfileIdentityOverlay[] = [],
): RegisteredAgentProfile | undefined {
  if (preferredNodeId) {
    const preferredNode = registry.getConnectedNode(preferredNodeId);
    return preferredNode
      ? findNodeAgentProfile(preferredNode, requestedId, overlays)
      : undefined;
  }
  for (const node of registry.listConnectedNodes()) {
    const profile = findNodeAgentProfile(node, requestedId, overlays);
    if (profile) return profile;
  }
  return undefined;
}

export function resolveRegisteredAgentId(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  requestedId: string,
  overlays: readonly AgentProfileIdentityOverlay[] = [],
): string {
  const node = registry.getConnectedNode(nodeId);
  return node
    ? findNodeAgentProfile(node, requestedId, overlays)?.id ?? requestedId
    : requestedId;
}

function resolvedProfile(
  nodeId: string,
  agent: Record<string, unknown>,
  id: string,
  aliasDefaultPreset?: string,
  overlay?: AgentProfileIdentityOverlay,
): RegisteredAgentProfile {
  const backend = nonEmptyString(agent.backend) ?? "claude";
  const defaultPreset =
    aliasDefaultPreset ?? (overlay === undefined
      ? nonEmptyString(agent.default_preset)
      : overlay.defaultPreset ?? undefined);
  const effectiveAgent = overlay === undefined
    ? agent
    : {
        ...agent,
        name: overlay.name,
        aliases: overlay.aliases,
        default_preset: overlay.defaultPreset ?? undefined,
        ...(overlay.hasPortrait ? { portrait_url: "db" } : {}),
      };
  return {
    nodeId,
    id,
    backend,
    ...(defaultPreset ? { defaultPreset } : {}),
    agent: effectiveAgent,
  };
}

function effectiveAliases(
  agent: Record<string, unknown>,
  overlay: AgentProfileIdentityOverlay | undefined,
): Array<{ id: string; defaultPreset?: string }> {
  return aliases(overlay === undefined ? agent : { aliases: overlay.aliases });
}

function aliases(
  agent: Record<string, unknown>,
): Array<{ id: string; defaultPreset?: string }> {
  if (!Array.isArray(agent.aliases)) return [];
  return agent.aliases.flatMap((candidate) => {
    if (typeof candidate === "string") {
      const id = nonEmptyString(candidate);
      return id ? [{ id }] : [];
    }
    const record = asRecord(candidate);
    const id = nonEmptyString(record?.id);
    if (!id) return [];
    const defaultPreset = nonEmptyString(record?.default_preset);
    return [{
      id,
      ...(defaultPreset ? { defaultPreset } : {}),
    }];
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
