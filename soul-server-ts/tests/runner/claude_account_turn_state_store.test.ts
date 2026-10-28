import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunnerClaudeAccountTurnStateStore } from
  "../../src/runner/claude_account_turn_state_store.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RunnerClaudeAccountTurnStateStore", () => {
  it("keeps the current binding and P5 fields across a store reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-account-turn-"));
    roots.push(root);
    const databasePath = join(root, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath);
    outbox.close();
    const state = {
      turn_id: "turn-a",
      account_id: "account-a",
      attempted_ids: [],
      continuation_uuid: null,
      continuation_sent: false,
    };

    const first = RunnerClaudeAccountTurnStateStore.open(databasePath, "session-a");
    await first.write(state);
    first.close();

    const reopened = RunnerClaudeAccountTurnStateStore.open(databasePath, "session-a");
    expect(reopened.read()).toEqual(state);
    await reopened.clear("another-turn");
    expect(reopened.read()).toEqual(state);
    await reopened.clear("turn-a");
    expect(reopened.read()).toBeNull();
    reopened.close();
  });
});
