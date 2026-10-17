import { describe, it, expect, vi } from "vitest";
import {
  validateDecisionSnapshot,
  selectEligibleCards,
  classifyExecution,
} from "../src/cards/card_orchestration_selection.js";
import { clampText } from "../src/cards/card_orchestration_input.js";
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
  it("classifies execution using the current card and owner termination", () => {
    const limitOwner = { session_id: "owner", node_id: "n", agent_id: "worker", model_preset: "worker-model", metadata: [], status: "error", termination_reason: "limit_hit", termination_event_id: 12 };
    expect(classifyExecution({ status: "queued", blocked_kind: null, assignee_session_id: null }, null)).toEqual({ mode: "dispatch" });
    expect(classifyExecution({ status: "blocked", blocked_kind: "limit", assignee_session_id: "owner" }, limitOwner)).toEqual({ mode: "resume", owner: limitOwner });
    expect(classifyExecution({ status: "blocked", blocked_kind: "limit", assignee_session_id: "owner" }, { ...limitOwner, termination_reason: "error_aborted" })).toEqual({ mode: "skip", reason: "limit_owner_not_resumable" });
    expect(classifyExecution({ status: "blocked", blocked_kind: "limit", assignee_session_id: null }, null)).toEqual({ mode: "skip", reason: "limit_owner_missing" });
    expect(classifyExecution({ status: "blocked", blocked_kind: "limit", assignee_session_id: "owner" }, null)).toEqual({ mode: "skip", reason: "limit_owner_missing" });
    expect(classifyExecution({ status: "blocked", blocked_kind: "question", assignee_session_id: "owner" }, limitOwner)).toEqual({ mode: "skip", reason: "card_not_dispatchable" });
  });
  it("clamps text by Unicode code point while preserving both ends", () => {
    expect(clampText("짧은 본문", 20)).toBe("짧은 본문");
    const long = "앞😀".repeat(40) + "중간 내용".repeat(50) + "끝🌙".repeat(40);
    const clamped = clampText(long, 48);
    expect([...clamped].length).toBeLessThanOrEqual(48);
    expect(clamped).toContain("\n[중간 생략]\n");
    expect(clamped.startsWith("앞😀앞😀")).toBe(true);
    expect(clamped.endsWith("끝🌙끝🌙")).toBe(true);
  });
  it("enabled policy never enters legacy FIFO or limit resume", async () => {
    const policy = vi.fn(async () => true),
      kick = vi.fn(async () => {}),
      queued = vi.fn(),
      limited = vi.fn();
    const d = new CardDispatcher({ deliveryExists: async () => false,
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
    const d = new CardDispatcher({ deliveryExists: async () => false,
      repository: { ownerSession: async () => ({status:"completed"}), reminderFacts: async () => [] } as never,
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
