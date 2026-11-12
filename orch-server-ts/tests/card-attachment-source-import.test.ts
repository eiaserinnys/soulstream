import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import { createCardAttachmentSourceImport } from "../src/attachments/card_attachment_source_import.js";
import { AttachmentTransportConnectionError } from "../src/attachments/attachment_routes.js";
import { normalizeAttachmentLegacyPath } from "../src/attachments/attachment_read_service.js";
import { createCardDispatchRuntime } from "../src/cards/card_dispatch_runtime.js";
import { recordWorkReceipt, prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const OWNER = "card-owner@example.test";
const SOURCE_NODE = "sourceA";
const TARGET_NODE = "targetB";
const REMOTE_IMAGE = "D:\\haniel-root\\workspace\\.local\\tmp\\cardq\\mock.png";
const REMOTE_BYTES = Buffer.from("png-bytes");

describe("card attachment source import", () => {
  let h: PagePostgresHarness;
  let runtime: Awaited<ReturnType<typeof createCardDispatchRuntime>>;
  let createSession: ReturnType<typeof vi.fn>;
  let routeExisting: ReturnType<typeof vi.fn>;
  let sendPendingCommand: ReturnType<typeof vi.fn>;
  let readSource: ReturnType<typeof vi.fn>;
  let putSmall: ReturnType<typeof vi.fn>;
  let sent: Record<string, any>[];

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/116_card_execution_requests.sql", import.meta.url), "utf8"));
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by)
      VALUES ('card_dispatch','{"nodeConcurrency":{"default":4}}','test')`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('attachment-import','첨부 가져오기')`;

    sent = [];
    readSource = vi.fn(async () => ({
      content: REMOTE_BYTES,
      filename: "mock.png",
      contentType: "image/png",
      size: REMOTE_BYTES.byteLength,
    }));
    putSmall = vi.fn(async ({ spec }: { spec: Record<string, any> }) => {
      const checksum = "0".repeat(64);
      await h.sql`INSERT INTO file_assets(id,storage_key,storage_purpose,storage_endpoint,storage_bucket,
          owner_kind,owner_key,registration_scope,source_node_id,source_session_id,original_name,mime_type,
          byte_size,checksum_sha256,upload_status)
        VALUES(${spec.attachmentId},${`storage-${spec.attachmentId}`},'attachment','test-endpoint','test-bucket',
          ${spec.owner.kind},${spec.owner.key},${h.sql.json(spec.registration.registrationScope)},
          ${spec.registration.sourceNodeId},${spec.registration.sourceSessionId},${spec.originalName},
          ${spec.mimeType},${spec.byteSize},${checksum},'committed')`;
      return {
        attachmentId: spec.attachmentId,
        storageKey: `storage-${spec.attachmentId}`,
        storageEndpoint: "test-endpoint",
        storageBucket: "test-bucket",
        originalName: spec.originalName,
        mimeType: spec.mimeType,
        byteSize: spec.byteSize,
        checksumSha256: checksum,
      };
    });
    createSession = vi.fn((payload: Record<string, any>) => ({
      node: { nodeId: payload.nodeId },
      command: { payload },
      modelPresetId: payload.model_preset ?? "model",
    }));
    routeExisting = vi.fn(async (payload: Record<string, any>) => ({
      node: { nodeId: TARGET_NODE },
      command: { payload },
    }));
    sendPendingCommand = vi.fn(async (routed: { command: { payload: Record<string, any> } }) => {
      const payload = routed.command.payload;
      sent.push(payload);
      if (payload.type === "create_session") {
        await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
          VALUES(${payload.agentSessionId},${payload.nodeId},${payload.profile},'initializing',${payload.cardId},'attachment-import',${payload.model_preset ?? null})
          ON CONFLICT(session_id) DO NOTHING`;
        const proof = { registrationId: `registration-${payload.agentSessionId}`, executionCommandId: `command-${payload.agentSessionId}` };
        await recordWorkReceipt(h, payload.agentSessionId, "running", proof);
        return { type: "session_created", status: "ok", agentSessionId: payload.agentSessionId };
      }
      if (payload.type === "ensure_session_running") {
        return { state: "started", execution: { registrationId: `registration-${payload.agentSessionId}`, executionCommandId: `command-${payload.agentSessionId}` } };
      }
      return { type: "ack", status: "ok" };
    });
    runtime = await createCardDispatchRuntime({
      sqlResolver: { resolveSql: async () => h.liveSql, close: async () => undefined },
      router: {
        selectNodeForCreate: ({ nodeId, profileId, modelPresetId }: { nodeId: string; profileId: string; modelPresetId?: string }) => ({
          nodeId, profileId, modelPresetId: modelPresetId ?? "model",
        }),
        createSession,
        routeExistingSessionPendingCommand: routeExisting,
        waitForCreatedSession: async () => true,
      } as any,
      bridge: { sendPendingCommand } as any,
      availability: { resolveForNode: () => ({ available: true }), requireAvailable: () => undefined } as any,
      notifier: {} as any,
      admin: {} as any,
      broadcaster: { append: () => undefined } as any,
      warn: vi.fn(),
      onFolderHeaderUpdated: async () => undefined,
      usageSnapshot: () => ({}) as any,
      ensureSystemFolder: async () => undefined,
      validateFolder: async () => true,
      resolveSessionOwner: async () => null,
      findUserByEmail: async (email) => ({ email, isAdmin: true, allowedFolderIds: [] }),
      attachmentImport: {
        readSource: readSource as any,
        commits: { putSmall } as any,
        repository: {
          async findLegacyAliasForAsset(nodeId: string, normalizedPath: string) {
            const rows = await h.sql<Array<{ asset_id: string | null; availability: string; original_path: string }>>`
              SELECT asset_id, availability, original_path FROM attachment_legacy_aliases
              WHERE node_id=${nodeId} AND normalized_path=${normalizedPath} LIMIT 1`;
            if (rows.length === 0) return null;
            return {
              nodeId,
              normalizedPath,
              assetId: rows[0]!.asset_id,
              originalPath: rows[0]!.original_path,
              availability: rows[0]!.availability as "resolved" | "missing",
            };
          },
          async insertLegacyAlias({ nodeId, normalizedPath, assetId, originalPath }: {
            readonly nodeId: string;
            readonly normalizedPath: string;
            readonly assetId: string;
            readonly originalPath: string;
          }) {
            const rows = await h.sql<Array<{ asset_id: string | null; availability: string; original_path: string }>>`
              INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
              VALUES(${nodeId},${normalizedPath},${assetId},${originalPath},'resolved')
              ON CONFLICT(node_id,normalized_path) DO NOTHING
              RETURNING asset_id, availability, original_path`;
            if (rows.length === 0) return null;
            return {
              nodeId,
              normalizedPath,
              assetId: rows[0]!.asset_id,
              originalPath: rows[0]!.original_path,
              availability: rows[0]!.availability as "resolved" | "missing",
            };
          },
        } as any,
      },
    });
  }, 60000);

  afterAll(async () => {
    await runtime?.dispatcher.drain();
    await h?.cleanup();
  });

  beforeEach(async () => {
    await runtime.dispatcher.drain();
    await h.sql`DELETE FROM attachment_legacy_aliases`;
    await h.sql`DELETE FROM file_assets`;
    createSession.mockClear();
    routeExisting.mockClear();
    sendPendingCommand.mockClear();
    readSource.mockClear();
    putSmall.mockClear();
    readSource.mockImplementation(async () => ({
      content: REMOTE_BYTES,
      filename: "mock.png",
      contentType: "image/png",
      size: REMOTE_BYTES.byteLength,
    }));
    sent.length = 0;
  });

  async function makeCard(attachments: CardAttachment[], queue = false) {
    const cards = await runtime.serviceProvider();
    const made = await cards.createCard({
      actorKind: "user",
      actorSessionId: null,
      actorUserId: OWNER,
      folderId: "attachment-import",
      title: `첨부 ${randomUUID()}`,
      request: "첨부를 처리하세요.",
      attachments,
      queue,
      assignee: { kind: "agent", agentId: "profile" },
      nodeId: TARGET_NODE,
      modelPreset: "model",
      idempotencyKey: randomUUID(),
    });
    await runtime.dispatcher.drain();
    return { cards, cardId: made.operation.target_id };
  }

  function attachment(): CardAttachment {
    return { nodeId: SOURCE_NODE, path: REMOTE_IMAGE, name: "mock.png", mimeType: "image/png" };
  }

  async function execute(cardId: string) {
    const current = (await (await runtime.serviceProvider()).getCard(cardId))!.card;
    return (await runtime.executionServiceProvider()).execute({
      actorKind: "user",
      actorSessionId: null,
      actorUserId: OWNER,
      cardId,
      expectedVersion: current.version,
      idempotencyKey: randomUUID(),
    });
  }

  it("imports an unaliased foreign attachment and hands it to the target node", async () => {
    const { cardId } = await makeCard([attachment()], true);

    expect(readSource).toHaveBeenCalledTimes(1);
    expect(readSource).toHaveBeenCalledWith(SOURCE_NODE, REMOTE_IMAGE);
    const command = sent.find(payload => payload.type === "create_session" && payload.cardId === cardId);
    if (!command) throw new Error("Card create command was not sent");
    const attachmentId = command.attachment_ids[0];
    expect(attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(command.attachment_paths ?? []).not.toContain(REMOTE_IMAGE);
    expect(command.attachment_bindings).toEqual([
      { attachment_id: attachmentId, node_id: SOURCE_NODE, path: REMOTE_IMAGE },
    ]);

    expect(putSmall).toHaveBeenCalledTimes(1);
    expect(putSmall.mock.calls[0]![0].spec).toMatchObject({
      attachmentId,
      owner: { kind: "agent_session", key: expect.any(String) },
      registration: {
        registrationScope: { type: "card", id: cardId },
        sourceNodeId: SOURCE_NODE,
        sourceSessionId: expect.any(String),
        outputCommandId: null,
      },
      originalName: "mock.png",
      mimeType: "image/png",
      byteSize: REMOTE_BYTES.byteLength,
    });

    const aliases = await h.sql<Array<{ asset_id: string }>>`
      SELECT asset_id FROM attachment_legacy_aliases
      WHERE node_id=${SOURCE_NODE} AND normalized_path=${normalizeAttachmentLegacyPath(REMOTE_IMAGE)}`;
    expect(aliases).toEqual([{ asset_id: attachmentId }]);

    const refs = await h.sql<Array<{ attachment_refs: Array<{ attachment_id: string }> }>>`
      SELECT attachment_refs FROM cards WHERE id=${cardId}`;
    expect(refs[0]!.attachment_refs).toContainEqual({ attachment_id: attachmentId });
  });

  it("reuses the stored alias on the second run without calling the source node", async () => {
    const { cardId } = await makeCard([attachment()], true);
    const first = sent.find(payload => payload.type === "create_session" && payload.cardId === cardId);
    if (!first) throw new Error("Card create command was not sent");
    const attachmentId = first.attachment_ids[0];
    await h.sql`UPDATE cards SET status='running',assignee_kind='session',assignee_agent_id=NULL,
      assignee_session_id=${first.agentSessionId} WHERE id=${cardId}`;
    readSource.mockClear();
    putSmall.mockClear();

    await execute(cardId);

    expect(readSource).not.toHaveBeenCalled();
    expect(putSmall).not.toHaveBeenCalled();
    const ensured = sent.find(payload => payload.type === "ensure_session_running");
    if (!ensured) throw new Error("Card ensure command was not sent");
    expect(ensured).toMatchObject({
      attachment_ids: [attachmentId],
      attachment_bindings: [{ attachment_id: attachmentId, node_id: SOURCE_NODE, path: REMOTE_IMAGE }],
    });
  });

  it("fails without creating a session when the source node is disconnected", async () => {
    readSource.mockRejectedValueOnce(
      new AttachmentTransportConnectionError(`Node is not connected: ${SOURCE_NODE}`),
    );
    const { cards, cardId } = await makeCard([attachment()], true);

    expect(createSession).not.toHaveBeenCalled();
    expect(sent.some(payload => payload.type === "create_session")).toBe(false);
    const detail = (await cards.getCard(cardId))!;
    expect(detail.card.status).toBe("blocked");
    expect(String(detail.card.blocked_detail)).toContain(
      `첨부 "mock.png"을 노드 ${SOURCE_NODE}에서 가져오지 못했습니다: 노드가 연결되어 있지 않습니다.`,
    );
    const aliases = await h.sql`SELECT asset_id FROM attachment_legacy_aliases WHERE node_id=${SOURCE_NODE}`;
    expect(aliases).toEqual([]);
  });

  it("marks import failures as NODE_REJECTED for the orchestration worker", async () => {
    const importer = createCardAttachmentSourceImport({
      readSource: async () => {
        throw new AttachmentTransportConnectionError("disconnected");
      },
      commits: { putSmall: vi.fn() } as any,
      repository: {
        findLegacyAliasForAsset: async () => null,
        insertLegacyAlias: async () => null,
      },
      addCardRef: async () => undefined,
    });

    await expect(importer({
      cardId: "card-1",
      sourceNodeId: SOURCE_NODE,
      sourceSessionId: "session-1",
      path: REMOTE_IMAGE,
      name: "mock.png",
      mimeType: "image/png",
    })).rejects.toMatchObject({
      code: "NODE_REJECTED",
      message: expect.stringContaining("노드가 연결되어 있지 않습니다. 노드가 켜진 뒤 다시 실행하세요."),
    });
  });
});
