import { describe, expect, it } from "vitest";

import { createPageUpdatedEmitter } from "../src/runtime/page_updated_broadcaster.js";
import {
  InMemorySseReplayBroadcaster,
  type SessionStreamEvent,
} from "../src/sse/replay_broadcaster.js";

describe("page_updated session stream broadcaster", () => {
  it("appends the additive wire contract to the shared replay ring", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "orch-a",
    });
    const emit = createPageUpdatedEmitter(broadcaster);

    emit({ pageId: "page-1", version: 7 });

    expect(broadcaster.bufferedEvents).toEqual([{
      id: 1,
      payload: { type: "page_updated", page_id: "page-1", version: 7 },
    }]);
    expect(Object.keys(broadcaster.bufferedEvents[0]!.payload).sort()).toEqual([
      "page_id",
      "type",
      "version",
    ]);
    expect(broadcaster.replaySince(0, "orch-a")).toMatchObject({
      gap: false,
      instanceId: "orch-a",
      latestId: 1,
      events: broadcaster.bufferedEvents,
    });
  });
});
