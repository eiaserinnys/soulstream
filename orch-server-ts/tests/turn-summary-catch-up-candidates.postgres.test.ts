import { afterEach, describe, expect, it } from "vitest";

import { TurnSummaryCatchUpRepository } from
  "../src/turn-summary/turn_summary_catch_up_repository.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

const EXCLUDED_FOLDER = "055be5a6-1285-48aa-a8a1-59e40fbe59af";
const SINCE = new Date("2026-11-18T00:00:00.000Z");
const OLDER_THAN = new Date("2026-11-21T00:00:00.000Z");

describe("TurnSummaryCatchUpRepository candidates (PostgreSQL)", () => {
  let harness: PagePostgresHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("returns unsummarized completes in age order and skips the rest", async () => {
    harness = await createPagePostgresHarness();
    const { sql } = harness;
    await sql.unsafe(
      "ALTER TABLE events ADD COLUMN parent_event_id INTEGER",
    );
    await sql.unsafe("ALTER TABLE sessions ADD COLUMN metadata JSONB");

    const insertSession = async (
      sessionId: string,
      folderId: string | null,
      nodeId: string,
      metadata: unknown = null,
    ) => await sql`
      INSERT INTO sessions (session_id, folder_id, node_id, status, metadata)
      VALUES (
        ${sessionId}, ${folderId}, ${nodeId}, 'running',
        ${metadata === null ? null : JSON.stringify(metadata)}::text::jsonb
      )
    `;
    const insertEvent = async (
      sessionId: string,
      id: number,
      eventType: string,
      parentEventId: number | null,
      createdAt: string,
    ) => await sql`
      INSERT INTO events (
        session_id, id, event_type, parent_event_id, created_at
      ) VALUES (
        ${sessionId}, ${id}, ${eventType}, ${parentEventId},
        ${createdAt}::timestamptz
      )
    `;

    await insertSession("a-partial", null, "node-a");
    await insertEvent("a-partial", 10, "complete", null, "2026-11-19T00:00:00Z");
    await insertEvent("a-partial", 11, "turn_summary", 9, "2026-11-19T00:01:00Z");
    await insertEvent("a-partial", 20, "complete", null, "2026-11-19T01:00:00Z");

    await insertSession("b-summarized", null, "node-b");
    await insertEvent("b-summarized", 10, "complete", null, "2026-11-19T00:00:00Z");
    await insertEvent("b-summarized", 11, "turn_summary", 9, "2026-11-19T00:01:00Z");
    await insertEvent("b-summarized", 20, "complete", null, "2026-11-19T01:00:00Z");
    await insertEvent("b-summarized", 21, "turn_summary", 19, "2026-11-19T02:00:00Z");

    await insertSession("c-excluded", EXCLUDED_FOLDER, "node-c");
    await insertEvent("c-excluded", 10, "complete", null, "2026-11-19T00:00:00Z");

    await insertSession("d-too-recent", null, "node-d");
    await insertEvent("d-too-recent", 10, "complete", null, "2026-11-21T00:00:00Z");

    await insertSession("e-outside-window", null, "node-e");
    await insertEvent("e-outside-window", 10, "complete", null, "2026-11-17T23:59:59Z");

    await insertSession("f-older", null, "node-f");
    await insertEvent("f-older", 10, "complete", null, "2026-11-19T02:00:00Z");

    await insertSession("g-later", null, "node-g");
    await insertEvent("g-later", 10, "complete", null, "2026-11-19T03:00:00Z");

    await insertSession("h-agent", null, "node-h", [
      { type: "caller_info", value: { source: "agent" } },
    ]);
    await insertEvent("h-agent", 10, "complete", null, "2026-11-19T01:30:00Z");

    await insertSession("i-internal", null, "node-i", [
      { type: "turn_summary_internal" },
    ]);
    await insertEvent("i-internal", 10, "complete", null, "2026-11-19T01:45:00Z");

    await insertSession("j-agent-persistent", null, "node-j", [
      { type: "caller_info", value: { source: "agent" } },
      { type: "persistent_session", value: { enabled: true } },
    ]);
    await insertEvent(
      "j-agent-persistent",
      10,
      "complete",
      null,
      "2026-11-19T04:00:00Z",
    );

    const repository = new TurnSummaryCatchUpRepository({
      resolveSql: async () => harness!.liveSql,
    });
    const input = {
      since: SINCE,
      olderThan: OLDER_THAN,
      excludedFolderIds: [EXCLUDED_FOLDER],
      excludedTurns: [],
      limit: 100,
    };

    await expect(repository.listCatchUpCandidates(input)).resolves.toEqual([
      { sessionId: "a-partial", nodeId: "node-a", completeEventId: 20 },
      { sessionId: "f-older", nodeId: "node-f", completeEventId: 10 },
      { sessionId: "g-later", nodeId: "node-g", completeEventId: 10 },
      {
        sessionId: "j-agent-persistent",
        nodeId: "node-j",
        completeEventId: 10,
      },
    ]);
    await expect(
      repository.listCatchUpCandidates({
        ...input,
        excludedTurns: [{ sessionId: "a-partial", completeEventId: 20 }],
      }),
    ).resolves.toEqual([
      { sessionId: "f-older", nodeId: "node-f", completeEventId: 10 },
      { sessionId: "g-later", nodeId: "node-g", completeEventId: 10 },
      {
        sessionId: "j-agent-persistent",
        nodeId: "node-j",
        completeEventId: 10,
      },
    ]);
    await expect(
      repository.listCatchUpCandidates({ ...input, limit: 2 }),
    ).resolves.toHaveLength(2);
  });
});
