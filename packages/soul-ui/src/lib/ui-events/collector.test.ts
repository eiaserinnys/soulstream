import { describe, expect, it } from "vitest";

import {
  createUiEventCollector,
  createUiEventEntryHint,
  type QueuedUiEvent,
  type UiEventClientConfig,
  type UiEventEnvelope,
  type UiEventOwner,
  type UiEventPayload,
  type UiEventQueueSnapshot,
  type UiEventQueueStorage,
  type UiEventTransportResult,
} from "./collector";
import { createUiEventEntryHint as hintFromBarrel } from "./index";

const ENVELOPE: UiEventEnvelope = {
  installId: "install-a",
  clientSessionKey: "tab-a",
  appVersion: "1.0.0",
};
const OWNER: UiEventOwner = { origin: "https://soul.test", userEmail: "owner@example.com" };
const ON: UiEventClientConfig = {
  enabled: true,
  flushIntervalMs: 10_000,
  maxBatchSize: 20,
  maxQueueSize: 500,
};

function memoryStorage(initial: UiEventQueueSnapshot | null = null) {
  let snapshot = initial;
  const storage: UiEventQueueStorage & { current: () => UiEventQueueSnapshot | null } = {
    read: () => snapshot,
    write: (next) => { snapshot = next; },
    clear: () => { snapshot = null; },
    current: () => snapshot,
  };
  return storage;
}

type Sent = { envelope: UiEventEnvelope; events: readonly UiEventPayload[] };

function harness(options: {
  config?: UiEventClientConfig;
  storage?: ReturnType<typeof memoryStorage>;
  owner?: UiEventOwner;
  results?: UiEventTransportResult[];
} = {}) {
  const sent: Sent[] = [];
  const results = options.results ?? [];
  let clock = Date.parse("2026-09-21T00:00:00.000Z");
  let counter = 0;
  const storage = options.storage ?? memoryStorage();
  const collector = createUiEventCollector({
    envelope: ENVELOPE,
    owner: options.owner ?? OWNER,
    storage,
    transport: async (envelope, events) => {
      sent.push({ envelope, events });
      return results.shift() ?? { kind: "ok" };
    },
    now: () => new Date((clock += 1000)),
    newId: () => `event-${++counter}`,
    config: options.config ?? ON,
  });
  return { collector, sent, storage };
}

