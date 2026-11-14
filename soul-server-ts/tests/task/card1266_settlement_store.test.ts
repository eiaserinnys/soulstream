import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { CompletionSettlementStore } from "../../src/task/completion_settlement_store.js";

import {
  DEDUPE_KEY,
  IDENTITY,
  makeOutboxDirectory,
  makeStore,
  settlementDirectory,
} from "./card1266_settlement_harness.js";

async function files(directory: string): Promise<string[]> {
  return (await readdir(settlementDirectory(directory))).filter((name) => name.endsWith(".json"));
}

describe("card #1266 U2b settlement store", () => {
  it("writes one file per pending under a dedicated subfolder of the outbox directory", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);

    await store.begin(IDENTITY);
    await store.begin({ ...IDENTITY, dedupeKey: "session_terminal:other:command:x", sessionId: "other" });

    expect(await files(outbox)).toHaveLength(2);
    const listed = await store.list();
    expect(listed.map((entry) => entry.dedupeKey).sort()).toEqual(
      [DEDUPE_KEY, "session_terminal:other:command:x"].sort(),
    );
    expect(listed.find((entry) => entry.dedupeKey === DEDUPE_KEY)).toMatchObject({
      sessionId: IDENTITY.sessionId,
      registrationId: "registration-1",
      executionCommandId: "execute-1",
    });
  });

  it("survives a restart: a new store instance on the same directory reads the entry with its later writes", async () => {
    const outbox = await makeOutboxDirectory();
    const first = makeStore(outbox);
    await first.begin(IDENTITY);
    await first.recordAppended(DEDUPE_KEY, { streamId: "stream-1", sourceSeq: 7 });
    await first.recordApplied(DEDUPE_KEY, 41);

    const second = makeStore(outbox);
    expect(await second.list()).toEqual([
      expect.objectContaining({ dedupeKey: DEDUPE_KEY, streamId: "stream-1", sourceSeq: 7, terminationEventId: 41 }),
    ]);
  });

  it("starts over when the same terminal begins again, dropping the old coordinate and number", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);
    await store.begin(IDENTITY);
    await store.recordAppended(DEDUPE_KEY, { streamId: "stream-1", sourceSeq: 7 });
    await store.recordApplied(DEDUPE_KEY, 41);

    await store.begin(IDENTITY);

    const [entry] = await store.list();
    expect(entry?.sourceSeq).toBeUndefined();
    expect(entry?.terminationEventId).toBeUndefined();
  });

  it("leaves no temporary file behind and ignores a stray one", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);
    await store.begin(IDENTITY);
    await writeFile(join(settlementDirectory(outbox), "stray.json.tmp"), "{", "utf8");

    expect(await store.list()).toHaveLength(1);
    expect((await readdir(settlementDirectory(outbox))).filter((name) => name.endsWith(".tmp"))).toEqual(["stray.json.tmp"]);
  });

  it("moves a broken file to quarantine with a warning instead of deleting it", async () => {
    const outbox = await makeOutboxDirectory();
    const warn = vi.fn();
    const store = new CompletionSettlementStore(outbox, { warn, info: vi.fn() });
    await store.begin(IDENTITY);
    const [name] = await files(outbox);
    const path = join(settlementDirectory(outbox), name!);
    await writeFile(path, "{not json", "utf8");

    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    const quarantined = await readdir(join(settlementDirectory(outbox), "quarantine"));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(settlementDirectory(outbox), "quarantine", quarantined[0]!), "utf8")).toBe("{not json");
  });

  it("quarantines a well-formed file that is not an entry", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);
    await mkdir(settlementDirectory(outbox), { recursive: true });
    await writeFile(join(settlementDirectory(outbox), "a.json"), JSON.stringify({ version: 2 }), "utf8");

    expect(await store.list()).toEqual([]);
    expect(await readdir(join(settlementDirectory(outbox), "quarantine"))).toHaveLength(1);
  });

  it("keeps entries the normal path holds out of the sweep list and never expires the hold by time", async () => {
    const outbox = await makeOutboxDirectory();
    let nowMs = 1_000;
    const store = new CompletionSettlementStore(outbox, pino({ level: "silent" }), () => nowMs);
    await store.begin(IDENTITY);

    expect(await store.listUnheld()).toEqual([]);
    expect(await store.closeUnlessHeld(DEDUPE_KEY)).toBe(false);
    expect(await store.list()).toHaveLength(1);

    // 시간이 아무리 지나도 쥠은 정상 길이 놓을 때까지 남는다(10분 만료가 경합을 열었다).
    nowMs += 24 * 60 * 60_000;
    expect(await store.listUnheld()).toEqual([]);
    expect(await store.closeUnlessHeld(DEDUPE_KEY)).toBe(false);

    store.release(DEDUPE_KEY);
    expect(await store.listUnheld()).toHaveLength(1);
    expect(await store.closeUnlessHeld(DEDUPE_KEY)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("skips every entry of a session while the normal path holds any entry of that session", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);
    const OLD_KEY = `${DEDUPE_KEY}-old`;
    await store.begin({ ...IDENTITY, dedupeKey: OLD_KEY });
    store.release(OLD_KEY);
    await store.begin({ ...IDENTITY, sessionId: "other", dedupeKey: "session_terminal:other:x" });
    store.release("session_terminal:other:x");
    // 같은 세션의 새 종료를 정상 길이 쥔다.
    await store.begin(IDENTITY);

    expect(store.isSessionHeld(IDENTITY.sessionId)).toBe(true);
    expect((await store.listUnheld()).map((entry) => entry.dedupeKey)).toEqual(["session_terminal:other:x"]);

    store.release(DEDUPE_KEY);
    expect(store.isSessionHeld(IDENTITY.sessionId)).toBe(false);
    expect(await store.listUnheld()).toHaveLength(3);
  });

  it("discards an unappended terminal only when the outbox has no line for it", async () => {
    const outbox = await makeOutboxDirectory();
    const lines = new Set<string>();
    const store = new CompletionSettlementStore(outbox, pino({ level: "silent" }), Date.now, {
      findBySemanticDedupeKey: async (key) => (lines.has(key) ? { source_seq: 1 } : null),
    });

    await store.begin(IDENTITY);
    expect(await store.discardUnlessAppended(DEDUPE_KEY)).toBe(true);
    expect(await store.list()).toEqual([]);

    // 붙이기가 줄을 쓴 뒤 던졌다: 줄이 있으면 미결을 남기고 쥠을 푼다.
    await store.begin(IDENTITY);
    lines.add(DEDUPE_KEY);
    expect(await store.discardUnlessAppended(DEDUPE_KEY)).toBe(false);
    expect(await store.list()).toHaveLength(1);
    expect(await store.listUnheld()).toHaveLength(1);
  });

  it("keeps the pending entry when the outbox lookup itself fails", async () => {
    const outbox = await makeOutboxDirectory();
    const store = new CompletionSettlementStore(outbox, pino({ level: "silent" }), Date.now, {
      findBySemanticDedupeKey: async () => { throw new Error("outbox unreadable"); },
    });
    await store.begin(IDENTITY);

    expect(await store.discardUnlessAppended(DEDUPE_KEY)).toBe(false);
    expect(await store.list()).toHaveLength(1);
    expect(await store.listUnheld()).toHaveLength(1);
  });

  it("closes every entry of a session and reports pending per session", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);
    await store.begin(IDENTITY);
    await store.begin({ ...IDENTITY, dedupeKey: `${DEDUPE_KEY}-2` });
    await store.begin({ ...IDENTITY, sessionId: "other", dedupeKey: "session_terminal:other:x" });

    expect(await store.hasPendingForSession(IDENTITY.sessionId)).toBe(true);
    await store.closeAllForSession(IDENTITY.sessionId);

    expect(await store.hasPendingForSession(IDENTITY.sessionId)).toBe(false);
    expect(await store.hasPendingForSession("other")).toBe(true);
  });

  it("ignores a late write for an entry that was already closed", async () => {
    const outbox = await makeOutboxDirectory();
    const store = makeStore(outbox);
    await store.begin(IDENTITY);
    await store.close(DEDUPE_KEY);

    await store.recordApplied(DEDUPE_KEY, 41);

    expect(await store.list()).toEqual([]);
  });
});
