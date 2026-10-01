import type { CardRow } from "./control_plane/card_types.js";

export type CardOwnerSession = {
  session_id: string;
  node_id: string | null;
  agent_id: string | null;
  model_preset: string | null;
  status: string | null;
  metadata: unknown;
};
type OwnerCard = Pick<CardRow, "assignee_kind" | "assignee_session_id">;
type Identity = { nodeId: string; agentId: string; modelPreset: string };
export type CardSessionTarget = Partial<Identity> & {
  sessionId: string | null;
  status?: string;
  available: boolean;
  reason: string | null;
};

/** Existing assignment is authoritative; missing identity never creates a replacement. */
export async function resolveCardSessionTarget(
  card: OwnerCard,
  read: (id: string) => Promise<CardOwnerSession | null>,
  validate: (identity: Identity) => { available: boolean; reason: string | null },
): Promise<CardSessionTarget> {
  const sessionId = card.assignee_session_id;
  const unavailable = (reason: string): CardSessionTarget => ({ sessionId, available: false, reason });
  if (card.assignee_kind !== "session" || !sessionId) return unavailable("assignee_session_missing_id");
  const owner = await read(sessionId);
  if (!owner) return unavailable("assignee_session_missing");
  for (const key of ["node_id", "agent_id", "model_preset", "status"] as const) {
    if (!owner[key]) return unavailable(`assignee_session_missing_${key}`);
  }
  if (Array.isArray(owner.metadata) && owner.metadata.some(item => item?.type === "card_orchestration_decision")) {
    return unavailable("assignee_session_orchestration_purpose");
  }
  const identity = { nodeId: owner.node_id!, agentId: owner.agent_id!, modelPreset: owner.model_preset! };
  return { ...identity, sessionId, status: owner.status!, ...validate(identity) };
}
