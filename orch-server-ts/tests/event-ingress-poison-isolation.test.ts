import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NodeEventIngressController } from "../src/node/event_ingress_controller.js";
import { FileEventIngressDeadLetterStore } from "../src/node/event_ingress_dead_letter_store.js";
import {
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
} from "../src/node/event_ingress_repository.js";
import { EventIngressRetryPolicy } from "../src/node/event_ingress_retry_policy.js";
import type { EventAppendBatch } from "../src/node/event_ingress_types.js";

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
const FIXED_NOW = new Date("2026-08-13T00:00:00.000Z");

describe("event ingress poison isolation", () => {
  it("commits siblings, dead-letters an unknown poison event, and keeps the connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-ingress-poison-"));
    try {
      let nextEventId = 100;
      const appendedPayloads: string[] = [];
      const sql = fakeSql(async (text, values) => {
        if (text.includes("FROM event_ingress_receipts")) return [];
        if (text.includes("FROM sessions") && text.includes("FOR UPDATE")) {
          return [{ execution_generation: 0, execution_command_id: null }];
        }
        if (text.includes("SELECT event_append")) {
          const payload = JSON.parse(String(values[2])) as { content: string };
          if (payload.content === "poison") {
            throw Object.assign(new Error("unknown toxic payload failure"), {
              code: "TOXIC_UNKNOWN",
            });
          }
          appendedPayloads.push(payload.content);
          nextEventId += 1;
          return [{ event_id: nextEventId }];
        }
        if (text.includes("INSERT INTO event_ingress_receipts")) return [];
        if (text.includes("SELECT 1 AS event_ingress_health")) {
          return [{ event_ingress_health: 1 }];
        }
        throw new Error(`unexpected SQL: ${text}`);
      });
      const repository = new EventIngressRepository(
        { resolveSql: async () => sql },
        undefined,
        new FileEventIngressDeadLetterStore(directory, () => FIXED_NOW),
        testRetryPolicy(),
      );
      const input = batch();
      const send = vi.fn();
      const close = vi.fn();
      const publish = vi.fn();
      const logWarn = vi.fn();
      const controller = createController({
        committer: repository,
        send,
        close,
        publish,
        logWarn,
      });

      controller.enqueue(input as unknown as Record<string, unknown>);
      await controller.drain();

      expect(appendedPayloads).toEqual(["first", "third"]);
      expect(send).toHaveBeenCalledWith({
        type: "event_append_ack",
        stream_id: STREAM_ID,
        acked_through: 3,
        events: [
          { source_seq: 1, event_id: 101 },
          {
            source_seq: 2,
            dead_letter: {
              code: "REPEATED_FAILURE",
              reason: "unknown toxic payload failure",
              rejected_at: FIXED_NOW.toISOString(),
            },
          },
          { source_seq: 3, event_id: 102 },
        ],
      });
      expect(publish).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();
      const warning = logWarn.mock.calls[0]![0] as { path: string };
      const deadLetter = JSON.parse(await readFile(warning.path, "utf8")) as {
        envelope: EventAppendBatch["events"][number];
        failure_count: number;
        failures: Array<{
          reason: string;
          error_name: string;
          error_code?: string;
        }>;
      };
      expect(deadLetter.envelope).toEqual(input.events[1]);
      expect(deadLetter.failure_count).toBe(3);
      expect(deadLetter.failures.map((failure) => failure.reason)).toEqual([
        "unknown toxic payload failure",
        "unknown toxic payload failure",
        "unknown toxic payload failure",
      ]);
      expect(deadLetter.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          error_name: "Error",
          error_code: "TOXIC_UNKNOWN",
        }),
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues the exact stream, sequence, and hash failure count across orch restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-ingress-restart-"));
    try {
      const envelope = batch().events[1]!;
      const firstProcess = new FileEventIngressDeadLetterStore(
        directory,
        () => FIXED_NOW,
      );
      const failure = {
        reason: "unknown toxic payload failure",
        errorName: "Error",
      };
      await expect(
        firstProcess.recordFailure({
          nodeId: "node-a",
          envelope,
          failure,
          threshold: 3,
        }),
      ).resolves.toMatchObject({ failureCount: 1, deadLetter: null });
      await expect(
        firstProcess.recordFailure({
          nodeId: "node-a",
          envelope,
          failure,
          threshold: 3,
        }),
      ).resolves.toMatchObject({ failureCount: 2, deadLetter: null });

      const restartedProcess = new FileEventIngressDeadLetterStore(
        directory,
        () => FIXED_NOW,
      );
      const third = await restartedProcess.recordFailure({
        nodeId: "node-b",
        envelope,
        failure,
        threshold: 3,
      });

      expect(third).toMatchObject({
        failureCount: 3,
        deadLetter: { code: "REPEATED_FAILURE" },
      });
      await expect(
        restartedProcess.find({ nodeId: "node-c", envelope }),
      ).resolves.toEqual(third.deadLetter);

      const anotherPayload = {
        ...envelope,
        payload: { content: "different poison" },
        payload_hash: "d".repeat(64),
      };
      await expect(
        restartedProcess.recordFailure({
          nodeId: "node-a",
          envelope: anotherPayload,
          failure,
          threshold: 3,
        }),
      ).resolves.toMatchObject({ failureCount: 1, deadLetter: null });
      expect(await readdir(directory)).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads legacy dead letters without applying them to a different payload hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-ingress-legacy-"));
    try {
      const nodeId = "node-a";
      const original = batch().events[1]!;
      const digest = createHash("sha256")
        .update(JSON.stringify([nodeId, original.stream_id, original.source_seq]))
        .digest("hex");
      await writeFile(join(directory, `${digest}.json`), JSON.stringify({
        code: "SESSION_NOT_FOUND",
        reason: "legacy missing session",
        rejected_at: FIXED_NOW.toISOString(),
        node_id: nodeId,
        envelope: original,
      }));
      const store = new FileEventIngressDeadLetterStore(directory, () => FIXED_NOW);

      await expect(store.find({ nodeId, envelope: original })).resolves.toMatchObject({
        code: "SESSION_NOT_FOUND",
      });
      await expect(store.find({
        nodeId,
        envelope: { ...original, payload_hash: "d".repeat(64) },
      })).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not count an event failure when the independent database probe also fails", async () => {
    const unavailable = Object.assign(new Error("database unavailable"), {
      code: "57P01",
    });
    const sql = fakeSql(async () => {
      throw unavailable;
    });
    const recordFailure = vi.fn();
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      { find: vi.fn(async () => null), recordFailure },
      testRetryPolicy(),
    );

    await expect(repository.commitBatch("node-a", batch())).rejects.toBe(
      unavailable,
    );
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("fixes the default poison budget at five attempts over 3.75 seconds", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (delayMs: number) => {
      delays.push(delayMs);
    });
    const policy = new EventIngressRetryPolicy({ sleep });

    expect(policy.failureThreshold).toBe(5);
    for (const failureCount of [1, 2, 3, 4]) {
      await policy.waitForRetry([failureCount]);
    }
    expect(delays).toEqual([250, 500, 1_000, 2_000]);
  });
});

