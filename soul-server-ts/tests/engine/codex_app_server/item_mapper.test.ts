import { describe, expect, it } from "vitest";

import {
  mapItemCompleted,
  mapItemStarted,
} from "../../../src/engine/codex_app_server/item_mapper.js";

const context = {
  method: "item/completed",
  threadId: "thread-1",
  turnId: "turn-1",
  timestamp: 123.5,
};

describe("mapItemCompleted contextCompaction", () => {
  it("maps an auto compaction item to one compact event", () => {
    expect(mapItemCompleted({ type: "contextCompaction", id: "item-1" }, context)).toEqual([
      {
        type: "compact",
        trigger: "auto",
        message: "Codex context compacted (auto)",
        timestamp: 123.5,
        raw_event_type: "item/completed",
        thread_id: "thread-1",
        turn_id: "turn-1",
      },
    ]);
  });

  it("keeps an unknown item type silent and a compaction start silent", () => {
    expect(mapItemCompleted({ type: "unknownItem", id: "item-2" }, context)).toEqual([]);
    expect(mapItemStarted({ type: "contextCompaction", id: "item-1" }, context)).toEqual([]);
  });
});
