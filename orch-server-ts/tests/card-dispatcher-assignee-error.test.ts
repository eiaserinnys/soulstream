import { describe, expect, it, vi } from "vitest";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";

const SESSION_ID = "session-1";
const CARD_ID = "card-1";
const pendingFallback = [{ type: "persistent_generation", value: { number: 1, pending: {
  number: 2, reason: "session_model_fallback", requested_at: "2026-11-10T00:00:00.000Z",
  target_model_preset: "codex-6.1-sol", reset_context: false, keep_instructions: true,
} } }];

type Options = {
  work?: boolean;
  status?: string;
  reason?: string | null;
  detail?: string | null;
  metadata?: unknown;
  assignee?: string;
  unlinked?: boolean;
  terminationEventId?: number | null;
};
function makeDispatcher(options: Options = {}) {
  const terminal = {
    session_id: SESSION_ID, card_id: CARD_ID, node_id: "node", agent_id: "agent", model_preset: null,
    status: options.status ?? "error", termination_reason: options.reason === undefined ? "error_aborted" : options.reason,
    termination_detail: options.detail ?? null,
    termination_event_id: options.terminationEventId === undefined ? 17 : options.terminationEventId,
    metadata: options.metadata ?? [],
  };
  const card = { id: CARD_ID, node_id: "node", folder_id: "folder", title: "카드", status: "running",
    assignee_session_id: options.assignee ?? SESSION_ID, version: 3 };
  const events: string[] = [];
  const setCardStatus = vi.fn(async (input: { status: string }) => { events.push("block"); card.status = input.status; });
  const updateCardNow = vi.fn(async () => { events.push("now"); });
  const blockCardForLimit = vi.fn(async () => { events.push("limit"); card.status = "blocked"; });
  const getCard = vi.fn(async () => ({ card, comments: [], questions: [] }));
  const sendMessage = vi.fn(async (_id: string, text: string) => { events.push(text); });
  const repository = {
    ownerSession: vi.fn(async () => terminal),
    endedWork: vi.fn(async () => options.work ? [{ card_id: CARD_ID, registration_id: "registration-1",
      terminal_event_id: 17, terminal_session: terminal, metadata: terminal.metadata }] : []),
    session: vi.fn(async () => options.unlinked ? null : terminal),
    assigneeErrorSession: vi.fn(async () => card.assignee_session_id === SESSION_ID ? terminal : null),
    hasExplicitWork: vi.fn(async () => Boolean(options.work)),
    reminderFacts: vi.fn(async () => { events.push("reminder_check"); return [{
      cardId: CARD_ID, cardNumber: 1, cardTitle: "카드", cardVersion: card.version, cardStatus: card.status,
      statusEpochUs: "1", rootSessionId: SESSION_ID, rootStatus: terminal.status,
      rootTerminationReason: terminal.termination_reason, rootTerminationEventId: terminal.termination_event_id,
      activeDescendants: false, activeTree: false, pendingDeliveries: false, unhandledCommentId: null,
      unregisteredCompletions: false, rootEndedAfterStatus: true, pendingExecution: false,
      lastRootTurnEndedAt: new Date(), latestRootDeliveryId: null,
    }]; }),
    settings: vi.fn(async () => ({ nodeConcurrency: { default: 1 } })),
    queued: vi.fn(async () => []),
  };
  const dispatcher = new CardDispatcher({ defaultNodeId: "node", repository: repository as never,
    cards: async () => ({ getCard, setCardStatus, updateCardNow, blockCardForLimit }) as never,
    resolveTarget: vi.fn() as never, launch: vi.fn(async () => {}), sendMessage,
    deliveryExists: vi.fn(async () => false), abandonDelivery: vi.fn(async () => {}),
    notify: vi.fn(async () => {}), warn: vi.fn(),
  });
  return { dispatcher, setCardStatus, updateCardNow, blockCardForLimit, sendMessage, events };
}

describe.each([false, true])("담당 오류 종료 (작업 맡기기: %s)", work => {
  it("blocks the running card with the reason and a fixed board message before reminders", async () => {
    const detail = "오류 상세".repeat(60);
    const { dispatcher, setCardStatus, updateCardNow, sendMessage, events } = makeDispatcher({ work, detail });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).toHaveBeenCalledOnce();
    expect(setCardStatus).toHaveBeenCalledWith({ actorKind: "system", actorSessionId: null,
      cardId: CARD_ID, status: "blocked", blockedKind: "no_report",
      blockedDetail: `담당 세션이 오류로 끝났습니다(error_aborted): ${detail.slice(0, 200)}`, expectedVersion: 3 });
    expect(updateCardNow).toHaveBeenCalledOnce();
    expect(updateCardNow).toHaveBeenCalledWith({ actorKind: "system", actorSessionId: null,
      cardId: CARD_ID, now: "담당 세션이 오류로 끝나 멈췄습니다", turn: "outside" });
    expect(events.slice(0, 2)).toEqual(["block", "now"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps limit handling exclusive", async () => {
    const { dispatcher, blockCardForLimit, setCardStatus, updateCardNow, events } = makeDispatcher({ work, reason: "limit_hit" });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(blockCardForLimit).toHaveBeenCalledOnce();
    expect(setCardStatus).not.toHaveBeenCalled();
    expect(updateCardNow).not.toHaveBeenCalled();
    expect(events).toEqual(["reminder_check", "limit"]);
  });

  it("does not block an intermediate error row without a terminal event", async () => {
    const { dispatcher, setCardStatus, blockCardForLimit } = makeDispatcher({ work, reason: null, terminationEventId: null });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).not.toHaveBeenCalled();
    expect(blockCardForLimit).not.toHaveBeenCalled();
  });

  it("blocks a confirmed error before evaluating stalled reminders", async () => {
    const { dispatcher, events, sendMessage } = makeDispatcher({ work });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(events.indexOf("block")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("reminder_check")).toBeGreaterThan(events.indexOf("block"));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("blocks a directly assigned owner whose session has no card link", async () => {
    const { dispatcher, setCardStatus } = makeDispatcher({ work, unlinked: true });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).toHaveBeenCalledWith(expect.objectContaining({ cardId: CARD_ID, blockedKind: "no_report" }));
  });

  it("does not block while a model fallback is pending", async () => {
    const { dispatcher, setCardStatus, blockCardForLimit } = makeDispatcher({ work, metadata: pendingFallback });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).not.toHaveBeenCalled();
    expect(blockCardForLimit).not.toHaveBeenCalled();
  });

  it("does not block when the assignee has changed", async () => {
    const { dispatcher, setCardStatus } = makeDispatcher({ work, assignee: "new-owner" });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).not.toHaveBeenCalled();
  });

  it.each([
    { status: "completed", reason: "completed_ok" },
    { status: "interrupted", reason: "unknown" },
    { status: "error", reason: "killed" },
  ])("does not block status=$status reason=$reason", async terminal => {
    const { dispatcher, setCardStatus } = makeDispatcher({ work, ...terminal });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).not.toHaveBeenCalled();
  });

  it.each(["unknown", null])("also blocks an error with reason %s", async reason => {
    const { dispatcher, setCardStatus } = makeDispatcher({ work, reason });
    await dispatcher.sessionEnded(SESSION_ID);
    expect(setCardStatus).toHaveBeenCalledWith(expect.objectContaining({
      blockedDetail: `담당 세션이 오류로 끝났습니다(${reason})`,
    }));
  });
});
