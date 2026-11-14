import { describe, expect, it, vi } from "vitest";

import { stableScheduleId, resumeAfterLimitToolUseId } from "@soulstream/wire-schema/resume-after-limit";
import { SESSION_MODEL_FALLBACK_REASON } from "@soulstream/wire-schema/model-preset-fallbacks";

import {
  CALLER_ID,
  DEDUPE_KEY,
  IDENTITY,
  SESSION_ID,
  centralRow,
  makeNotifier,
  makeOutbox,
  makeOutboxDirectory,
  makeStore,
  makeSweeper,
  makeTask,
} from "./card1266_settlement_harness.js";

async function setup(options: {
  central?: () => Promise<ReturnType<typeof centralRow> | null>;
  entry?: { sourceSeq?: number; terminationEventId?: number } | null;
  rows?: Map<string, Record<string, unknown>>;
  notifierOptions?: Parameters<typeof makeNotifier>[1];
  reservations?: () => Promise<Array<{ scheduleId: string; toolUseId: string | null }>>;
  now?: () => number;
  storeNow?: () => number;
} = {}) {
  const directory = await makeOutboxDirectory();
  const store = makeStore(directory, options.storeNow);
  const outbox = makeOutbox();
  const rows = options.rows ?? new Map<string, Record<string, unknown>>();
  const harness = makeNotifier(rows, options.notifierOptions);
  const central = vi.fn(options.central ?? (async () => centralRow()));
  if (options.entry !== null) {
    const { hold } = await store.begin(IDENTITY);
    if (options.entry?.sourceSeq !== undefined) {
      await store.recordAppended(DEDUPE_KEY, { streamId: outbox.streamId, sourceSeq: options.entry.sourceSeq });
    }
    if (options.entry?.terminationEventId !== undefined) {
      await store.recordApplied(DEDUPE_KEY, options.entry.terminationEventId);
    }
    // 재시작했으므로 정상 길의 쥠은 없다.
    store.release(hold);
  }
  const sweeper = makeSweeper({
    store, outbox, central, notifier: harness.notifier, reservations: options.reservations, now: options.now,
  });
  return { store, outbox, rows, central, sweeper, ...harness };
}

