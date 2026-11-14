import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EVENT_OUTBOX_COMPACT_ROWS,
  EventOutbox,
  computeEventOutboxPayloadHash,
} from "../../src/upstream/event_outbox.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";

import {
  DEDUPE_KEY,
  centralRow,
  makeNotifier,
  makeOutboxDirectory,
  makeStore,
  makeSweeper,
  makeTask,
  silentLogger,
} from "./card1266_settlement_harness.js";

/**
 * 노드가 종료를 올린 직후 재시작해도 부른 세션이 완료 보고를 받는다(설계 I3, 모형 약속 9).
 * 실제 아웃박스 파일과 미결 파일을 디스크에 두고, 같은 디렉터리를 새 노드가 다시 연다.
 */

type CrashPoint = "after_append" | "append_without_coordinate" | "after_ack_before_register";

interface Node {
  outbox: EventOutbox;
  store: ReturnType<typeof makeStore>;
}

async function openNode(directory: string): Promise<Node> {
  return { outbox: await EventOutbox.open(directory), store: makeStore(directory) };
}

/**
 * 종료 하나를 올리다 정해진 자리에서 죽는 첫 번째 노드를 흉내 낸다. 죽은 프로세스는 아무 정리도
 * 하지 못하므로 그 자리에서 영영 돌아오지 않는 약속으로 멈추고, 시험은 그 약속을 기다리지 않는다.
 */
async function runFirstNode(
  directory: string,
  crash: CrashPoint,
  prepareOutbox?: (node: Node) => Promise<void>,
) {
  const node = await openNode(directory);
  const forever = new Promise<never>(() => {});
  let died!: () => void;
  const crashed = new Promise<void>((resolve) => { died = resolve; });
  const persistence = {
    enqueueTerminalTransitionAndWaitForApplication: async (
      sessionId: string,
      event: { _dedupe_key: string },
      effect: unknown,
      registrationId: string | undefined,
      onAppended: (record: unknown) => Promise<void>,
    ) => {
      const record = await node.outbox.append({
        session_id: sessionId,
        ...(registrationId === undefined ? {} : { registration_id: registrationId }),
        event_type: "session_ended",
        payload: event,
        searchable_text: null,
        created_at: "2026-11-14T00:05:00.000Z",
        semantic_dedupe_key: event._dedupe_key,
        session_effect: effect as never,
      });
      if (crash === "append_without_coordinate") {
        died();
        return await forever;
      }
      await onAppended(record);
      if (crash === "after_append") {
        died();
        return await forever;
      }
      await prepareOutbox?.(node);
      await node.outbox.acknowledge(node.outbox.streamId, record.source_seq);
      return {
        eventId: 41, applied: true,
        canonicalSession: {
          status: "completed", termination_reason: "completed_ok", termination_detail: null,
          review_state: "not_required", last_assistant_text: "child final answer",
          termination_event_id: 41, updated_at: "2026-11-14T00:05:00.000Z", last_event_id: 41,
        },
        canonicalExecutionRegistration: null,
      };
    },
  };
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: persistence as never,
    settlement: node.store,
    completionNotifier: { notify: async () => { died(); return await forever; } },
  } as never);
  const task = makeTask({ terminationEventRecorded: false });
  void (async () => {
    const result = await transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    await transition.notifyCompletionIfApplied(task, result);
  })().catch(() => undefined);
  await crashed;
}

async function runRestartedNode(directory: string, rows: Map<string, Record<string, unknown>>, central: () => ReturnType<typeof centralRow> | null) {
  const node = await openNode(directory);
  const harness = makeNotifier(rows);
  const sweeper = makeSweeper({
    store: node.store, outbox: node.outbox, central: async () => central(), notifier: harness.notifier,
  });
  return { ...node, ...harness, sweeper };
}

