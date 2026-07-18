import { describe, expect, it } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  SNAPSHOT_REFETCH_REASONS,
  loadContractFixtures,
  resolveSseResumeCursor,
  type SessionStreamEvent,
} from "../src/index.js";

describe("SSE replay broadcaster primitive", () => {
  const fixture = loadContractFixtures().sseReplayGap;
  const instanceId = "current-instance-id";

  it("replays session stream events after Last-Event-ID", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
    });

    for (const event of fixture.sessionStream.events) {
      broadcaster.append(event as SessionStreamEvent);
    }

    const cursor = resolveSseResumeCursor({
      lastEventIdHeader: fixture.common.resumeInputs.lastEventIdHeader,
      lastEventIdQuery: fixture.common.resumeInputs.lastEventIdQuery,
      instanceIdQuery: instanceId,
    });
    const replay = broadcaster.replayFromCursor(cursor);

    expect(replay.gap).toBe(false);
    expect(replay.snapshotRefetch).toBe(false);
    expect(replay.events.map((event) => event.id)).toEqual(
      fixture.sessionStream.expectedReplayEventIds,
    );
    expect(replay.events.map((event) => event.payload.type)).toEqual([
      "session_updated",
      "session_deleted",
    ]);
    expect(replay.streamMeta).toEqual({
      ...fixture.common.streamMeta,
      instance_id: instanceId,
    });
  });

  it("uses ring oldest/latest/maxlen to decide ring-gap snapshot refetch", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
      ringMaxlen: fixture.gap.ringMaxlen,
    });

    for (const event of fixture.sessionStream.events) {
      broadcaster.append(event as SessionStreamEvent);
    }

    const ringGap = broadcaster.replaySince(
      fixture.gap.lastEventIdBeforeOldest,
      instanceId,
    );

    expect(broadcaster.ringMaxlen).toBe(2);
    expect(broadcaster.oldestBufferedEventId).toBe(2);
    expect(ringGap).toMatchObject({
      gap: true,
      gapReason: "ring_gap",
      snapshotRefetch: true,
      latestId: fixture.gap.expectedLatestId,
      events: [],
    });
  });

  it("requires snapshot refetch on instance mismatch", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
    });

    for (const event of fixture.sessionStream.events) {
      broadcaster.append(event as SessionStreamEvent);
    }

    const mismatch = broadcaster.replaySince(fixture.sessionStream.resumeFrom, "stale-instance");

    expect(mismatch).toMatchObject({
      gap: true,
      gapReason: "instance_mismatch",
      snapshotRefetch: true,
      latestId: fixture.gap.expectedLatestId,
      events: [],
    });
    expect(SNAPSHOT_REFETCH_REASONS).toEqual(fixture.common.snapshotRefetchOn);
  });

  it("trims the ring to maxlen on append", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
      ringMaxlen: fixture.gap.ringMaxlen,
    });

    const appended = fixture.sessionStream.events.map((event) =>
      broadcaster.append(event as SessionStreamEvent),
    );

    expect(appended.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(broadcaster.latestEventId).toBe(3);
    expect(broadcaster.bufferedEvents.map((event) => event.id)).toEqual([2, 3]);
    expect(broadcaster.bufferedEvents.map((event) => event.payload.type)).toEqual([
      "session_updated",
      "session_deleted",
    ]);
  });

  it("broadcasts appended events to in-memory subscribers", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
    });
    const received: Array<number> = [];
    const unsubscribe = broadcaster.subscribe((event) => {
      received.push(event.id);
    });

    broadcaster.append(fixture.sessionStream.events[0] as SessionStreamEvent);
    unsubscribe();
    broadcaster.append(fixture.sessionStream.events[1] as SessionStreamEvent);

    expect(received).toEqual([1]);
  });
});