describe("card #1266 U2b settlement sweep: waiting for the outbox", () => {
  it("waits while the outbox has not acknowledged the terminal and does not read the central session", async () => {
    const subject = await setup({ entry: { sourceSeq: 5 } });
    subject.outbox.ackedSeq = 4;

    await subject.sweeper.sweepOnce();

    expect(subject.central).not.toHaveBeenCalled();
    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toHaveLength(1);
  });

  it("finds the outbox line by the terminal's semantic key when it died before writing the coordinate", async () => {
    const subject = await setup({ entry: {} });
    subject.outbox.lines.push({ key: DEDUPE_KEY, source_seq: 9 });
    subject.outbox.ackedSeq = 8;
    await subject.sweeper.sweepOnce();
    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toHaveLength(1);

    subject.outbox.ackedSeq = 9;
    await subject.sweeper.sweepOnce();
    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("treats a compacted line (no coordinate, no line) as acknowledged and lets the central row decide", async () => {
    const subject = await setup({ entry: {} });

    await subject.sweeper.sweepOnce();

    expect(subject.central).toHaveBeenCalledOnce();
    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("does not wait for a replaced outbox stream whose line can never be acknowledged", async () => {
    const subject = await setup({ entry: { sourceSeq: 99 } });
    subject.outbox.streamId = "stream-2";
    subject.outbox.ackedSeq = 0;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
  });
});

describe("card #1266 U2b settlement sweep: which terminal is ours", () => {
  it("registers exactly once for the applied terminal and keeps registering nothing on later sweeps", async () => {
    const subject = await setup({ entry: { sourceSeq: 5, terminationEventId: 41 } });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();
    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(subject.repository.register.mock.calls[0]?.[0]).toMatchObject({
      targetSessionId: CALLER_ID,
      sourceSessionId: SESSION_ID,
      relationKey: `child_session:${SESSION_ID}:41`,
    });
    expect(await subject.store.list()).toEqual([]);
  });

  it("closes without a delivery when another terminal is applied than the number the entry recorded", async () => {
    const subject = await setup({ entry: { sourceSeq: 5, terminationEventId: 41 }, central: async () => centralRow({ termination_event_id: 60 }) });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("registers for the terminal applied now when the entry has no number, and a newer terminal shares its relation key", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const subject = await setup({ rows, entry: { sourceSeq: 5 }, central: async () => centralRow({ termination_event_id: 60 }) });
    subject.outbox.ackedSeq = 5;
    await subject.sweeper.sweepOnce();
    expect(subject.repository.register.mock.calls[0]?.[0]).toMatchObject({ relationKey: `child_session:${SESSION_ID}:60` });

    // 그 더 새 종료의 정상 길이 같은 관계 키로 등록하면 중복이 막힌다.
    const normalPath = makeNotifier(rows);
    await normalPath.notifier.notify(makeTask({ terminalEventId: 60 }));
    expect([...rows.values()]).toHaveLength(1);
  });

  it.each([
    ["central session is gone", async () => null],
    ["session is running again", async () => centralRow({ status: "running" })],
    ["no terminal was applied", async () => centralRow({ status: "error", termination_reason: null, termination_event_id: null })],
  ])("closes without a delivery when %s", async (_name, central) => {
    const subject = await setup({ entry: { sourceSeq: 5, terminationEventId: 41 }, central });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(subject.addIntervention).not.toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("leaves the entry for the next sweep when the central read fails", async () => {
    let failing = true;
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => {
        if (failing) throw new Error("central unavailable");
        return centralRow();
      },
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();
    expect(await subject.store.list()).toHaveLength(1);
    expect(subject.repository.register).not.toHaveBeenCalled();

    failing = false;
    await subject.sweeper.sweepOnce();
    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("does not touch an entry the normal path still holds", async () => {
    const subject = await setup({ entry: { sourceSeq: 5, terminationEventId: 41 } });
    subject.outbox.ackedSeq = 5;
    await subject.store.begin(IDENTITY);

    await subject.sweeper.sweepOnce();

    expect(subject.central).not.toHaveBeenCalled();
    expect(subject.repository.register).not.toHaveBeenCalled();
  });
});

describe("card #1266 U2b settlement sweep: giving up", () => {
  it("closes an entry whose attempt ended in a central read failure once it is older than the delivery retry age limit, so it does not block runner retirement forever", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => { throw new Error("central unavailable"); },
      now: () => Date.now() + 25 * 60 * 60 * 1000,
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.central).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
    expect(subject.repository.register).not.toHaveBeenCalled();
  });

  it("closes an entry whose registration still needs a retry once it is older than the limit", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      now: () => Date.now() + 25 * 60 * 60 * 1000,
    });
    subject.outbox.ackedSeq = 5;
    subject.repository.register.mockRejectedValue(new Error("store unavailable"));

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("still tries an entry older than the limit once: a node that was down for more than a day registers a healthy completion instead of dropping it", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      now: () => Date.now() + 25 * 60 * 60 * 1000,
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect([...subject.rows.values()]).toHaveLength(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("closes an entry whose outbox lookup keeps throwing once it is older than the limit, so it does not block runner retirement forever", async () => {
    // 좌표를 적기 전에 죽은 미결이라 아웃박스 줄을 종료 의미 키로 찾아야 한다. 그 조회가 계속 던진다.
    const subject = await setup({
      entry: {},
      now: () => Date.now() + 25 * 60 * 60 * 1000,
    });
    const lookup = vi.fn(async () => { throw new Error("outbox unreadable"); });
    subject.outbox.findBySemanticDedupeKey = lookup;

    await subject.sweeper.sweepOnce();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(subject.central).not.toHaveBeenCalled();
    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("keeps an entry whose outbox lookup throws while it is younger than the limit", async () => {
    const subject = await setup({
      entry: {},
      now: () => Date.now() + 23 * 60 * 60 * 1000,
    });
    subject.outbox.findBySemanticDedupeKey = async () => { throw new Error("outbox unreadable"); };

    await subject.sweeper.sweepOnce();

    expect(await subject.store.list()).toHaveLength(1);
  });

  it("still retries an entry that is younger than the limit", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => { throw new Error("central unavailable"); },
      now: () => Date.now() + 23 * 60 * 60 * 1000,
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(await subject.store.list()).toHaveLength(1);
  });
});

describe("card #1266 U2b settlement sweep: race with the normal path", () => {
  const NEW_KEY = `session_terminal:${SESSION_ID}:command:execute-2`;
  const NEW_IDENTITY = { ...IDENTITY, dedupeKey: NEW_KEY, executionCommandId: "execute-2" };

  it("skips every entry of a session while the normal path holds a newer terminal of it", async () => {
    const subject = await setup({ entry: { sourceSeq: 5 } });
    subject.outbox.ackedSeq = 5;
    await subject.store.begin(NEW_IDENTITY);

    await subject.sweeper.sweepOnce();

    expect(subject.central).not.toHaveBeenCalled();
    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toHaveLength(2);
  });

  it("closes a numberless older entry without delivery when a newer entry of the session exists; the newer entry reports", async () => {
    let tick = 1_000;
    const subject = await setup({
      entry: null,
      storeNow: () => tick,
      central: async () => centralRow({ termination_event_id: 42, last_event_id: 42 }),
    });
    subject.outbox.ackedSeq = 9;
    const older = await subject.store.begin(IDENTITY);
    tick = 2_000;
    const newer = await subject.store.begin(NEW_IDENTITY);
    await subject.store.recordApplied(NEW_KEY, 42);
    subject.store.release(older.hold);
    subject.store.release(newer.hold);
    const notify = vi.spyOn(subject.notifier, "notify");

    await subject.sweeper.sweepOnce();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(subject.central).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("does not treat a numbered older entry as superseded: the number decides", async () => {
    let tick = 1_000;
    const subject = await setup({
      entry: null,
      storeNow: () => tick,
      central: async () => centralRow({ termination_event_id: 42, last_event_id: 42 }),
    });
    subject.outbox.ackedSeq = 9;
    const older = await subject.store.begin(IDENTITY);
    await subject.store.recordApplied(DEDUPE_KEY, 41);
    tick = 2_000;
    const newer = await subject.store.begin(NEW_IDENTITY);
    await subject.store.recordApplied(NEW_KEY, 42);
    subject.store.release(older.hold);
    subject.store.release(newer.hold);
    const notify = vi.spyOn(subject.notifier, "notify");

    await subject.sweeper.sweepOnce();

    // 옛 미결은 번호가 달라 전달 없이 닫히고, 새 미결이 한 번 등록한다.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("does not register when the normal path takes the session while the sweep reads the central row", async () => {
    const holder: { store?: Awaited<ReturnType<typeof setup>>["store"] } = {};
    const subject = await setup({
      entry: { sourceSeq: 5 },
      central: async () => {
        // 중앙을 읽는 사이 정상 길이 이 세션의 새 종료를 쥔다.
        await holder.store!.begin(NEW_IDENTITY);
        return centralRow({ termination_event_id: 42, last_event_id: 42 });
      },
    });
    holder.store = subject.store;
    subject.outbox.ackedSeq = 5;
    const notify = vi.spyOn(subject.notifier, "notify");

    await subject.sweeper.sweepOnce();

    expect(notify).not.toHaveBeenCalled();
    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toHaveLength(2);
  });
});

describe("card #1266 U2b settlement sweep: registration result", () => {
  it("keeps the entry when the registration store fails and registers it on the next sweep", async () => {
    const subject = await setup({ entry: { sourceSeq: 5, terminationEventId: 41 } });
    subject.outbox.ackedSeq = 5;
    subject.repository.register.mockRejectedValueOnce(new Error("store unavailable"));

    await subject.sweeper.sweepOnce();
    expect(await subject.store.list()).toHaveLength(1);

    await subject.sweeper.sweepOnce();
    expect(await subject.store.list()).toEqual([]);
    expect([...subject.rows.values()]).toHaveLength(1);
  });

  it("counts a registration that already exists with a different body as already registered and does not kill it", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    // 정상 길이 먼저 등록했다. 되살린 본문은 한도 문구와 초상이 빠져 해시가 다르다.
    const normal = makeNotifier(rows);
    await normal.notifier.notify(makeTask({ terminalEventId: 41, lastAssistantText: "different live text" }));
    const [live] = [...rows.values()];
    const subject = await setup({ rows, entry: { sourceSeq: 5, terminationEventId: 41 } });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(rows.get(live!.delivery_id as string)?.state).not.toBe("uncertain");
    expect(await subject.store.list()).toEqual([]);
  });
});

describe("card #1266 U2b settlement sweep: skip conditions", () => {
  it.each([
    ["notifyCompletion is off", { notify_completion: false }],
    ["the caller is the session itself", { caller_session_id: SESSION_ID }],
    ["there is no caller", { caller_session_id: null }],
  ])("closes without a delivery when %s", async (_name, overrides) => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => centralRow(overrides as never),
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("delivers a human stop instead of skipping it", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => centralRow({ status: "interrupted", termination_reason: "killed", termination_detail: "user_stop" }),
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    const registered = subject.repository.register.mock.calls[0]?.[0] as { payload: { text: string } };
    expect(registered.payload.text).toContain("사람이 멈춤");
  });

  it("restores the error text from the termination detail", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => centralRow({ status: "error", termination_reason: "error_aborted", termination_detail: "boom happened" }),
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    const registered = subject.repository.register.mock.calls[0]?.[0] as { payload: { text: string } };
    expect(registered.payload.text).toContain("boom happened");
  });

  const fallbackMetadata = [{
    type: "persistent_generation",
    value: {
      number: 1,
      pending: {
        number: 2,
        reason: SESSION_MODEL_FALLBACK_REASON,
        requested_at: "2026-11-14T00:04:00.000Z",
        target_model_preset: "fallback-preset",
      },
    },
  }];

  it("skips when the next generation continues and the reservation exists in the session's schedule list", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => centralRow({ metadata: fallbackMetadata as never }),
      reservations: async () => [{
        scheduleId: stableScheduleId(SESSION_ID, 41, 0),
        toolUseId: resumeAfterLimitToolUseId(41),
      }],
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("delivers when the next generation was announced but no reservation exists", async () => {
    const subject = await setup({
      entry: { sourceSeq: 5, terminationEventId: 41 },
      central: async () => centralRow({ metadata: fallbackMetadata as never }),
      reservations: async () => [{ scheduleId: "unrelated", toolUseId: "unrelated" }],
    });
    subject.outbox.ackedSeq = 5;

    await subject.sweeper.sweepOnce();

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
  });
});
