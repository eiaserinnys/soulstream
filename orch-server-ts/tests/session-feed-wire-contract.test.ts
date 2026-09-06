import { describe, expect, it } from "vitest";

import fixture from "./fixtures/session-feed-v2-wire.json";
import { LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES } from
  "../src/session/session_feed_contract.js";

describe("session feed v2 exact wire fixture", () => {
  it("carries a revision on both attention values and tombstones", () => {
    const set = fixture.attentionUpsert.pending_attentions_delta["input_request:req-7"];
    const clear = fixture.attentionTombstone.pending_attentions_delta["input_request:req-7"];
    expect(set).toMatchObject({ revision: 1001, value: { sourceEventId: 1001 } });
    expect(clear).toEqual({ revision: 1002, value: null });
  });

  it("hydrates a bounded notice journal without firing historical entries", () => {
    expect(fixture.ringGapHydration).toMatchObject({
      priorClientWatermark: 995,
      session: {
        notificationWatermark: 1003,
        noticesTruncated: true,
      },
      policy: "replace_local_journal_without_firing_hydrated_notices",
    });
  });

  it("makes the text snapshot/queued-prefix sequence boundary executable", () => {
    const snapshot = fixture.textSnapshot;
    const prefix = fixture.queuedPrefixToDiscard;
    const next = fixture.nextLiveDelta;
    expect(prefix.streamIdentity).toBe(snapshot.streams[0]?.streamIdentity);
    expect(prefix.liveSeq).toBeLessThanOrEqual(snapshot.throughLiveSeq);
    expect(next.liveSeq).toBeGreaterThan(snapshot.throughLiveSeq);
  });

  it("marks capped text as unavailable and requires durable-final recovery", () => {
    expect(LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES).toBe(262_144);
    expect(fixture.truncatedTextSnapshot.streams[0]).toEqual(expect.objectContaining({
      text: null,
      truncated: true,
      resetRequired: true,
      recovery: "durable_final",
    }));
  });

  it("requires a durable timeline reset when the requested cursor has a gap", () => {
    expect(fixture.historySyncReset).toMatchObject({
      type: "history_sync",
      reset_required: true,
      reset_reason: "history_gap",
    });
  });
});
