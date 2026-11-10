import { describe, expect, it, vi } from "vitest";

import { CardDispatcher } from "../src/cards/card_dispatcher.js";

const SESSION_ID = "session-1";
const CARD_ID = "card-1";

const limitTerminal = {
  status: "error",
  termination_reason: "limit_hit",
  termination_event_id: 17,
};

const fallbackPendingMetadata = [{
  type: "persistent_generation",
  value: {
    number: 1,
    pending: {
      number: 2,
      reason: "session_model_fallback",
      requested_at: "2026-11-10T00:00:00.000Z",
      target_model_preset: "codex-6.1-sol",
      reset_context: false,
      keep_instructions: true,
    },
  },
}];

function makeDispatcher(metadata: unknown) {
  const card = {
    id: CARD_ID,
    node_id: "node",
    folder_id: "folder",
    title: "카드",
    status: "running",
    assignee_session_id: SESSION_ID,
    version: 3,
  };
  const setCardStatus = vi.fn(async () => {});
  const updateCardNow = vi.fn(async () => {});
  const getCard = vi.fn(async () => ({
    card,
    comments: [],
    questions: [],
  }));
  const repository = {
    reminderFacts: vi.fn(async () => []),
    endedWork: vi.fn(async () => [{
      card_id: CARD_ID,
      registration_id: "registration-1",
      terminal_event_id: 17,
      terminal_session: limitTerminal,
      metadata,
    }]),
    ownerSession: vi.fn(async () => ({
      session_id: SESSION_ID,
      node_id: "node",
      agent_id: "agent",
      model_preset: null,
      status: "error",
      metadata,
      termination_reason: "limit_hit",
      termination_event_id: 17,
    })),
    limitAutoResumeAt: vi.fn(async () => null),
    session: vi.fn(async () => null),
    hasExplicitWork: vi.fn(async () => false),
    settings: vi.fn(async () => ({ nodeConcurrency: { default: 1 } })),
    queued: vi.fn(async () => []),
  };
  const dispatcher = new CardDispatcher({
    repository: repository as never,
    cards: async () => ({ getCard, setCardStatus, updateCardNow }) as never,
    resolveTarget: () => ({
      nodeId: "node",
      agentId: "agent",
      modelPreset: null,
      available: true,
      reason: null,
    }),
    launch: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    deliveryExists: vi.fn(async () => false),
    abandonDelivery: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    warn: vi.fn(),
  });
  return { dispatcher, setCardStatus, updateCardNow, getCard };
}

describe("card dispatcher ignores a limit stop that a model fallback generation continues", () => {
  it("does not block the card when the ended session carries a fallback pending", async () => {
    const { dispatcher, setCardStatus, updateCardNow, getCard } =
      makeDispatcher(fallbackPendingMetadata);

    await dispatcher.sessionEnded(SESSION_ID);

    expect(getCard).not.toHaveBeenCalled();
    expect(setCardStatus).not.toHaveBeenCalled();
    expect(updateCardNow).not.toHaveBeenCalled();
  });

  it("still blocks the card for a limit stop without a fallback pending", async () => {
    const { dispatcher, setCardStatus } = makeDispatcher([]);

    await dispatcher.sessionEnded(SESSION_ID);

    expect(setCardStatus).toHaveBeenCalledWith(expect.objectContaining({
      cardId: CARD_ID,
      status: "blocked",
      blockedKind: "limit",
    }));
  });
});
