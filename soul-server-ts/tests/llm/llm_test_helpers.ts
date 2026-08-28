import pino from "pino";
import { vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type { SessionMutationHost } from
  "../../src/control_plane/persistence_host_clients.js";
import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { LlmAdapter, LlmResult } from "../../src/llm/types.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { EventOutboxRecord } from "../../src/upstream/event_outbox.js";
import type { EventAppendAcknowledgement } from
  "../../src/upstream/event_outbox_pump.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

export const silentLogger = pino({ level: "silent" });

export function makeLlmHarness(adapter?: LlmAdapter) {
  let sourceSeq = 0;
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const transitionSession = vi.fn().mockResolvedValue(undefined);
  const renameSession = vi.fn().mockResolvedValue(undefined);
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  const acknowledgeReview = vi.fn().mockResolvedValue("acknowledged");
  const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
  const getFolderById = vi
    .fn()
    .mockResolvedValue({
      id: "llm",
      name: "사용자가 바꾼 LLM 폴더 이름",
      sort_order: 1,
      settings: {},
      parent_folder_id: null,
    });
  const getCatalog = vi.fn().mockResolvedValue({ folders: [], sessions: {} });
  const appendEvent = vi.fn().mockImplementation(async () => {
    throw new Error("worker publishers must not write session events directly");
  });
  const outboxAppend = vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
    sourceSeq += 1;
    return {
      stream_id: "stream-llm-test",
      source_seq: sourceSeq,
      ...input,
      payload_hash: `${sourceSeq}`.padStart(64, "0"),
    };
  });
  const waitForAcknowledgement = vi.fn().mockImplementation(
    async (record: { source_seq: number }) => record.source_seq,
  );
  const waitForAcknowledgementResult = vi.fn().mockImplementation(
    async (record: EventOutboxRecord) => makeAppliedTransitionAcknowledgement(record),
  );
  const updateLastMessage = vi.fn().mockResolvedValue(undefined);

  const db = {
    assignSessionToFolder,
    getFolderById,
    getCatalog,
    appendEvent,
    updateLastMessage,
  } as unknown as SessionDB;

  const sent: unknown[] = [];
  const broadcaster = new SessionBroadcaster(
    async (data) => {
      sent.push(data);
    },
    { get: () => undefined } as unknown as AgentRegistry,
    "test-node",
  );
  const persistence = new EventPersistence(
    db,
    broadcaster,
    silentLogger,
    { append: outboxAppend } as never,
    { waitForAcknowledgement, waitForAcknowledgementResult } as never,
  );
  const sessionMutations = {
    registerSession,
    transitionSession,
    renameSession,
    deleteSession,
    acknowledgeReview,
  } satisfies SessionMutationHost;
  const taskManager = new TaskManager(
    "test-node",
    db,
    broadcaster,
    silentLogger,
    persistence,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    sessionMutations,
  );

  return {
    adapter: adapter ?? new MockLlmAdapter(),
    db,
    taskManager,
    persistence,
    broadcaster,
    sent,
    mocks: {
      registerSession,
      transitionSession,
      renameSession,
      deleteSession,
      acknowledgeReview,
      assignSessionToFolder,
      getFolderById,
      getCatalog,
      appendEvent,
      outboxAppend,
      waitForAcknowledgement,
      waitForAcknowledgementResult,
      updateLastMessage,
    },
  };
}

function makeAppliedTransitionAcknowledgement(
  record: EventOutboxRecord,
): EventAppendAcknowledgement {
  const effect = record.session_effect;
  if (!effect || ![
    "running_transition",
    "terminal_transition",
    "execution_reserve",
    "execution_prove",
    "execution_adopt_reserve",
    "execution_activate",
    "execution_fail",
    "execution_expire_dead_owner",
    "execution_retire_terminal_ownership",
    "runner_terminal_fact",
    "recovered_runner_terminal_fact",
  ].includes(effect.kind)) {
    throw new Error("transition acknowledgement requires a transition effect");
  }
  const terminal = effect.kind === "terminal_transition";
  const activated = effect.kind === "running_transition"
    || effect.kind === "execution_activate";
  const failed = effect.kind === "execution_fail"
    || effect.kind === "execution_expire_dead_owner";
  const runnerFact = "runner_fact" in effect ? effect.runner_fact : undefined;
  const runnerTerminalStatus = runnerFact === "completed"
    ? "completed"
    : runnerFact === "closed"
      ? "interrupted"
      : "error";
  const reviewState = "review_state" in effect
    ? effect.review_state
    : "not_required";
  return {
    source_seq: record.source_seq,
    event_id: record.source_seq,
    effect_application: {
      applied: true,
      canonical_session: {
        status: terminal
          ? effect.status
          : runnerFact
            ? runnerTerminalStatus
            : activated
              ? "running"
              : failed
                ? "error"
                : "initializing",
        termination_reason: terminal
          ? effect.termination_reason
          : runnerFact === "completed"
            ? "completed_ok"
            : runnerFact === "closed"
              ? "killed"
              : runnerFact
                ? "error_aborted"
                : null,
        termination_detail: "termination_detail" in effect
          ? effect.termination_detail
          : null,
        review_state: reviewState,
        last_assistant_text: "last_assistant_text" in effect
          ? effect.last_assistant_text ?? null
          : null,
        termination_event_id: terminal || runnerFact ? record.source_seq : null,
        updated_at: effect.updated_at,
        last_event_id: record.source_seq,
      },
    },
  };
}

export class MockLlmAdapter implements LlmAdapter {
  readonly complete = vi.fn(
    async (): Promise<LlmResult> => ({
      content: "Mock response",
      inputTokens: 10,
      outputTokens: 5,
    }),
  );
}

export class FailingLlmAdapter implements LlmAdapter {
  readonly complete = vi.fn(async (): Promise<LlmResult> => {
    throw new Error("API call failed: rate limited");
  });
}
