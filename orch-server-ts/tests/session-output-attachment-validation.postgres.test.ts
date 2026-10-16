import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSessionOutputAttachmentValidation } from "../src/attachments/session_output_attachment_validation.js";
import type { TrustedAttachmentProducer } from "../src/cards/card_attachment_policy.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("session output attachment validation PostgreSQL contract", () => {
  let harness: PagePostgresHarness;
  let validate: ReturnType<typeof createSessionOutputAttachmentValidation>;
  let sequence = 0;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS execution_command_id TEXT`;
    validate = createSessionOutputAttachmentValidation({
      sql: createBoardYjsSqlAdapter(harness.liveSql),
    });
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  async function createSession(nodeId = "node-a") {
    const sessionId = `output-session-${++sequence}`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, execution_command_id)
      VALUES (${sessionId}, ${nodeId}, 'initial-session-command')
    `;
    return { sessionId, nodeId };
  }

  async function createAsset(input: {
    readonly id: string;
    readonly producer: TrustedAttachmentProducer;
    readonly ownerKind?: string;
    readonly ownerKey?: string;
    readonly sourceSessionId?: string | null;
    readonly sourceNodeId?: string | null;
    readonly outputCommandId?: string | null;
    readonly storagePurpose?: string;
    readonly uploadStatus?: string;
    readonly garbageCollected?: boolean;
    readonly registrationScope?: { readonly type: string; readonly id: string } | null;
  }) {
    const scope = input.registrationScope == null ? null : harness.sql.json(input.registrationScope);
    await harness.sql`
      INSERT INTO file_assets (
        id, storage_key, storage_purpose, owner_kind, owner_key, registration_scope,
        source_node_id, source_session_id, output_command_id, original_name, mime_type,
        byte_size, upload_status, garbage_collected_at
      ) VALUES (
        ${input.id}, ${`private/${input.id}`}, ${input.storagePurpose ?? "attachment"},
        ${input.ownerKind ?? "agent_session"}, ${input.ownerKey ?? input.producer.sessionId},
        ${scope}::jsonb, ${input.sourceNodeId ?? input.producer.nodeId},
        ${input.sourceSessionId === undefined ? input.producer.sessionId : input.sourceSessionId},
        ${input.outputCommandId === undefined ? input.producer.outputCommandId : input.outputCommandId},
        ${`${input.id}.txt`}, 'text/plain', 4, ${input.uploadStatus ?? "committed"},
        ${input.garbageCollected ? new Date("2026-01-01T00:00:00Z") : null}
      )
    `;
  }

  async function snapshotAssets() {
    return await harness.sql<{
      id: string;
      owner_kind: string | null;
      owner_key: string | null;
      source_session_id: string | null;
      source_node_id: string | null;
      output_command_id: string | null;
      storage_purpose: string;
      upload_status: string;
      garbage_collected_at: Date | null;
      registration_scope: unknown;
    }[]>`
      SELECT id, owner_kind, owner_key, source_session_id, source_node_id,
             output_command_id, storage_purpose, upload_status,
             garbage_collected_at, registration_scope
      FROM file_assets ORDER BY id
    `;
  }

  it("validates the same producer and output command, stable-dedupes IDs, and preserves card scope", async () => {
    const session = await createSession();
    const producer = {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      outputCommandId: "current-output-command",
    };
    await createAsset({
      id: "output-b",
      producer,
      registrationScope: { type: "card", id: "card-existing" },
    });
    await createAsset({ id: "output-a", producer });
    const before = await snapshotAssets();

    await expect(validate({ producer, attachmentIds: ["output-b", "output-a", "output-b"] }))
      .resolves.toEqual({ attachment_ids: ["output-b", "output-a"] });

    expect(await snapshotAssets()).toEqual(before);
    expect(before.find((row) => row.id === "output-b")?.registration_scope)
      .toEqual({ type: "card", id: "card-existing" });
  });

  it.each([
    ["another session owner", { ownerKey: "different-session" }],
    ["another source session", { sourceSessionId: "different-session" }],
    ["another source node", { sourceNodeId: "node-b" }],
    ["another output command", { outputCommandId: "previous-output-command" }],
    ["a user-owned asset", { ownerKind: "user_email", ownerKey: "owner@example.com" }],
  ])("rejects %s provenance", async (_label, overrides) => {
    const session = await createSession();
    const producer = {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      outputCommandId: "current-output-command",
    };
    const attachmentId = `mismatched-output-${session.sessionId}`;
    await createAsset({ id: attachmentId, producer, ...overrides });
    const before = await snapshotAssets();

    await expect(validate({ producer, attachmentIds: [attachmentId] }))
      .rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_PRODUCER_MISMATCH" });

    expect(await snapshotAssets()).toEqual(before);
  });

  it("rejects a missing session or producer node mismatch", async () => {
    const session = await createSession("node-a");
    await expect(validate({
      producer: { sessionId: "missing-session", nodeId: "node-a", outputCommandId: "command-a" },
      attachmentIds: ["asset-id"],
    })).rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_PRODUCER_MISMATCH" });

    await expect(validate({
      producer: { sessionId: session.sessionId, nodeId: "node-b", outputCommandId: "command-a" },
      attachmentIds: ["asset-id"],
    })).rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_PRODUCER_MISMATCH" });
  });

  it.each([
    ["a missing asset", { missing: true }, 404, "ATTACHMENT_NOT_FOUND"],
    ["a garbage-collected asset", { garbageCollected: true }, 404, "ATTACHMENT_NOT_FOUND"],
    ["a non-attachment asset", { storagePurpose: "board" }, 404, "ATTACHMENT_NOT_FOUND"],
    ["a pending asset", { uploadStatus: "pending" }, 409, "ATTACHMENT_NOT_COMMITTED"],
  ])("rejects %s", async (_label, options, statusCode, code) => {
    const session = await createSession();
    const producer = {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      outputCommandId: "current-output-command",
    };
    const attachmentId = `unavailable-output-${session.sessionId}`;
    if (!(options as { missing?: boolean }).missing) {
      await createAsset({ id: attachmentId, producer, ...options });
    }
    const before = await snapshotAssets();

    await expect(validate({ producer, attachmentIds: [attachmentId] }))
      .rejects.toMatchObject({ statusCode, code });

    expect(await snapshotAssets()).toEqual(before);
  });

  it("rejects the entire list when any requested ID is missing", async () => {
    const session = await createSession();
    const producer = {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      outputCommandId: "current-output-command",
    };
    await createAsset({ id: "valid-output", producer });
    const before = await snapshotAssets();

    await expect(validate({ producer, attachmentIds: ["valid-output", "missing-output"] }))
      .rejects.toMatchObject({ statusCode: 404, code: "ATTACHMENT_NOT_FOUND" });

    expect(await snapshotAssets()).toEqual(before);
  });

  it.each([
    { attachmentIds: [] as string[] },
    { attachmentIds: [""] },
  ])("rejects invalid output IDs $attachmentIds", async ({ attachmentIds }) => {
    const session = await createSession();
    await expect(validate({
      producer: {
        sessionId: session.sessionId,
        nodeId: session.nodeId,
        outputCommandId: "current-output-command",
      },
      attachmentIds,
    })).rejects.toMatchObject({ statusCode: 422, code: "ATTACHMENT_INVALID_OUTPUT" });
  });
});
