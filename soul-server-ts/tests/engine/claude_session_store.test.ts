import { describe, expect, it, vi } from "vitest";

import { DbClaudeSessionStore } from "../../src/engine/claude_session_store.js";

describe("DbClaudeSessionStore", () => {
  it("delegates SessionStore append/load/list/delete to SessionDB without interpreting entries", async () => {
    const db = {
      appendClaudeTranscriptEntries: vi.fn(async () => 2),
      loadClaudeTranscriptEntries: vi.fn(async () => [
        { type: "user", uuid: "u1", message: { content: "hi" } },
      ]),
      listClaudeTranscriptSessions: vi.fn(async () => [
        { sessionId: "claude-sess-1", mtime: 1770000000000 },
      ]),
      listClaudeTranscriptSubkeys: vi.fn(async () => ["subagents/agent-a"]),
      deleteClaudeTranscript: vi.fn(async () => undefined),
    };
    const store = new DbClaudeSessionStore(db);
    const key = {
      projectKey: "project-a",
      sessionId: "claude-sess-1",
      subpath: "subagents/agent-a",
    };

    await store.append(key, [
      { type: "user", uuid: "u1", message: { content: "hi" } },
      { type: "assistant", uuid: "a1", message: { content: "hello" } },
    ]);

    await expect(store.load(key)).resolves.toEqual([
      { type: "user", uuid: "u1", message: { content: "hi" } },
    ]);
    await expect(store.listSessions?.("project-a")).resolves.toEqual([
      { sessionId: "claude-sess-1", mtime: 1770000000000 },
    ]);
    await expect(
      store.listSubkeys?.({ projectKey: "project-a", sessionId: "claude-sess-1" }),
    ).resolves.toEqual(["subagents/agent-a"]);
    await store.delete?.(key);

    expect(db.appendClaudeTranscriptEntries).toHaveBeenCalledWith(key, [
      { type: "user", uuid: "u1", message: { content: "hi" } },
      { type: "assistant", uuid: "a1", message: { content: "hello" } },
    ]);
    expect(db.loadClaudeTranscriptEntries).toHaveBeenCalledWith(key);
    expect(db.listClaudeTranscriptSessions).toHaveBeenCalledWith("project-a");
    expect(db.listClaudeTranscriptSubkeys).toHaveBeenCalledWith({
      projectKey: "project-a",
      sessionId: "claude-sess-1",
    });
    expect(db.deleteClaudeTranscript).toHaveBeenCalledWith(key);
  });
});
