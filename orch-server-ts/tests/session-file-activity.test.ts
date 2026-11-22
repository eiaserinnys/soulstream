import { describe, expect, it } from "vitest";
import { collectSessionFileActivity } from "../src/session/session_file_activity.js";

describe("session file activity", () => {
  it("attributes the four backends and excludes shell and outside paths", () => {
    const rows = [
      {event_type: "tool_start", tool_name: "Read", file_path: "/repo/read.txt", created_at: "2026-01-01T00:00:00Z"},
      {event_type: "tool_start", tool_name: "Edit", file_path: "/repo/edit.txt", created_at: "2026-01-01T00:00:00Z"},
      {event_type: "tool_result", tool_name: "file_change", result: '[{"path":"/repo/codex.txt"}]', created_at: "2026-01-01T00:00:00Z"},
      {event_type: "tool_start", tool_name: "write_to_file", target_file: "/repo/agy.txt", created_at: "2026-01-01T00:00:00Z"},
      {event_type: "tool_start", tool_name: "read", file_path_camel: "/repo/open.txt", created_at: "2026-01-01T00:00:00Z"},
      {event_type: "tool_start", tool_name: "Bash", file_path: "/repo/ignored", created_at: "2026-01-01T00:00:00Z"},
      {event_type: "tool_start", tool_name: "Read", file_path: "/outside", created_at: "2026-01-01T00:00:00Z"},
    ];
    const result = collectSessionFileActivity("/repo", rows);
    expect([...result.keys()].sort()).toEqual(["agy.txt", "codex.txt", "edit.txt", "open.txt", "read.txt"]);
    expect(result.get("read.txt")?.read).toBe(true);
    expect(result.get("codex.txt")?.wrote).toBe(true);
  });
});
