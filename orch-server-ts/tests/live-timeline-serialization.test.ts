import { describe, expect, it } from "vitest";

import {
  buildToolTrace,
  serializeMessageRows,
  serializeTimelineRows,
} from "../src/runtime/live_timeline_serialization.js";

const startTruncation = {
  original_bytes: 300_000,
  attachment: {
    attachment_id: "archive-input",
    name: "tool_start-0123456789abcdef.txt",
    mime_type: "text/plain",
    byte_size: 300_000,
    checksum_sha256: "a".repeat(64),
    width: null,
    height: null,
    preview_kind: "text",
    preview_mime_type: "text/plain",
  },
};
const resultTruncation = {
  original_bytes: 3 * 1024 * 1024,
  attachment: {
    attachment_id: "archive-result",
    name: "tool_result-0123456789abcdef.txt",
    mime_type: "text/plain",
    byte_size: 3 * 1024 * 1024,
    checksum_sha256: "b".repeat(64),
    width: null,
    height: null,
    preview_kind: "text",
    preview_mime_type: "text/plain",
  },
};

describe("live timeline truncation metadata", () => {
  it("preserves tool_start and tool_result metadata through compaction and trace serialization", () => {
    const rows = [
      {
        id: 10,
        event_type: "tool_start",
        created_at: "2026-10-17T00:00:00.000Z",
        payload: {
          type: "tool_start",
          tool_name: "Bash",
          tool_use_id: "tool-1",
          tool_input: { command: "find" },
          truncation: startTruncation,
          attachment_ids: ["archive-input"],
        },
      },
      {
        id: 11,
        event_type: "tool_result",
        created_at: "2026-10-17T00:00:01.000Z",
        payload: {
          type: "tool_result",
          tool_name: "Bash",
          tool_use_id: "tool-1",
          result: "preview",
          is_error: false,
          truncation: resultTruncation,
          attachment_ids: ["archive-result"],
        },
      },
      {
        id: 12,
        event_type: "assistant_message",
        created_at: "2026-10-17T00:00:02.000Z",
        payload: { type: "assistant_message", content: "answer", truncation: resultTruncation },
      },
      {
        id: 13,
        event_type: "thinking",
        created_at: "2026-10-17T00:00:03.000Z",
        payload: { type: "thinking", thinking: "thought", truncation: startTruncation },
      },
    ];

    const timeline = serializeTimelineRows(rows);
    const trace = buildToolTrace("tool:tool-1", "tool-1", rows.slice(0, 2));
    const messages = serializeMessageRows(rows);

    expect(timeline[0]?.payload).toMatchObject({
      truncation: startTruncation,
      attachment_ids: ["archive-input"],
    });
    expect(timeline[1]?.payload).toMatchObject({
      truncation: resultTruncation,
      attachment_ids: ["archive-result"],
    });
    expect(timeline[2]?.payload).toMatchObject({ truncation: resultTruncation });
    expect(timeline[3]?.payload).toMatchObject({ truncation: startTruncation });
    expect(trace).toMatchObject({
      truncation: resultTruncation,
      events: [
        { payload: { truncation: startTruncation } },
        { payload: { truncation: resultTruncation } },
      ],
    });
    expect(trace.events).toEqual(messages.slice(0, 2));
  });
});
