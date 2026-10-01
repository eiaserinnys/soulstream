import { describe, it, expect, vi } from "vitest";
import {
  validateDecisionSnapshot,
  selectEligibleCards,
} from "../src/cards/card_orchestration_selection.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
const snapshot = [
  { cardId: "a", cardVersion: 2 },
  { cardId: "b", cardVersion: 1 },
];
describe("server owns card orchestration admission", () => {
  it("preserves chosen order and validates the immutable snapshot", () => {
    expect(
      validateDecisionSnapshot(
        {
          decisions: [
            {
              cardId: "b",
              cardVersion: 1,
              action: "run",
              reason: "dependency",
            },
            { cardId: "a", cardVersion: 2, action: "defer", reason: "wait" },
          ],
        },
        snapshot,
      ).decisions[0]?.cardId,
    ).toBe("b");
  });
  it.each([
    {
      decisions: [
        { cardId: "outside", cardVersion: 2, action: "run", reason: "x" },
      ],
    },
    {
      decisions: [{ cardId: "a", cardVersion: 1, action: "run", reason: "x" }],
    },
    {
      decisions: [
        { cardId: "a", cardVersion: 2, action: "run", reason: "x" },
        { cardId: "a", cardVersion: 2, action: "defer", reason: "x" },
      ],
    },
    {
      decisions: [
        {
          cardId: "a",
          cardVersion: 2,
          action: "run",
          reason: "x",
          nodeId: "attacker",
        },
      ],
    },
  ])(
    "rejects injected IDs, stale versions, duplicates and authority fields",
    (value) => {
      expect(() => validateDecisionSnapshot(value, snapshot)).toThrow();
    },
  );
  it("cheap gate filters actual eligible nodes without changing worker model", () => {
    const cards = [
      {
        id: "a",
        assignee_kind: "agent",
        assignee_agent_id: "worker",
        model_preset: "worker-model",
      },
      { id: "b", assignee_kind: "human", assignee_agent_id: null },
    ];
    const resolve = vi.fn(() => ({ nodeId: "n", available: true }));
    expect(
      selectEligibleCards(cards as never, {}, { default: 1 }, resolve),
    ).toHaveLength(1);
    expect(
      selectEligibleCards(cards as never, { n: 1 }, { default: 1 }, resolve),
    ).toHaveLength(0);
    expect(cards[0]?.model_preset).toBe("worker-model");
  });
  it("includes session assignments without agentId and does not double-charge occupied owners", () => {
    const cards=[{id:"session",assignee_kind:"session",assignee_agent_id:null,assignee_session_id:"owner"},{id:"missing",assignee_kind:"session",assignee_agent_id:null,assignee_session_id:null}];
    expect(selectEligibleCards(cards as never,{n:1},{default:1},()=>({nodeId:"n",available:true,capacityClaimed:true}))).toEqual([cards[0]]);
    expect(selectEligibleCards(cards as never,{n:1},{default:1},()=>({nodeId:"n",available:true,capacityClaimed:false}))).toEqual([]);
  });
  it("enabled policy never enters legacy FIFO or limit resume", async () => {
    const policy = vi.fn(async () => true),
      kick = vi.fn(async () => {}),
      queued = vi.fn(),
      limited = vi.fn();
    const d = new CardDispatcher({
      repository: { queued, limited } as never,
      cards: vi.fn() as never,
      resolveTarget: vi.fn() as never,
      launch: vi.fn(),
      sendMessage: vi.fn(),
      notify: vi.fn(),
      warn: vi.fn(),
      orchestration: { enabled: policy, kick, ownsSession: async () => false },
    });
    await d.checkLimits();
    await d.dispatch();
    expect(kick).toHaveBeenCalledTimes(2);
    expect(queued).not.toHaveBeenCalled();
    expect(limited).not.toHaveBeenCalled();
  });
  it("decision terminal reconciles without triggering a new decision run", async () => {
    const kick = vi.fn(async () => {}),
      decisionEnded = vi.fn(async () => {});
    const d = new CardDispatcher({
      repository: {} as never,
      cards: vi.fn() as never,
      resolveTarget: vi.fn() as never,
      launch: vi.fn(),
      sendMessage: vi.fn(),
      notify: vi.fn(),
      warn: vi.fn(),
      orchestration: {
        enabled: async () => true,
        kick,
        ownsSession: async () => true,
        decisionEnded,
      },
    });
    await d.sessionEnded("judge");
    expect(decisionEnded).toHaveBeenCalledWith("judge");
    expect(kick).not.toHaveBeenCalled();
  });
});
