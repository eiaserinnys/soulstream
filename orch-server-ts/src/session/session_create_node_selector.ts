import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "../node/registry.js";
import {
  findNodeAgentProfile,
  type AgentProfileIdentityOverlay,
} from "../node/agent_profile_lookup.js";

export type SessionCreateNodeSelectionRequest = {
  readonly nodeId?: string;
  readonly profileId?: string;
  readonly modelPresetId?: string;
  readonly legacyModelSpecified?: boolean;
};

export type SessionCreateNodeSelection = {
  readonly node: NodeConnectionSnapshot;
  readonly profileId: string;
  readonly backend: string;
  readonly modelPresetId?: string;
};

export type SessionCreateNodeSelectionErrorCode =
  | "NO_AVAILABLE_NODE"
  | "NODE_NOT_FOUND"
  | "PROFILE_NOT_FOUND"
  | "MODEL_PRESET_NOT_FOUND"
  | "BACKEND_INCOMPATIBLE"
  | "NO_COMPATIBLE_PROFILE";

export class SessionCreateNodeSelectionError extends Error {
  readonly statusCode: 400 | 404 | 409 | 503;
  readonly code: SessionCreateNodeSelectionErrorCode;
  readonly nodeId: string | undefined;
  readonly profileId: string | undefined;
  readonly backend: string | undefined;

  constructor(params: {
    statusCode: 400 | 404 | 409 | 503;
    code: SessionCreateNodeSelectionErrorCode;
    message: string;
    nodeId?: string;
    profileId?: string;
    backend?: string;
  }) {
    super(params.message);
    this.name = "SessionCreateNodeSelectionError";
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.nodeId = params.nodeId;
    this.profileId = params.profileId;
    this.backend = params.backend;
  }
}

export function selectNodeForSessionCreate(
  registry: InMemoryNodeRegistry,
  request: SessionCreateNodeSelectionRequest,
  agentProfiles: readonly AgentProfileIdentityOverlay[] = [],
): SessionCreateNodeSelection {
  const nodes = registry.listConnectedNodesInRegistrationOrder();
  if (nodes.length === 0) {
    throw selectionError(503, "NO_AVAILABLE_NODE", "No nodes available");
  }

  if (request.nodeId !== undefined) {
    return selectRequestedNode(registry, {
      ...request,
      nodeId: request.nodeId,
    }, agentProfiles);
  }
  return selectAutomaticNode(registry, nodes, request, agentProfiles);
}

function selectRequestedNode(
  registry: InMemoryNodeRegistry,
  request: SessionCreateNodeSelectionRequest & { readonly nodeId: string },
  agentProfiles: readonly AgentProfileIdentityOverlay[],
): SessionCreateNodeSelection {
  const nodeId = request.nodeId;
  const node = registry.getConnectedNode(nodeId);
  if (node === undefined) {
    throw selectionError(404, "NODE_NOT_FOUND", `Node ${nodeId} not found`, {
      nodeId,
    });
  }

  const profile = request.profileId === undefined
    ? compatibleProfiles(node, request, agentProfiles)[0]?.profile
    : findProfile(node, request.profileId, agentProfiles);
  if (profile === undefined) {
    if (request.profileId !== undefined) {
      throw selectionError(
        404,
        "PROFILE_NOT_FOUND",
        `Agent profile '${request.profileId}' is not registered on node ${nodeId}`,
        { nodeId, profileId: request.profileId },
      );
    }
    throw selectionError(
      503,
      "NO_COMPATIBLE_PROFILE",
      `No compatible agent profile registered on node ${nodeId}`,
      { nodeId },
    );
  }

  const backend = backendForProfile(node, profile, request);
  if (!backend) {
    throw modelPresetNotFound(nodeId, request.modelPresetId ?? profile.defaultPreset);
  }
  assertBackendCompatibility(node, profile, backend);
  const modelPresetId = selectedPresetId(profile, request);
  return {
    node,
    profileId: profile.id,
    backend,
    ...(modelPresetId ? { modelPresetId } : {}),
  };
}

function selectAutomaticNode(
  registry: InMemoryNodeRegistry,
  nodes: NodeConnectionSnapshot[],
  request: SessionCreateNodeSelectionRequest,
  agentProfiles: readonly AgentProfileIdentityOverlay[],
): SessionCreateNodeSelection {
  if (request.profileId !== undefined) {
    const eligible = nodes.flatMap((node) => {
      const profile = findProfile(node, request.profileId!, agentProfiles);
      return profile === undefined ? [] : [{ node, profile }];
    });
    if (eligible.length === 0) {
      throw selectionError(
        404,
        "PROFILE_NOT_FOUND",
        `Agent profile '${request.profileId}' is not registered on any connected node`,
        { profileId: request.profileId },
      );
    }
    const resolved = eligible.flatMap(({ node, profile }) => {
      const backend = backendForProfile(node, profile, request);
      const modelPresetId = selectedPresetId(profile, request);
      return backend
        ? [{
            node,
            profile,
            backend,
            ...(modelPresetId ? { modelPresetId } : {}),
          }]
        : [];
    });
    if (resolved.length === 0 && request.modelPresetId) {
      throw modelPresetNotFound(undefined, request.modelPresetId);
    }
    const compatible = resolved.filter(({ node, backend }) =>
      node.supportedBackends.includes(backend),
    );
    if (compatible.length === 0) {
      throw selectionError(
        409,
        "BACKEND_INCOMPATIBLE",
        `Agent profile '${request.profileId}' is registered on connected nodes but none supports the selected backend`,
        { profileId: request.profileId },
      );
    }
    return toSelection(leastLoaded(registry, compatible));
  }

  const resolvedDefaults = nodes.flatMap((node) =>
    compatibleProfiles(node, request, agentProfiles),
  );
  if (resolvedDefaults.length === 0 && request.modelPresetId) {
    throw modelPresetNotFound(undefined, request.modelPresetId);
  }
  if (resolvedDefaults.length === 0) {
    throw selectionError(
      503,
      "NO_COMPATIBLE_PROFILE",
      "No compatible agent profiles available on connected nodes",
    );
  }
  return toSelection(leastLoaded(registry, resolvedDefaults));
}

