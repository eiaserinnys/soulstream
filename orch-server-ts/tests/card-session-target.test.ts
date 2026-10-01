import { describe, expect, it, vi } from "vitest";
import { resolveCardSessionTarget } from "../src/cards/card_session_target.js";

const card = { assignee_kind: "session" as const, assignee_session_id: "owner", node_id: "wrong-node", model_preset: "wrong-model" };
const owner = { session_id: "owner", node_id: "actual-node", agent_id: "actual-profile", model_preset: "actual-model", status: "completed", metadata: [] };

describe("session-assigned card target", () => {
  it.each(["idle", "running", "completed", "error", "interrupted"])("uses the immutable owner identity in %s", async status => {
    const validate = vi.fn(() => ({ available: true, reason: null }));
    const target = await resolveCardSessionTarget(card, async () => ({ ...owner, status }), validate);
    expect(target).toMatchObject({ sessionId: "owner", nodeId: "actual-node", agentId: "actual-profile", modelPreset: "actual-model", status, available: true });
    expect(validate).toHaveBeenCalledWith({ nodeId: "actual-node", agentId: "actual-profile", modelPreset: "actual-model" });
  });
  it("does not replace a missing owner with a new agent", async () => {
    const validate = vi.fn();
    expect(await resolveCardSessionTarget(card, async () => null, validate)).toMatchObject({ available: false, reason: "assignee_session_missing" });
    expect(validate).not.toHaveBeenCalled();
  });
  it.each(["node_id", "agent_id", "model_preset", "status"])("exposes an ambiguous %s instead of choosing defaults", async key => {
    const validate = vi.fn();
    expect(await resolveCardSessionTarget(card, async () => ({ ...owner, [key]: null }), validate)).toMatchObject({ available: false, reason: `assignee_session_missing_${key}` });
    expect(validate).not.toHaveBeenCalled();
  });
  it("rejects a judgement purpose as a worker owner", async () => {
    expect(await resolveCardSessionTarget(card, async () => ({ ...owner, metadata: [{ type: "card_orchestration_decision" }] }), vi.fn())).toMatchObject({ available: false, reason: "assignee_session_orchestration_purpose" });
  });
  it("preserves target unavailability and its reason", async () => {
    expect(await resolveCardSessionTarget(card, async () => owner, () => ({ available: false, reason: "stale_quota" }))).toMatchObject({ available: false, reason: "stale_quota", sessionId: "owner" });
  });
});
