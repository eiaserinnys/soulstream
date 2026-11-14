import { join } from "node:path";

import pino from "pino";
import { vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type { SessionRow } from "../../src/db/session_db.js";
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import { CompletionSettlementStore } from "../../src/task/completion_settlement_store.js";
import {
  CompletionSettlementSweeper,
  type SettlementOutboxView,
} from "../../src/task/completion_settlement_sweeper.js";
import { hydrateEvictedTaskFromSessionRow } from "../../src/task/task_evicted_hydration.js";
import type { Task } from "../../src/task/task_models.js";
import { makeDeliveryRepository } from "./delivery_repository_test_fake.js";
import { makeTempDir } from "../helpers/temp_dir.js";

export const silentLogger = pino({ level: "silent" });
export const NODE_ID = "node-test";
export const SESSION_ID = "child-sess-1";
export const CALLER_ID = "parent-sess-1";
export const DEDUPE_KEY = `session_terminal:${SESSION_ID}:command:execute-1`;

export async function makeOutboxDirectory(): Promise<string> {
  return await makeTempDir("card1266-settlement-");
}

export function settlementDirectory(outboxDirectory: string): string {
  return join(outboxDirectory, "completion-settlements");
}

/** 중앙 세션 줄이다. 기본은 종료 사건 41이 적용된 완료 줄이다. */
export function centralRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: SESSION_ID,
    folder_id: null,
    display_name: null,
    node_id: NODE_ID,
    session_type: "claude",
    status: "completed",
    prompt: "child prompt",
    client_id: "client-1",
    claude_session_id: "thread-1",
    last_message: null,
    metadata: null,
    was_running_at_shutdown: false,
    last_event_id: 41,
    last_read_event_id: 0,
    created_at: new Date("2026-11-14T00:00:00.000Z"),
    updated_at: new Date("2026-11-14T00:05:00.000Z"),
    agent_id: "codex-default",
    caller_session_id: CALLER_ID,
    away_summary: null,
    termination_reason: "completed_ok",
    termination_detail: null,
    termination_event_id: 41,
    last_assistant_text: "child final answer",
    ...overrides,
  } as SessionRow;
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "child prompt",
    status: "completed",
    terminationReason: "completed_ok",
    profileId: "codex-default",
    callerSessionId: CALLER_ID,
    createdAt: new Date("2026-11-14T00:00:00.000Z"),
    completedAt: new Date("2026-11-14T00:05:00.000Z"),
    lastEventId: 41,
    terminalEventId: 41,
    terminationEventRecorded: true,
    lastReadEventId: 0,
    lastAssistantText: "child final answer",
    interventionQueue: [],
    executionRegistration: { registrationId: "registration-1", executionCommandId: "execute-1" },
    terminalDedupeIdentity: "command:execute-1",
    ...overrides,
  };
}

function agentRegistry(): AgentRegistry {
  return {
    get: vi.fn((id: string) => id === "codex-default"
      ? { id, name: "Codex Default", backend: "codex" as const, workspace_dir: "/tmp", portrait_path: "p.png" }
      : undefined),
  } as unknown as AgentRegistry;
}

/** 실제 알림과 orch 계약을 흉내 내는 장부 저장소다. 새 노드를 흉내 내려면 같은 rows를 다시 쓴다. */
export function makeNotifier(
  rows: Map<string, Record<string, unknown>>,
  options: { sessionLookup?: unknown; deliveryV2?: boolean } = {},
) {
  const repository = makeDeliveryRepository(rows);
  const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
  const notifier = new TaskCompletionNotifier(
    NODE_ID,
    { addIntervention } as never,
    agentRegistry(),
    vi.fn(),
    silentLogger,
    undefined,
    undefined,
    options.sessionLookup as never,
    options.deliveryV2 ?? true,
    repository as never,
  );
  return { notifier, repository, addIntervention };
}

export interface FakeOutbox extends SettlementOutboxView {
  streamId: string;
  ackedSeq: number;
  lines: Array<{ key: string; source_seq: number }>;
}

export function makeOutbox(): FakeOutbox {
  const outbox: FakeOutbox = {
    streamId: "stream-1",
    ackedSeq: 0,
    lines: [],
    findBySemanticDedupeKey: async (key: string) => {
      const found = [...outbox.lines].reverse().find((line) => line.key === key);
      return found ? { source_seq: found.source_seq } : null;
    },
  };
  return outbox;
}

export function makeSweeper(options: {
  store: CompletionSettlementStore;
  outbox: SettlementOutboxView;
  central: () => Promise<SessionRow | null>;
  notifier: { notify: TaskCompletionNotifier["notify"] };
  reservations?: () => Promise<Array<{ scheduleId: string; toolUseId: string | null }>>;
  now?: () => number;
}) {
  return new CompletionSettlementSweeper({
    store: options.store,
    outbox: options.outbox,
    readCentralSession: options.central,
    hydrate: (row) => hydrateEvictedTaskFromSessionRow(row, silentLogger),
    notifier: options.notifier,
    listReservations: options.reservations ?? (async () => []),
    logger: silentLogger,
    ...(options.now ? { now: options.now } : {}),
  });
}

export function makeStore(
  directory: string,
  now?: () => number,
  outbox?: { findBySemanticDedupeKey(key: string): Promise<unknown | null> },
) {
  return new CompletionSettlementStore(directory, silentLogger, now, outbox);
}

export const IDENTITY = {
  sessionId: SESSION_ID,
  dedupeKey: DEDUPE_KEY,
  registrationId: "registration-1",
  executionCommandId: "execute-1",
};