type NodeProfileCandidate = {
  readonly node: NodeConnectionSnapshot;
  readonly profile: AgentProfile;
  readonly backend: string;
  readonly modelPresetId?: string;
};

type AgentProfile = {
  readonly id: string;
  readonly backend: string;
  readonly defaultPreset?: string;
};

function leastLoaded(
  registry: InMemoryNodeRegistry,
  candidates: NodeProfileCandidate[],
): NodeProfileCandidate {
  const [first, ...rest] = candidates;
  if (first === undefined) throw new Error("leastLoaded requires candidates");
  return rest.reduce((selected, candidate) =>
    sessionCount(registry, candidate.node) < sessionCount(registry, selected.node)
      ? candidate
      : selected,
  first);
}

function sessionCount(
  registry: InMemoryNodeRegistry,
  node: NodeConnectionSnapshot,
): number {
  return registry.sessionCache.getSessionsForNode(node.nodeId).length;
}

function toSelection(candidate: NodeProfileCandidate): SessionCreateNodeSelection {
  return {
    node: candidate.node,
    profileId: candidate.profile.id,
    backend: candidate.backend,
    ...(candidate.modelPresetId
      ? { modelPresetId: candidate.modelPresetId }
      : {}),
  };
}

function compatibleProfiles(
  node: NodeConnectionSnapshot,
  request: SessionCreateNodeSelectionRequest,
  agentProfiles: readonly AgentProfileIdentityOverlay[],
): NodeProfileCandidate[] {
  return profiles(node, agentProfiles).flatMap((profile) => {
    const backend = backendForProfile(node, profile, request);
    const modelPresetId = selectedPresetId(profile, request);
    return backend && node.supportedBackends.includes(backend)
      ? [{
          node,
          profile,
          backend,
          ...(modelPresetId ? { modelPresetId } : {}),
        }]
      : [];
  });
}

function findProfile(
  node: NodeConnectionSnapshot,
  profileId: string,
  agentProfiles: readonly AgentProfileIdentityOverlay[],
): AgentProfile | undefined {
  const profile = findNodeAgentProfile(node, profileId, agentProfiles);
  return profile
    ? {
        id: profile.id,
        backend: profile.backend,
        ...(profile.defaultPreset
          ? { defaultPreset: profile.defaultPreset }
          : {}),
      }
    : undefined;
}

function profiles(
  node: NodeConnectionSnapshot,
  agentProfiles: readonly AgentProfileIdentityOverlay[],
): AgentProfile[] {
  return node.agents.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) {
      return [];
    }
    const profile = findProfile(node, candidate.id, agentProfiles);
    return profile ? [profile] : [];
  });
}

function backendForProfile(
  node: NodeConnectionSnapshot,
  profile: AgentProfile,
  request: SessionCreateNodeSelectionRequest,
): string | undefined {
  const presetId = selectedPresetId(profile, request);
  if (!presetId) return profile.backend;
  return modelPresets(node).find((preset) => preset.id === presetId)?.backend;
}

function selectedPresetId(
  profile: AgentProfile,
  request: SessionCreateNodeSelectionRequest,
): string | undefined {
  return request.modelPresetId
    ?? (request.legacyModelSpecified ? undefined : profile.defaultPreset);
}

function modelPresets(
  node: NodeConnectionSnapshot,
): Array<{ id: string; backend: string }> {
  return (node.modelPresets ?? []).flatMap((candidate) => {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || typeof candidate.backend !== "string"
    ) {
      return [];
    }
    return [{ id: candidate.id, backend: candidate.backend }];
  });
}

function assertBackendCompatibility(
  node: NodeConnectionSnapshot,
  profile: AgentProfile,
  backend: string,
): void {
  if (node.supportedBackends.includes(backend)) return;
  throw selectionError(
    409,
    "BACKEND_INCOMPATIBLE",
    `Node ${node.nodeId} does not support backend '${backend}' (supports: ${node.supportedBackends.join(",")})`,
    { nodeId: node.nodeId, profileId: profile.id, backend },
  );
}

function modelPresetNotFound(
  nodeId: string | undefined,
  presetId: string | undefined,
): SessionCreateNodeSelectionError {
  return selectionError(
    400,
    "MODEL_PRESET_NOT_FOUND",
    nodeId
      ? `Model preset '${presetId ?? ""}' is not advertised by node ${nodeId}`
      : `Model preset '${presetId ?? ""}' is not advertised by any compatible node`,
    { nodeId },
  );
}

function selectionError(
  statusCode: 400 | 404 | 409 | 503,
  code: SessionCreateNodeSelectionErrorCode,
  message: string,
  metadata: { nodeId?: string; profileId?: string; backend?: string } = {},
): SessionCreateNodeSelectionError {
  return new SessionCreateNodeSelectionError({
    statusCode,
    code,
    message,
    ...metadata,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