function createController(overrides: Record<string, unknown>) {
  return new NodeEventIngressController({
    nodeId: "node-a",
    connectionId: "connection-a",
    isCurrentConnection: () => true,
    committer: { commitBatch: vi.fn(async () => []) },
    receiveCommittedEvent: (message) => [
      { type: "node_session_event", nodeId: "node-a", data: message },
    ],
    publish: () => undefined,
    send: () => undefined,
    close: () => undefined,
    logError: () => undefined,
    logWarn: () => undefined,
    ...overrides,
  } as ConstructorParameters<typeof NodeEventIngressController>[0]);
}

function batch(): EventAppendBatch {
  const first = envelope(1, "first", "a");
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: 1,
    events: [first, envelope(2, "poison", "b"), envelope(3, "third", "c")],
  };
}

function envelope(sourceSeq: number, content: string, hashChar: string) {
  return {
    stream_id: STREAM_ID,
    source_seq: sourceSeq,
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { content },
    searchable_text: content,
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
    payload_hash: hashChar.repeat(64),
  } satisfies EventAppendBatch["events"][number];
}

function testRetryPolicy() {
  return {
    failureThreshold: 3,
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
  };
}

function fakeSql(
  execute: (
    text: string,
    values: unknown[],
  ) => Promise<readonly Record<string, unknown>[]>,
): EventIngressSql {
  const json = vi.fn((value: unknown) => ({ __jsonParameter: value }));
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    await execute(strings.join("?"), values)) as EventIngressQuerySql;
  const begin = vi.fn(
    async <T>(callback: (sql: EventIngressQuerySql) => Promise<T>) =>
      await callback(Object.assign(query, { json }) as EventIngressQuerySql),
  );
  return Object.assign(query, { begin, json }) as EventIngressSql;
}
