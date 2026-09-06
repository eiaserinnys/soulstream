import { describe, expect, it } from "vitest";

import {
  LIVE_TEXT_SNAPSHOT_MAX_SESSIONS,
  LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES,
  LIVE_TEXT_SNAPSHOT_MAX_STREAMS,
  RuntimeSessionEventHub,
  type RuntimeSessionEvent,
} from "../src/index.js";

describe("RuntimeSessionEventHub live text snapshots", () => {
  it("replaces cumulative SDK text while preserving one stable stream identity", () => {
    const hub = new RuntimeSessionEventHub();
    const seen: RuntimeSessionEvent[] = [];
    hub.subscribe("sess-1", (event) => seen.push(event));

    publish(hub, { type: "text_start", item_id: "item-1", raw_event_type: "item.started" });
    publish(hub, {
      type: "text_delta",
      item_id: "item-1",
      raw_event_type: "item.updated",
      text: "hel",
    });
    publish(hub, {
      type: "text_delta",
      item_id: "item-1",
      raw_event_type: "item.updated",
      text: "hello",
    });

    const payloads = seen.map((event) => event.data.event as Record<string, unknown>);
    expect(payloads.map(({ liveSeq }) => liveSeq)).toEqual([1, 2, 3]);
    expect(new Set(payloads.map(({ streamIdentity }) => streamIdentity)).size).toBe(1);
    expect(payloads[2]).toMatchObject({ liveTextMode: "replace" });
    expect(hub.snapshotLiveText("sess-1")).toMatchObject({
      throughLiveSeq: 3,
      streams: [{ text: "hello", truncated: false, resetRequired: false }],
    });
  });

  it("appends app-server deltas using thread, turn, and item identity", () => {
    const hub = new RuntimeSessionEventHub();
    const seen: RuntimeSessionEvent[] = [];
    hub.subscribe("sess-1", (event) => seen.push(event));
    const identity = {
      raw_event_type: "item/agentMessage/delta",
      thread_id: "thread-1",
      turn_id: "turn-1",
      tool_use_id: "item-1",
    };

    publish(hub, { type: "text_start", ...identity });
    publish(hub, { type: "text_delta", text: "hel", ...identity });
    publish(hub, { type: "text_delta", text: "lo", ...identity });

    expect(seen[2]?.data.event).toMatchObject({ liveSeq: 3, liveTextMode: "append" });
    expect(hub.snapshotLiveText("sess-1").streams).toMatchObject([
      { text: "hello", recovery: "none" },
    ]);
  });

  it("marks an over-cap stream unavailable and requires durable-final recovery", () => {
    const hub = new RuntimeSessionEventHub();
    publish(hub, { type: "text_start", item_id: "item-1", raw_event_type: "item.started" });
    publish(hub, {
      type: "text_delta",
      item_id: "item-1",
      raw_event_type: "item.updated",
      text: "가".repeat(Math.ceil(LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES / 3) + 1),
    });

    expect(hub.snapshotLiveText("sess-1").streams).toEqual([
      expect.objectContaining({
        text: null,
        truncated: true,
        resetRequired: true,
        recovery: "durable_final",
      }),
    ]);
  });

  it("applies the byte cap across concurrent streams", () => {
    const hub = new RuntimeSessionEventHub();
    const part = "x".repeat(150 * 1024);
    publish(hub, {
      type: "text_delta",
      item_id: "item-1",
      raw_event_type: "item.updated",
      text: part,
    });
    publish(hub, {
      type: "text_delta",
      item_id: "item-2",
      raw_event_type: "item.updated",
      text: part,
    });

    const snapshot = hub.snapshotLiveText("sess-1");
    expect(snapshot.streams).toEqual([
      expect.objectContaining({ text: part, truncated: false }),
      expect.objectContaining({ text: null, truncated: true }),
    ]);
    expect(snapshot.streams.reduce(
      (bytes, stream) => bytes + Buffer.byteLength(stream.text ?? "", "utf8"),
      0,
    )).toBeLessThanOrEqual(LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES);
  });

  it("isolates the byte cap between sessions", () => {
    const hub = new RuntimeSessionEventHub();
    const part = "x".repeat(150 * 1024);
    publish(hub, {
      type: "text_delta",
      item_id: "item-1",
      raw_event_type: "item.updated",
      text: part,
    }, "sess-1");
    publish(hub, {
      type: "text_delta",
      item_id: "item-2",
      raw_event_type: "item.updated",
      text: part,
    }, "sess-2");

    expect(hub.snapshotLiveText("sess-1").streams).toEqual([
      expect.objectContaining({ text: part, truncated: false }),
    ]);
    expect(hub.snapshotLiveText("sess-2").streams).toEqual([
      expect.objectContaining({ text: part, truncated: false }),
    ]);
  });

  it("bounds zero-byte stream and session cardinality", () => {
    const hub = new RuntimeSessionEventHub();
    const attempted = LIVE_TEXT_SNAPSHOT_MAX_SESSIONS + 25;
    for (let index = 0; index < attempted; index += 1) {
      publish(hub, {
        type: "text_delta",
        item_id: `item-${index}`,
        raw_event_type: "item.updated",
        text: "",
      }, `sess-${index}`);
    }

    const retainedStates = Reflect.get(hub, "liveTextBySession") as Map<string, unknown>;
    expect(retainedStates.size).toBe(LIVE_TEXT_SNAPSHOT_MAX_SESSIONS);
    expect(hub.snapshotLiveText("sess-0").streams).toEqual([
      expect.objectContaining({ text: null, resetRequired: true }),
    ]);
    expect(hub.snapshotLiveText("never-seen"))
      .toEqual({ throughLiveSeq: 0, streams: [] });
  });

  it("keeps an evicted append stream in durable-final recovery until its final", () => {
    const hub = new RuntimeSessionEventHub();
    const identity = {
      raw_event_type: "item/agentMessage/delta",
      thread_id: "thread-1",
      turn_id: "turn-1",
      tool_use_id: "item-1",
    };
    publish(hub, { type: "text_start", ...identity }, "sess-0");
    publish(hub, { type: "text_delta", text: "prefix", ...identity }, "sess-0");
    for (let index = 1; index <= LIVE_TEXT_SNAPSHOT_MAX_SESSIONS; index += 1) {
      publish(hub, {
        type: "text_start",
        item_id: `item-${index}`,
        raw_event_type: "item.started",
      }, `sess-${index}`);
    }

    publish(hub, { type: "text_delta", text: "suffix", ...identity }, "sess-0");

    expect(hub.snapshotLiveText("sess-0")).toMatchObject({
      streams: [{
        text: null,
        truncated: true,
        resetRequired: true,
        recovery: "durable_final",
      }],
    });
  });

  it("bounds identities within one session and decorates overflow with reset recovery", () => {
    const hub = new RuntimeSessionEventHub();
    const seen: RuntimeSessionEvent[] = [];
    hub.subscribe("sess-1", (event) => seen.push(event));
    const attempted = LIVE_TEXT_SNAPSHOT_MAX_STREAMS + 25;
    for (let index = 0; index < attempted; index += 1) {
      publish(hub, {
        type: "text_delta",
        item_id: `item-${index}`,
        raw_event_type: "item.updated",
        text: "",
      });
    }

    expect(seen).toHaveLength(attempted);
    expect(seen.at(-1)?.data.event).toMatchObject({
      liveSeq: attempted,
      liveTextMode: "replace",
    });
    const snapshot = hub.snapshotLiveText("sess-1");
    expect(snapshot.streams).toHaveLength(
      LIVE_TEXT_SNAPSHOT_MAX_STREAMS + 25,
    );
    expect(snapshot.streams.filter((stream) => stream.resetRequired)).toHaveLength(25);
  });

  it("keeps live sequences independent between sessions", () => {
    const hub = new RuntimeSessionEventHub();
    const seenOne: RuntimeSessionEvent[] = [];
    const seenTwo: RuntimeSessionEvent[] = [];
    hub.subscribe("sess-1", (event) => seenOne.push(event));
    hub.subscribe("sess-2", (event) => seenTwo.push(event));

    publish(hub, {
      type: "text_delta",
      item_id: "item-1",
      raw_event_type: "item.updated",
      text: "one",
    }, "sess-1");
    publish(hub, {
      type: "text_delta",
      item_id: "item-2",
      raw_event_type: "item.updated",
      text: "two",
    }, "sess-2");

    expect(seenOne[0]?.data.event).toMatchObject({ liveSeq: 1 });
    expect(seenTwo[0]?.data.event).toMatchObject({ liveSeq: 1 });
  });

  it("clears the partial stream only for its explicit final event", () => {
    const hub = new RuntimeSessionEventHub();
    hub.subscribe("sess-1", () => undefined);
    const identity = { item_id: "item-1", raw_event_type: "item.updated" };
    publish(hub, { type: "text_delta", text: "partial", ...identity });
    publish(hub, { type: "assistant_message", content: "not marked final", ...identity });
    expect(hub.snapshotLiveText("sess-1").streams).toHaveLength(1);

    publish(hub, {
      type: "assistant_message",
      content: "final",
      _final_for_live_stream: true,
      ...identity,
    });
    expect(hub.snapshotLiveText("sess-1")).toEqual({ throughLiveSeq: 2, streams: [] });
  });

  it("does not seed a live snapshot from an unproven prior final message", () => {
    const hub = new RuntimeSessionEventHub();
    publish(hub, {
      type: "assistant_message",
      item_id: "old-item",
      content: "prior durable final",
    });

    expect(hub.snapshotLiveText("sess-1")).toEqual({ throughLiveSeq: 0, streams: [] });
  });

  it("keeps liveSeq monotonic across idle unsubscribe and reconnect", () => {
    const hub = new RuntimeSessionEventHub();
    const unsubscribe = hub.subscribe("sess-1", () => undefined);
    const identity = { item_id: "item-1", raw_event_type: "item.updated" };
    publish(hub, { type: "text_delta", text: "partial", ...identity });
    publish(hub, { type: "text_end", ...identity });
    unsubscribe();

    const seen: RuntimeSessionEvent[] = [];
    hub.subscribe("sess-1", (event) => seen.push(event));
    publish(hub, {
      type: "text_delta",
      text: "next",
      item_id: "item-2",
      raw_event_type: "item.updated",
    });

    expect(seen[0]?.data.event).toMatchObject({ liveSeq: 3 });
    expect(hub.snapshotLiveText("sess-1").throughLiveSeq).toBe(3);
  });
});

function publish(
  hub: RuntimeSessionEventHub,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): void {
  hub.publish({
    nodeId: "node-1",
    data: {
      agent_session_id: sessionId,
      event: payload,
    },
  });
}
