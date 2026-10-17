import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventOutbox } from "../../soul-server-ts/src/upstream/event_outbox.js";
import { buildEventOutboxAppendInput } from "../../soul-server-ts/src/db/event_persistence.js";
import type { SSEEventPayload } from "../../soul-server-ts/src/engine/protocol.js";
import { EventIngressRepository, LiveEventIngressSqlProvider } from "../src/node/event_ingress_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createLiveAttachmentReadRepository } from "../src/runtime/live_attachment_read_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";

const describePostgres = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

describePostgres("session output attachment history references PostgreSQL contract", () => {
  let harness: PagePostgresHarness;
  let outboxDirectory: string;
  let outbox: EventOutbox;
  let ingress: EventIngressRepository;
  let attachmentReadRepository: ReturnType<typeof createLiveAttachmentReadRepository>;
  const nodeId = "output-node";
  const sessionId = "output-session";
  const otherSessionId = "other-output-session";

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await prepareCardWorkSchema(harness);
    await harness.sql`INSERT INTO sessions(session_id,node_id)
      VALUES (${sessionId},${nodeId}),(${otherSessionId},${nodeId})`;
    const sqlResolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    ingress = new EventIngressRepository(new LiveEventIngressSqlProvider(sqlResolver));
    attachmentReadRepository = createLiveAttachmentReadRepository(sqlResolver);
    outboxDirectory = await mkdtemp(join(tmpdir(), "session-output-history-"));
    outbox = await EventOutbox.open(outboxDirectory);
    await insertAsset("asset-output");
    await insertAsset("asset-registration-only");
    await insertAsset("asset-other-session", otherSessionId, "command-other");
    await insertAsset("asset-tool-result");
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
    if (outboxDirectory) await rm(outboxDirectory, { recursive: true, force: true });
  });

  it("persists assistant output through event ingress and scopes reads to stored session events", async () => {
    const timestamp = "2026-10-17T00:00:00.000Z";
    const outputEvent = {
      type: "assistant_message",
      content: "",
      timestamp,
      attachment_ids: ["asset-output"],
      attachment_output: true,
      output_command_id: "command-output",
      _dedupe_key: "assistant-output:command-output",
    } as SSEEventPayload;
    const retryEvent = { ...outputEvent } as SSEEventPayload;
    const toolResultEvent = {
      type: "tool_result",
      id: "tool-1",
      attachment_ids: ["asset-tool-result"],
      timestamp,
    } as SSEEventPayload;
    const otherSessionEvent = {
      type: "assistant_message",
      content: "",
      timestamp,
      attachment_ids: ["asset-other-session"],
      attachment_output: true,
      output_command_id: "command-other",
    } as SSEEventPayload;

    await outbox.append(buildEventOutboxAppendInput(sessionId, outputEvent).appendInput);
    await outbox.append(buildEventOutboxAppendInput(sessionId, retryEvent).appendInput);
    await outbox.append(buildEventOutboxAppendInput(sessionId, toolResultEvent).appendInput);
    await outbox.append(buildEventOutboxAppendInput(otherSessionId, otherSessionEvent).appendInput);
    const batch = await outbox.readBatch();
    expect(batch).not.toBeNull();
    const committed = await ingress.commitBatch(nodeId, batch!);

    expect(committed).toHaveLength(4);
    const eventIds = committed.map((result) => {
      if (result.outcome !== "committed") throw new Error("Expected all fixture events to commit");
      return result.eventId;
    });
    expect(eventIds[0]).toEqual(expect.any(Number));
    expect(eventIds[1]).toBe(eventIds[0]);
    expect(eventIds[2]).not.toBe(eventIds[0]);
    const outputRows = await harness.sql<Array<{ id: number; payload: unknown }>>`
      SELECT id, payload FROM events
      WHERE session_id = ${sessionId} AND event_type = 'assistant_message'
    `;
    expect(outputRows).toHaveLength(1);
    expect(outputRows[0]!.payload).toMatchObject({
      type: "assistant_message",
      content: "",
      attachment_ids: ["asset-output"],
      attachment_output: true,
      output_command_id: "command-output",
    });
    expect(Array.isArray((outputRows[0]!.payload as { attachment_ids?: unknown }).attachment_ids)).toBe(true);

    await expect(attachmentReadRepository.getSqlScopeEvidence(
      { type: "session", id: sessionId },
      "asset-output",
    )).resolves.toMatchObject({ hasStoredRef: true });
    await expect(attachmentReadRepository.getSqlScopeEvidence(
      { type: "session", id: sessionId },
      "asset-registration-only",
    )).resolves.toMatchObject({ hasStoredRef: false });
    await expect(attachmentReadRepository.getSqlScopeEvidence(
      { type: "session", id: sessionId },
      "asset-other-session",
    )).resolves.toMatchObject({ hasStoredRef: false });
    await expect(attachmentReadRepository.getSqlScopeEvidence(
      { type: "session", id: sessionId },
      "asset-tool-result",
    )).resolves.toMatchObject({ hasStoredRef: true });
  }, 60_000);

  async function insertAsset(
    id: string,
    producerSessionId = sessionId,
    outputCommandId = "command-output",
  ): Promise<void> {
    await harness.sql`INSERT INTO file_assets (
      id, storage_key, storage_purpose, owner_kind, owner_key,
      source_node_id, source_session_id, output_command_id,
      original_name, mime_type, byte_size, upload_status
    ) VALUES (
      ${id}, ${`private/${id}`}, 'attachment', 'agent_session', ${producerSessionId},
      ${nodeId}, ${producerSessionId}, ${outputCommandId}, ${`${id}.txt`}, 'text/plain', 1, 'committed'
    )`;
  }
});