describe("card #1266 U2b restart right after the terminal goes up", () => {
  it("registers exactly once after a restart between the outbox append and the ack, and waits until the ack arrives", async () => {
    const directory = await makeOutboxDirectory();
    await runFirstNode(directory, "after_append");

    const rows = new Map<string, Record<string, unknown>>();
    const restarted = await runRestartedNode(directory, rows, () => centralRow());
    await restarted.sweeper.sweepOnce();
    // 아웃박스가 아직 그 종료를 ACK하지 않았으므로 기다린다.
    expect(restarted.repository.register).not.toHaveBeenCalled();
    expect(await restarted.store.list()).toHaveLength(1);

    await restarted.outbox.acknowledge(restarted.outbox.streamId, 1);
    await restarted.sweeper.sweepOnce();
    await restarted.sweeper.sweepOnce();

    expect(restarted.repository.register).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
    expect(await restarted.store.list()).toEqual([]);
  });

  it("finds the line by its semantic key when the node died before the coordinate was written", async () => {
    const directory = await makeOutboxDirectory();
    await runFirstNode(directory, "append_without_coordinate");

    const rows = new Map<string, Record<string, unknown>>();
    const restarted = await runRestartedNode(directory, rows, () => centralRow());
    expect((await restarted.store.list())[0]?.sourceSeq).toBeUndefined();
    await restarted.sweeper.sweepOnce();
    expect(restarted.repository.register).not.toHaveBeenCalled();

    await restarted.outbox.acknowledge(restarted.outbox.streamId, 1);
    await restarted.sweeper.sweepOnce();

    expect(rows.size).toBe(1);
    expect(await restarted.store.list()).toEqual([]);
  });

  it("registers exactly once after a restart between the ack and the registration", async () => {
    const directory = await makeOutboxDirectory();
    await runFirstNode(directory, "after_ack_before_register");

    const rows = new Map<string, Record<string, unknown>>();
    const restarted = await runRestartedNode(directory, rows, () => centralRow());
    expect(await restarted.store.list()).toEqual([
      expect.objectContaining({ sourceSeq: 1, terminationEventId: 41 }),
    ]);
    await restarted.sweeper.sweepOnce();
    await restarted.sweeper.sweepOnce();

    expect(restarted.repository.register).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it("registers exactly once even when the outbox compaction already removed the acknowledged terminal line", async () => {
    const directory = await makeOutboxDirectory();
    // 종료 줄 뒤에 응답받은 줄이 쌓여 압축이 종료 줄을 지운다. 좌표를 적기 전에 죽은 것과 같은 상태다.
    await runFirstNode(directory, "append_without_coordinate");
    const first = await EventOutbox.open(directory);
    const streamId = first.streamId;
    const lines = (await readFile(join(directory, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
    const filler = (seq: number) => {
      const unsigned = {
        stream_id: streamId, source_seq: seq, session_id: "filler", event_type: "assistant_message",
        payload: { seq }, searchable_text: null, created_at: "2026-11-14T00:05:01.000Z",
        semantic_dedupe_key: null, session_effect: null,
      };
      return JSON.stringify({ ...unsigned, payload_hash: computeEventOutboxPayloadHash(unsigned) });
    };
    const fillerLines = Array.from({ length: EVENT_OUTBOX_COMPACT_ROWS }, (_, index) => filler(index + 2));
    await writeFile(
      join(directory, "events.jsonl"),
      [...lines, ...fillerLines, filler(EVENT_OUTBOX_COMPACT_ROWS + 2)].map((line) => `${line}\n`).join(""),
      "utf8",
    );
    await writeFile(
      join(directory, "metadata.json"),
      `${JSON.stringify({ stream_id: streamId, next_seq: EVENT_OUTBOX_COMPACT_ROWS + 3, acked_seq: 0 })}\n`,
      "utf8",
    );
    const compacting = await EventOutbox.open(directory);
    await compacting.acknowledge(streamId, EVENT_OUTBOX_COMPACT_ROWS + 1);
    expect(await compacting.findBySemanticDedupeKey(DEDUPE_KEY)).toBeNull();

    const rows = new Map<string, Record<string, unknown>>();
    const restarted = await runRestartedNode(directory, rows, () => centralRow());
    expect((await restarted.store.list())[0]?.sourceSeq).toBeUndefined();
    await restarted.sweeper.sweepOnce();
    await restarted.sweeper.sweepOnce();

    expect(restarted.repository.register).toHaveBeenCalledTimes(1);
    expect(await restarted.store.list()).toEqual([]);
  });

  it("finds the latest outbox line for a semantic key", async () => {
    const directory = await makeOutboxDirectory();
    const outbox = await EventOutbox.open(directory);
    const append = async (key: string | null) => await outbox.append({
      session_id: "s", event_type: "x", payload: {}, searchable_text: null,
      created_at: "2026-11-14T00:00:00.000Z", semantic_dedupe_key: key, session_effect: null,
    });
    await append("k");
    await append(null);
    const last = await append("k");

    expect(await outbox.findBySemanticDedupeKey("k")).toEqual({ source_seq: last.source_seq });
    expect(await outbox.findBySemanticDedupeKey("missing")).toBeNull();
  });
});
