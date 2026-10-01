import { describe, it, expect, vi } from "vitest";
import { CardOrchestrationWorkers } from "../src/cards/card_orchestration_workers.js";
import type { CoordinatorOptions } from "../src/cards/card_orchestration_coordinator.js";
// Public reconciliation contract: recovered unaccepted intent releases capacity; consumed intent never resends.
describe("worker admission recovery", () => {
  function fixture(accepted = false) {
    const repository = {
      pendingWorkers: vi.fn(async () => [
        {
          run_id: "run",
          card_id: "card",
          session_id: "session",
          node_id: "node",
          state: "launching",
          input: { resume: true },
          launch_token: "token",
          launch_accepted: accepted,
          expired: true,
        },
      ]),
      workerObserved: vi.fn(async () => false),
      workerState: vi.fn(),
      note: vi.fn(),
    };
    const cards = {
      getCard: vi.fn(async () => ({ card: { status: "running", version: 2 } })),
      setCardStatus: vi.fn(),
    };
    const launchWorker = vi.fn(),
      sendMessage = vi.fn();
    const options = {
      repository,
      cards: async () => cards,
      launchWorker,
      sendMessage,
      warn: vi.fn(),
    } as unknown as CoordinatorOptions;
    return {
      repository,
      cards,
      launchWorker,
      sendMessage,
      worker: new CardOrchestrationWorkers(options),
    };
  }
  it("rejects an expired never-accepted launch without sending it again", async () => {
    const f = fixture();
    await f.worker.reconcile();
    expect(f.repository.workerState).toHaveBeenCalledWith(
      "session",
      "rejected",
      expect.any(String),
    );
    expect(f.cards.setCardStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked", blockedKind: "no_report" }),
    );
    expect(f.launchWorker).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("keeps consumed unknown intent visible and never resends", async () => {
    const f = fixture(true);
    await f.worker.reconcile();
    expect(f.repository.note).toHaveBeenCalledWith(
      "blocked",
      "worker_launch_accepted_observation_pending",
    );
    expect(f.repository.workerState).not.toHaveBeenCalled();
    expect(f.launchWorker).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