describe("ui event collector", () => {
  it("records nothing while collection is off", () => {
    const { collector } = harness({ config: { ...ON, enabled: false } });
    collector.track("view_open");
    expect(collector.pending()).toHaveLength(0);
  });

  it("sends nothing while collection is off, even from a restored queue", async () => {
    // 부팅 설정이 아직/영영 안 왔을 때 타이머가 영속 큐를 대신 내보내면 안 된다.
    const stored: QueuedUiEvent = {
      envelope: ENVELOPE,
      event: { eventId: "old-1", seq: 1, occurredAt: "2026-09-20T10:00:00.000Z", type: "view_open" },
    };
    const storage = memoryStorage({ owner: OWNER, items: [stored] });
    const { collector, sent } = harness({ storage, config: { ...ON, enabled: false } });

    expect(collector.pending()).toHaveLength(1);
    await collector.flush();

    expect(sent).toHaveLength(0);
    expect(collector.pending()).toHaveLength(1);
  });

  it("sends the restored queue once collection is switched on", async () => {
    const stored: QueuedUiEvent = {
      envelope: ENVELOPE,
      event: { eventId: "old-1", seq: 1, occurredAt: "2026-09-20T10:00:00.000Z", type: "view_open" },
    };
    const storage = memoryStorage({ owner: OWNER, items: [stored] });
    const { collector, sent } = harness({ storage, config: { ...ON, enabled: false } });

    collector.setConfig(ON);
    await collector.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events[0]?.eventId).toBe("old-1");
    expect(collector.pending()).toHaveLength(0);
  });

  it("numbers events monotonically within one run", () => {
    const { collector } = harness();
    collector.track("view_open");
    collector.track("view_open");
    collector.track("app_active");
    expect(collector.pending().map((item) => item.event.seq)).toEqual([1, 2, 3]);
  });

  it("stamps every queued event with the envelope it was born under", () => {
    const { collector } = harness();
    collector.track("view_open");
    expect(collector.pending()[0]?.envelope).toEqual(ENVELOPE);
  });

  it("flushes on its own once the batch size is reached", async () => {
    const { collector, sent } = harness({ config: { ...ON, maxBatchSize: 3 } });
    collector.track("view_open");
    collector.track("view_open");
    expect(sent).toHaveLength(0);
    collector.track("view_open");
    await collector.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(3);
  });

  it("drops the oldest events instead of growing without bound", () => {
    const { collector } = harness({ config: { ...ON, maxBatchSize: 1000, maxQueueSize: 3 } });
    for (let index = 0; index < 5; index += 1) collector.track("view_open");
    const pending = collector.pending();
    expect(pending).toHaveLength(3);
    expect(pending.map((item) => item.event.seq)).toEqual([3, 4, 5]);
  });

  it("keeps a failed batch queued for the next attempt", async () => {
    const { collector, sent } = harness({ results: [{ kind: "retry" }] });
    collector.track("view_open");
    await collector.flush();
    expect(sent).toHaveLength(1);
    expect(collector.pending()).toHaveLength(1);

    await collector.flush();
    expect(sent).toHaveLength(2);
    expect(collector.pending()).toHaveLength(0);
  });

  it("gives up on a batch the server can never accept", async () => {
    // 413·422는 다시 보내도 답이 같다. 분할 재시도 경로를 두지 않는다.
    const { collector, sent } = harness({ results: [{ kind: "permanent" }] });
    collector.track("view_open");
    await collector.flush();
    expect(collector.pending()).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("removes only what it actually sent, never what arrived meanwhile", async () => {
    const storage = memoryStorage();
    const sent: Sent[] = [];
    let counter = 0;
    let collectorRef: ReturnType<typeof createUiEventCollector> | null = null;
    const collector = createUiEventCollector({
      envelope: ENVELOPE,
      owner: OWNER,
      storage,
      transport: async (envelope, events) => {
        sent.push({ envelope, events });
        // 전송이 진행되는 동안 새 이벤트가 들어온다.
        collectorRef?.track("app_active");
        return { kind: "ok" };
      },
      now: () => new Date(),
      newId: () => `event-${++counter}`,
      config: { ...ON, maxBatchSize: 1 },
    });
    collectorRef = collector;

    collector.track("view_open");
    await collector.flush();

    const remaining = collector.pending().map((item) => item.event.type);
    expect(remaining).toContain("app_active");
    expect(remaining).not.toContain("view_open");
  });

  it("batches each run separately instead of relabelling old events", async () => {
    const oldRun: QueuedUiEvent = {
      envelope: { installId: "install-a", clientSessionKey: "tab-old", appVersion: "0.9.0" },
      event: {
        eventId: "old-1",
        seq: 7,
        occurredAt: "2026-09-20T10:00:00.000Z",
        type: "view_open",
      },
    };
    const storage = memoryStorage({ owner: OWNER, items: [oldRun] });
    const { collector, sent } = harness({ storage });

    collector.track("view_open");
    await collector.flush();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.envelope.clientSessionKey).toBe("tab-old");
    expect(sent[0]?.events[0]).toMatchObject({ eventId: "old-1", seq: 7 });
    expect(sent[1]?.envelope.clientSessionKey).toBe("tab-a");
  });

  it("adopts a queue left by the same owner", () => {
    const stored: QueuedUiEvent = {
      envelope: ENVELOPE,
      event: { eventId: "old-1", seq: 1, occurredAt: "2026-09-20T10:00:00.000Z", type: "view_open" },
    };
    const storage = memoryStorage({ owner: OWNER, items: [stored] });
    const { collector } = harness({ storage });
    expect(collector.pending()).toHaveLength(1);
  });

  it("throws away a queue that belongs to another user", () => {
    const stored: QueuedUiEvent = {
      envelope: ENVELOPE,
      event: { eventId: "old-1", seq: 1, occurredAt: "2026-09-20T10:00:00.000Z", type: "view_open" },
    };
    const storage = memoryStorage({
      owner: { origin: OWNER.origin, userEmail: "someone-else@example.com" },
      items: [stored],
    });
    const { collector } = harness({ storage });
    expect(collector.pending()).toHaveLength(0);
    expect(storage.current()).toBeNull();
  });

  it("throws away a queue that belongs to another server", () => {
    const stored: QueuedUiEvent = {
      envelope: ENVELOPE,
      event: { eventId: "old-1", seq: 1, occurredAt: "2026-09-20T10:00:00.000Z", type: "view_open" },
    };
    const storage = memoryStorage({
      owner: { origin: "https://other.test", userEmail: OWNER.userEmail },
      items: [stored],
    });
    const { collector } = harness({ storage });
    expect(collector.pending()).toHaveLength(0);
  });

  it("discards unsent events and clears storage on demand", () => {
    // 로그아웃·사용자 전환에서 부른다. 남겨 두면 다음 사람의 화면 뒤에 남는다.
    const { collector, storage } = harness();
    collector.track("view_open");
    collector.persist();
    expect(storage.current()?.items).toHaveLength(1);
    collector.discard();
    expect(collector.pending()).toHaveLength(0);
    expect(storage.current()).toBeNull();
  });

  it("discards unsent events when collection is switched off", () => {
    const { collector, storage } = harness();
    collector.track("view_open");
    collector.setConfig({ ...ON, enabled: false });
    expect(collector.pending()).toHaveLength(0);
    expect(storage.current()).toBeNull();
  });

  it("persists only what is still waiting", async () => {
    const { collector, storage } = harness({ results: [{ kind: "retry" }] });
    collector.track("view_open");
    await collector.flush();
    expect(storage.current()?.items).toHaveLength(1);

    await collector.flush();
    expect(storage.current()).toBeNull();
  });

  it("swallows a broken storage instead of breaking the caller", () => {
    const hostile: UiEventQueueStorage = {
      read: () => { throw new Error("quota"); },
      write: () => { throw new Error("quota"); },
      clear: () => { throw new Error("quota"); },
    };
    const warnings: string[] = [];
    const collector = createUiEventCollector({
      envelope: ENVELOPE,
      owner: OWNER,
      storage: hostile,
      transport: async () => ({ kind: "ok" }),
      now: () => new Date(),
      newId: () => "event-1",
      config: ON,
      onWarning: (message) => warnings.push(message),
    });
    expect(() => collector.track("view_open")).not.toThrow();
    expect(() => collector.persist()).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("treats a thrown transport as retryable rather than losing the events", async () => {
    const collector = createUiEventCollector({
      envelope: ENVELOPE,
      owner: OWNER,
      storage: memoryStorage(),
      transport: async () => { throw new Error("offline"); },
      now: () => new Date(),
      newId: () => "event-1",
      config: ON,
    });
    collector.track("view_open");
    await expect(collector.flush()).resolves.toBeUndefined();
    expect(collector.pending()).toHaveLength(1);
  });

  it("never carries draft text, only its length", () => {
    const { collector } = harness();
    collector.track("compose_abandon", {
      flowId: "compose-1",
      attrs: { draftPresent: true, draftLength: 25 },
    });
    expect(JSON.stringify(collector.pending())).not.toContain("draftText");
    expect(collector.pending()[0]?.event.attrs).toEqual({ draftPresent: true, draftLength: 25 });
  });
});

describe("entry hint", () => {
  it("is read exactly once", () => {
    const hint = createUiEventEntryHint(() => 0);
    hint.mark("search");
    expect(hint.consume()).toBe("search");
    expect(hint.consume()).toBeNull();
  });

  it("expires so a stale hint cannot attach to a later navigation", () => {
    let clock = 0;
    const hint = createUiEventEntryHint(() => clock, 1000);
    hint.mark("feed");
    clock = 5000;
    expect(hint.consume()).toBeNull();
  });

  it("is the same helper the barrel exports", () => {
    expect(hintFromBarrel).toBe(createUiEventEntryHint);
  });
});

describe("entry provenance", () => {
  it("attaches the hint left by the click that caused the navigation", () => {
    const { collector } = harness();
    collector.markEntry("feed");
    collector.track("view_open", { target: { kind: "session", id: "s1" } });
    expect(collector.pending()[0]?.event.entry).toBe("feed");
  });

  it("falls back to a plain navigation when nothing marked the way in", () => {
    const { collector } = harness();
    collector.track("view_open", { target: { kind: "session", id: "s1" } });
    expect(collector.pending()[0]?.event.entry).toBe("nav");
  });

  it("does not reuse one hint for a second navigation", () => {
    const { collector } = harness();
    collector.markEntry("search");
    collector.track("view_open", { target: { kind: "session", id: "s1" } });
    collector.track("view_open", { target: { kind: "session", id: "s2" } });
    expect(collector.pending().map((item) => item.event.entry)).toEqual(["search", "nav"]);
  });

  it("lets an explicit entry win over any hint, so auto stays auto", () => {
    // 피드 자동선택처럼 사용자가 누르지 않은 전환은 반드시 auto 로 남아야 한다.
    const { collector } = harness();
    collector.markEntry("feed");
    collector.track("view_open", { target: { kind: "session", id: "s1" }, entry: "auto" });
    expect(collector.pending()[0]?.event.entry).toBe("auto");
  });

  it("leaves other event types alone", () => {
    const { collector } = harness();
    collector.markEntry("feed");
    collector.track("app_active");
    expect(collector.pending()[0]?.event.entry).toBeUndefined();
  });
});
