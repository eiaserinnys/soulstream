import { describe, expect, it } from "vitest";

import wire from "../../../../orch-server-ts/tests/fixtures/session-feed-v2-wire.json";
import type { SessionUpdatedStreamEvent } from "../shared/stream-events";
import type { SoulSSEEvent } from "../shared/types";
import { toSessionSummary } from "../shared/mappers";
import { createProcessingContext } from "../stores/processing-context";
import { processEventsBatch } from "../stores/event-processor";
import {
  applySessionFeedDelta,
  hydrateNoticeBaseline,
  takeLiveSessionNotices,
  type NoticeBaseline,
} from "./session-feed-projection";

describe("server-owned session feed v2 fixture", () => {
  it("hydrates attention/notices as state and applies monotonic attention deltas", () => {
    const raw = wire.sessionListHydration.sessions[0];
    const hydrated = toSessionSummary(raw);
    expect(hydrated.pendingAttentions?.[0]?.id).toBe("input_request:req-7");
    expect(hydrated.notificationWatermark).toBe(1000);

    const upsert = wire.attentionUpsert as SessionUpdatedStreamEvent;
    const beforeUpsert = {
      ...hydrated,
      pendingAttentions: [],
      attentionRevision: 1000,
    };
    const upserted = { ...beforeUpsert, ...applySessionFeedDelta(beforeUpsert, upsert) };
    expect(upserted.pendingAttentions?.[0]?.requiresDetail).toBe(true);

    const tombstone = wire.attentionTombstone as SessionUpdatedStreamEvent;
    const cleared = { ...upserted, ...applySessionFeedDelta(upserted, tombstone) };
    expect(cleared.pendingAttentions).toEqual([]);
    expect(cleared.attentionRevision).toBe(1002);

    const stale = { ...cleared, ...applySessionFeedDelta(cleared, upsert) };
    expect(stale.pendingAttentions).toEqual([]);
    expect(stale.attentionRevision).toBe(1002);
  });

  it("never fires hydrated notices and deduplicates a live notice delta", () => {
    const baselines = new Map<string, NoticeBaseline>();
    const hydrated = toSessionSummary(wire.sessionListHydration.sessions[0]);
    hydrateNoticeBaseline(baselines, hydrated);
    expect(baselines.get("session-a")?.watermark).toBe(1000);

    const delta = wire.noticeDelta as SessionUpdatedStreamEvent;
    expect(takeLiveSessionNotices(baselines, delta).map((notice) => notice.id)).toEqual([
      "session-a:1003",
    ]);
    expect(takeLiveSessionNotices(baselines, delta)).toEqual([]);

    const ringGap = toSessionSummary(wire.ringGapHydration.session);
    hydrateNoticeBaseline(baselines, ringGap);
    expect(takeLiveSessionNotices(baselines, delta)).toEqual([]);
  });

  it("installs one cumulative text prefix and drops queued/live duplicate sequences", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        { event: wire.textSnapshot as SoulSSEEvent, eventId: 0 },
        { event: wire.queuedPrefixToDiscard as SoulSSEEvent, eventId: 0 },
        { event: wire.nextLiveDelta as SoulSSEEvent, eventId: 0 },
        { event: wire.nextLiveDelta as SoulSSEEvent, eventId: 0 },
      ],
      ctx,
      null,
      "session-a",
      null,
      1003,
    );
    const textNodes = result.root?.children.filter((node) => node.type === "text") ?? [];
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0]?.content).toBe("prefix already captured then live");
  });

  it("clears an oversized partial and waits for the exact durable final", () => {
    const ctx = createProcessingContext();
    const first = processEventsBatch(
      [{ event: wire.textSnapshot as SoulSSEEvent, eventId: 0 }],
      ctx,
      null,
      "session-a",
      null,
      1003,
    );
    const reset = processEventsBatch(
      [{ event: wire.truncatedTextSnapshot as SoulSSEEvent, eventId: 0 }],
      ctx,
      first.root,
      "session-a",
      null,
      1003,
    );
    const identity = wire.truncatedTextSnapshot.streams[0].streamIdentity;
    expect(reset.root?.children.some((node) => node.id.includes(identity))).toBe(false);
    const partial = processEventsBatch(
      [{
        event: {
          type: "text_delta",
          text: "must stay hidden",
          streamIdentity: identity,
          liveSeq: 100,
          liveTextMode: "append",
        },
        eventId: 0,
      }],
      ctx,
      reset.root,
      "session-a",
      null,
      1003,
    );
    expect(partial.updated).toBe(false);

    const final = processEventsBatch(
      [{
        event: {
          type: "assistant_message",
          content: "durable complete answer",
          streamIdentity: identity,
          _final_for_live_stream: true,
        },
        eventId: 1004,
      }],
      ctx,
      partial.root,
      "session-a",
      null,
      1003,
    );
    expect(final.root?.children.filter((node) => node.type === "assistant_message"))
      .toHaveLength(1);
    expect(ctx.resetRequiredTextStreams.has(identity)).toBe(false);
  });
});
