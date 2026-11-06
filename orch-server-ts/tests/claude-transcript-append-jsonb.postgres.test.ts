import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ClaudeTranscriptRepository } from
  "../src/control_plane/repositories/claude_transcript_repository.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres("claude transcript append JSONB binding in PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: ClaudeTranscriptRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new ClaudeTranscriptRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("stores and reloads a parent-linked user/assistant pair through the real driver", async () => {
    const projectKey = "-home-eias-workspace";
    const sessionId = `transcript-jsonb-${randomUUID()}`;
    const claudeSessionId = `claude-${randomUUID()}`;
    const key = { projectKey, sessionId };
    const userEntry = {
      type: "user",
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: claudeSessionId,
      timestamp: "2026-11-07T00:00:00.000Z",
      message: { role: "user", content: "첫 지시" },
    };
    const assistantEntry = {
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: userEntry.uuid,
      sessionId: claudeSessionId,
      timestamp: "2026-11-07T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "첫 응답" }],
      },
    };

    const written = await repository.appendClaudeTranscriptEntries(
      key,
      [userEntry, assistantEntry],
    );
    expect(written).toBe(2);

    const storedRows = await harness.sql<
      Array<{ entry_uuid: string; entry_type: string; json_type: string }>
    >`
      SELECT entry_uuid, entry->>'type' AS entry_type, jsonb_typeof(entry) AS json_type
      FROM claude_transcript_entries
      WHERE project_key = ${projectKey} AND session_id = ${sessionId}
      ORDER BY id ASC
    `;
    expect(storedRows).toEqual([
      { entry_uuid: userEntry.uuid, entry_type: "user", json_type: "object" },
      { entry_uuid: assistantEntry.uuid, entry_type: "assistant", json_type: "object" },
    ]);

    const loaded = await repository.loadClaudeTranscriptEntries(key);
    expect(loaded).toEqual([userEntry, assistantEntry]);
    expect(loaded?.[1]?.parentUuid).toBe(userEntry.uuid);
  });

  it("writes through the production idempotent append path with a real driver", async () => {
    const projectKey = "-home-eias-workspace";
    const sessionId = `transcript-idempotent-${randomUUID()}`;
    const key = { projectKey, sessionId };
    const userEntry = {
      type: "user",
      uuid: randomUUID(),
      parentUuid: null,
      message: { role: "user", content: "멱등 경로 지시" },
    };
    const assistantEntry = {
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: userEntry.uuid,
      message: { role: "assistant", content: "멱등 경로 응답" },
    };
    const input = {
      idempotencyKey: `transcript-append-${randomUUID()}`,
      sessionId,
      key,
      entries: [userEntry, assistantEntry],
    };

    expect(await repository.appendClaudeTranscriptEntriesIdempotent(input)).toBe(2);
    expect(await repository.appendClaudeTranscriptEntriesIdempotent(input)).toBe(2);

    const rows = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM claude_transcript_entries
      WHERE project_key = ${projectKey} AND session_id = ${sessionId}
    `;
    expect(rows[0]?.count).toBe(2);
    const receipts = await harness.sql<Array<{ result_json: unknown }>>`
      SELECT result_json
      FROM session_mutation_receipts
      WHERE idempotency_key = ${input.idempotencyKey}
    `;
    expect(receipts).toEqual([{ result_json: 2 }]);
    expect(await repository.loadClaudeTranscriptEntries(key))
      .toEqual([userEntry, assistantEntry]);
  });

  it("keeps the existing UUID idempotency when the same entries are appended again", async () => {
    const projectKey = "-home-eias-workspace";
    const sessionId = `transcript-jsonb-${randomUUID()}`;
    const key = { projectKey, sessionId };
    const userEntry = {
      type: "user",
      uuid: randomUUID(),
      parentUuid: null,
      message: { role: "user", content: "다시 시작" },
    };
    const assistantEntry = {
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: userEntry.uuid,
      message: { role: "assistant", content: "첫 응답" },
    };

    expect(await repository.appendClaudeTranscriptEntries(
      key,
      [userEntry, assistantEntry],
    )).toBe(2);
    expect(await repository.appendClaudeTranscriptEntries(
      key,
      [
        userEntry,
        { ...assistantEntry, message: { role: "assistant", content: "고친 응답" } },
      ],
    )).toBe(2);

    const rows = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM claude_transcript_entries
      WHERE project_key = ${projectKey} AND session_id = ${sessionId}
    `;
    expect(rows[0]?.count).toBe(2);

    const loaded = await repository.loadClaudeTranscriptEntries(key);
    expect(loaded).toEqual([
      userEntry,
      { ...assistantEntry, message: { role: "assistant", content: "고친 응답" } },
    ]);
  });
});
