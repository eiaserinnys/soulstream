export interface InitialTaskAtomReference {
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
}

export interface InitialTaskSessionDefaults {
  agentId: string;
  nodeId: string;
}

export interface InitialTaskContext {
  guidance: string;
  atomReferences: InitialTaskAtomReference[];
  sessionDefaults?: InitialTaskSessionDefaults;
}

export interface InitialTaskContextWire {
  guidance?: string;
  atom_references?: Array<{
    instance: "atom" | "atom-nl";
    node_id: string;
    node_title: string;
    depth: number;
    titles_only: boolean;
  }>;
  session_defaults?: {
    agent_id: string;
    node_id: string;
  };
}

export type InitialTaskContextParseResult =
  | { ok: true; value: InitialTaskContext | undefined }
  | { ok: false; error: string };

export function parseInitialTaskContextWire(value: unknown): InitialTaskContextParseResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: "initial_context must be an object" };
  if (value.guidance !== undefined && typeof value.guidance !== "string") {
    return { ok: false, error: "initial_context.guidance must be a string" };
  }
  if (value.atom_references !== undefined && !Array.isArray(value.atom_references)) {
    return { ok: false, error: "initial_context.atom_references must be an array" };
  }
  let sessionDefaults: InitialTaskSessionDefaults | undefined;
  if (value.session_defaults !== undefined) {
    if (!isRecord(value.session_defaults)) {
      return { ok: false, error: "initial_context.session_defaults must be an object" };
    }
    const agentId = trimmedString(value.session_defaults.agent_id);
    const nodeId = trimmedString(value.session_defaults.node_id);
    if (!agentId) {
      return { ok: false, error: "initial_context.session_defaults.agent_id must be a non-empty string" };
    }
    if (!nodeId) {
      return { ok: false, error: "initial_context.session_defaults.node_id must be a non-empty string" };
    }
    sessionDefaults = { agentId, nodeId };
  }

  const atomReferences: InitialTaskAtomReference[] = [];
  for (const [index, candidate] of (value.atom_references ?? []).entries()) {
    if (!isRecord(candidate)) {
      return { ok: false, error: `initial_context.atom_references[${index}] must be an object` };
    }
    if (candidate.instance !== "atom" && candidate.instance !== "atom-nl") {
      return { ok: false, error: `initial_context.atom_references[${index}].instance invalid` };
    }
    const nodeId = trimmedString(candidate.node_id);
    const nodeTitle = trimmedString(candidate.node_title);
    if (!nodeId) {
      return { ok: false, error: `initial_context.atom_references[${index}].node_id must be a non-empty string` };
    }
    if (!nodeTitle) {
      return { ok: false, error: `initial_context.atom_references[${index}].node_title must be a non-empty string` };
    }
    if (!Number.isInteger(candidate.depth) || Number(candidate.depth) < 1 || Number(candidate.depth) > 5) {
      return { ok: false, error: `initial_context.atom_references[${index}].depth must be an integer from 1 to 5` };
    }
    if (typeof candidate.titles_only !== "boolean") {
      return { ok: false, error: `initial_context.atom_references[${index}].titles_only must be a boolean` };
    }
    atomReferences.push({
      instance: candidate.instance,
      nodeId,
      nodeTitle,
      depth: candidate.depth as number,
      titlesOnly: candidate.titles_only,
    });
  }

  const guidance = typeof value.guidance === "string" ? value.guidance.trim() : "";
  if (!guidance && atomReferences.length === 0 && !sessionDefaults) {
    return { ok: true, value: undefined };
  }
  return {
    ok: true,
    value: {
      guidance,
      atomReferences,
      ...(sessionDefaults ? { sessionDefaults } : {}),
    },
  };
}

export function serializeInitialTaskContext(
  context: InitialTaskContext | undefined,
): InitialTaskContextWire | undefined {
  if (!context) return undefined;
  const guidance = context.guidance.trim();
  const atomReferences = context.atomReferences.map((reference) => ({
    instance: reference.instance,
    node_id: reference.nodeId.trim(),
    node_title: reference.nodeTitle.trim(),
    depth: reference.depth,
    titles_only: reference.titlesOnly,
  }));
  const sessionDefaults = context.sessionDefaults
    ? {
        agent_id: requireTrimmedString(context.sessionDefaults.agentId, "sessionDefaults.agentId"),
        node_id: requireTrimmedString(context.sessionDefaults.nodeId, "sessionDefaults.nodeId"),
      }
    : undefined;
  if (!guidance && atomReferences.length === 0 && !sessionDefaults) return undefined;
  return {
    ...(guidance ? { guidance } : {}),
    atom_references: atomReferences,
    ...(sessionDefaults ? { session_defaults: sessionDefaults } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireTrimmedString(value: string, key: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${key} must be a non-empty string`);
  return trimmed;
}
