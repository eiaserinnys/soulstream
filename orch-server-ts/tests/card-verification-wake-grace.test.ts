import { describe, expect, it, vi } from "vitest";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";

const wakeAt = Date.parse("2026-11-17T00:00:00Z");

function fixture(connected: boolean, elapsed: number) {
  const card = { id: "card", assignee_session_id: "owner", wake_at: new Date(wakeAt), waiting_for: "확인", version: 1 };
  const sendMessage = vi.fn(async () => { if (!connected) throw new Error("node unavailable"); });
  const setCardStatus = vi.fn(async () => {});
  const resumeVerificationCard = vi.fn(async () => {});
  const abandonDelivery = vi.fn(async () => {});
  const dispatcher = new CardDispatcher({
    repository: {
      limited: async () => [], awaitingVerification: async () => [card],
      ownerSession: async () => ({ session_id: "owner", node_id: "node" }),
    } as never,
    cards: async () => ({ setCardStatus, resumeVerificationCard }) as never,
    resolveTarget: vi.fn() as never, launch: vi.fn(), sendMessage,
    deliveryExists: async () => false, abandonDelivery, notify: vi.fn(), warn: vi.fn(),
    now: () => wakeAt + elapsed,
    isNodeConnected: () => connected,
    orchestration: { enabled: async () => true, kick: async () => {}, ownsSession: async () => false },
  });
  return { dispatcher, sendMessage, setCardStatus, resumeVerificationCard, abandonDelivery };
}

describe("verification wake after restart", () => {
  it("defers a disconnected node inside the grace period", async () => {
    const f = fixture(false, 60_000);
    await f.dispatcher.checkLimits();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.setCardStatus).not.toHaveBeenCalled();
    expect(f.abandonDelivery).not.toHaveBeenCalled();
  });
  it("delivers when the node connects", async () => {
    const f = fixture(true, 60_000);
    await f.dispatcher.checkLimits();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.resumeVerificationCard).toHaveBeenCalledOnce();
  });
  it("uses the existing blocking path after five minutes", async () => {
    const f = fixture(false, 300_000);
    await f.dispatcher.checkLimits();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.abandonDelivery).toHaveBeenCalledOnce();
    expect(f.setCardStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked", blockedKind: "no_report" }));
  });
});
