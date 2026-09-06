import { describe, expect, it } from "vitest";

import wire from "../../../../orch-server-ts/tests/fixtures/session-feed-v2-wire.json";
import type { SessionUpdatedStreamEvent } from "../shared/stream-events";
import type { SoulSSEEvent } from "../shared/types";
import { toSessionSummary } from "../shared/mappers";
import { createProcessingContext } from "../stores/processing-context";
import { processEventsBatch } from "../stores/event-processor";
import {
  appendBrowserNotices,
  detailEventToSessionNotice,
} from "../shared/browser-notices";
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

  it("preserves session_notification text and deduplicates raw/detail with global notice", () => {
    const raw = detailEventToSessionNotice({
      type: "session_notification",
      delivery_id: "delivery-42",
      delivery_intent: "completion_notification",
      source: "background-agent",
      disposition: "auto_resume",
      text: "Background work finished",
      timestamp: 42,
    }, 42, "session-a");
    expect(raw).toMatchObject({
      id: "session-a:42",
      sourceEventId: 42,
      body: "Background work finished",
    });

    const global = {
      ...raw!,
      createdAt: "2026-09-07T00:00:42.000Z",
    };
    const baselines = new Map<string, NoticeBaseline>();
    const [fromGlobal] = takeLiveSessionNotices(baselines, {
      type: "session_updated",
      agent_session_id: "session-a",
      notices: [global],
      notification_watermark: 42,
    });
    expect(fromGlobal).toMatchObject({
      id: "session-a:42",
      body: "Background work finished",
    });
    expect(appendBrowserNotices([raw!], [fromGlobal])).toEqual([raw]);
    expect(appendBrowserNotices([fromGlobal], [raw!])).toEqual([fromGlobal]);
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

  it("keeps snapshot text after hydrated history and accepts a reasserted lower-id final", () => {
    const ctx = createProcessingContext();
    // A valid base64url identity may end in `-<digits>`; that suffix must not
    // be mistaken for a durable event ID while the snapshot is transient.
    const streamIdentity = "codex_sdk:aXRlbS0x-1";
    const snapshot = processEventsBatch(
      [{
        event: {
          type: "text_snapshot",
          basedOnEventId: 5,
          throughLiveSeq: 2,
          streams: [{
            streamIdentity,
            text: "partial",
            updatedAt: "2026-09-07T00:00:00.000Z",
            truncated: false,
            resetRequired: false,
            recovery: "none",
          }],
        },
        eventId: 0,
      }, {
        event: {
          type: "history_sync",
          last_event_id: 5,
          is_live: true,
          reset_required: false,
        },
        eventId: 0,
      }],
      ctx,
      null,
      "session-a",
      null,
      0,
    );

    const hydrated = processEventsBatch(
      [{
        event: { type: "user_message", text: "oldest" },
        eventId: 1,
      }, {
        event: { type: "system_message", text: "newer durable" },
        eventId: 5,
      }],
      ctx,
      snapshot.root,
      "session-a",
      null,
      5,
      true,
    );
    expect(hydrated.root?.children.map((node) => node.id)).toEqual([
      "user-msg-1",
      "system-msg-5",
      `text-live:${streamIdentity}`,
    ]);

    const liveTail = processEventsBatch(
      [{
        event: {
          type: "text_delta",
          text: "stale live tail",
          streamIdentity,
          liveSeq: 3,
          liveTextMode: "replace",
        },
        eventId: 0,
      }],
      ctx,
      hydrated.root,
      "session-a",
      null,
      5,
    );
    const finalized = processEventsBatch(
      [{
        event: {
          type: "assistant_message",
          content: "durable complete",
          streamIdentity,
          _final_for_live_stream: true,
        },
        eventId: 4,
      }],
      ctx,
      liveTail.root,
      "session-a",
      null,
      5,
    );

    expect(finalized.maxEventId).toBe(5);
    expect(finalized.root?.children.map((node) => node.id)).toEqual([
      "user-msg-1",
      `text-live:${streamIdentity}`,
      "system-msg-5",
    ]);
    expect(finalized.root?.children[1]).toMatchObject({
      type: "text",
      content: "durable complete",
      completed: true,
      textCompleted: true,
      eventId: 4,
    });
  });
});
