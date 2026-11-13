import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { prepareCardAttachmentInput } from "../src/cards/card_attachment_paths.js";
import { createLiveAttachmentCommitRepository } from "../src/runtime/live_attachment_commit_repository.js";
import { createLiveAttachmentReadRepository } from "../src/runtime/live_attachment_read_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { AttachmentTransportConnectionError } from "../src/attachments/attachment_routes.js";
import { normalizeAttachmentLegacyPath } from "../src/attachments/attachment_read_service.js";
import type {
  AttachmentSourceReadFile,
  CardAttachmentSourceStoreDeps,
} from "../src/attachments/card_attachment_source_import.js";
import type { CommitResult, UploadSpec } from "../src/attachments/attachment_commit_contract.js";
import type { FolderActorParams, RepositorySql } from "../src/cards/control_plane/card_types.js";

const NODE = "attachment-node";
const SESSION = "attachment-create-session";
const folderId = "card-create-attachment-folder";
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe("card create path attachment import against PostgreSQL", () => {
  let h: PagePostgresHarness;
  let sql: ReturnType<typeof createFolderContentSqlAdapter>;
  let cards: CardControlPlaneService;
  let reads: string[];
  let uploads: UploadSpec[];
  let failRead: boolean;
  let sequence = 0;
  const agent = { actorKind: "agent" as const, actorSessionId: SESSION };
  const key = () => `create-attachment:${++sequence}`;

  const readSource: CardAttachmentSourceStoreDeps["readSource"] = async (nodeId, path) => {
    reads.push(`${nodeId}\u0000${path}`);
    if (failRead) throw new AttachmentTransportConnectionError("node offline");
    const file: AttachmentSourceReadFile = {
      content: BYTES,
      filename: "source.bin",
      contentType: "application/octet-stream",
      size: BYTES.byteLength,
    };
    return file;
  };
  const commit = async (input: { readonly spec: UploadSpec; readonly body: Uint8Array }): Promise<CommitResult> => {
    const { spec } = input;
    uploads.push(spec);
    const scope = spec.registration.registrationScope;
    await h.sql`INSERT INTO file_assets (
      id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
      owner_kind, owner_key, registration_scope, source_node_id, source_session_id,
      original_name, mime_type, byte_size, upload_status
    ) VALUES (
      ${spec.attachmentId}, ${`private/${spec.attachmentId}`}, 'attachment', 'https://r2.example.test', 'private-attachments',
      ${spec.owner.kind}, ${spec.owner.key},
      ${scope === null ? null : h.sql.json(scope)}::jsonb,
      ${spec.registration.sourceNodeId}, ${spec.registration.sourceSessionId},
      ${spec.originalName}, ${spec.mimeType}, ${spec.byteSize}, 'committed'
    )`;
    return {
      attachmentId: spec.attachmentId,
      storageKey: `private/${spec.attachmentId}`,
      storageEndpoint: "https://r2.example.test",
      storageBucket: "private-attachments",
      originalName: spec.originalName,
      mimeType: spec.mimeType,
      byteSize: spec.byteSize,
      checksumSha256: "a".repeat(64),
    };
  };

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'카드 생성 첨부')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id,status,agent_id,node_id,model_preset)
      VALUES (${SESSION},${folderId},'running','roselin','eiaserinnys','codex-6-luna')`;
    sql = createFolderContentSqlAdapter(h.liveSql);
    const db = {
      appendEventTx: async (tx: RepositorySql, p: {
        sessionId: string; eventType: string; payload: string; searchableText: string; createdAt: Date; dedupeKey?: string | null;
      }) => {
        const rows = await tx<{ id: number }[]>`SELECT event_append(
          ${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}
        ) AS id`;
        return rows[0]!.id;
      },
    };
    const repository = createLiveAttachmentCommitRepository(createLiveDbSqlResolver({ sql: h.liveSql }));
    cards = new CardControlPlaneService(sql, db, undefined, undefined, undefined, undefined, [], undefined, undefined,
      { readSource, commits: { putSmall: commit }, repository });
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  beforeEach(async () => {
    await h.sql`DELETE FROM card_comments`;
    await h.sql`DELETE FROM card_reports`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM attachment_legacy_aliases`;
    await h.sql`DELETE FROM file_assets`;
    reads = [];
    uploads = [];
    failRead = false;
  });

  const attachment = (path: string, name = "a.png") => [{ nodeId: NODE, path, name, mimeType: "image/png" }];
  const createCard = (attachments: ReturnType<typeof attachment>) =>
    cards.createCard({ ...agent, folderId, title: "첨부 카드", request: "요청", attachments, idempotencyKey: key() });
  async function cardRefs(cardId: string): Promise<unknown> {
    return (await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM cards WHERE id=${cardId}`)[0]!.attachment_refs;
  }
  async function alias(assetId: string, path: string): Promise<void> {
    await h.sql`INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES (${NODE}, ${normalizeAttachmentLegacyPath(path)}, ${assetId}, ${path}, 'resolved')`;
  }
  async function insertAsset(id: string, options: {
    readonly ownerKind?: string;
    readonly ownerKey?: string;
    readonly scope?: { readonly type: string; readonly id: string } | null;
  } = {}): Promise<void> {
    const ownerKey = options.ownerKey ?? SESSION;
    await h.sql`INSERT INTO file_assets (
      id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
      owner_kind, owner_key, registration_scope, source_session_id,
      original_name, mime_type, byte_size, upload_status
    ) VALUES (
      ${id}, ${`private/${id}`}, 'attachment', 'https://r2.example.test', 'private-attachments',
      ${options.ownerKind ?? "agent_session"}, ${ownerKey},
      ${options.scope === undefined || options.scope === null ? null : h.sql.json(options.scope)}::jsonb,
      ${ownerKey}, ${`${id}.png`}, 'image/png', ${BYTES.byteLength}, 'committed'
    )`;
  }

  it("reads the node once and uploads before the card exists, then binds without the node", async () => {
    const created = await createCard(attachment("media/a.png"));
    const cardId = created.operation.target_id;
    expect(reads).toEqual([`${NODE}\u0000media/a.png`]);
    expect(uploads).toHaveLength(1);
    const spec = uploads[0]!;
    expect(spec.owner).toEqual({ kind: "agent_session", key: SESSION });
    expect(spec.registration.registrationScope).toEqual({ type: "card", id: cardId });
    expect(spec.registration.sourceNodeId).toBe(NODE);
    expect(await cardRefs(cardId)).toEqual([{ attachment_id: spec.attachmentId }]);
    expect(await h.sql`SELECT asset_id, availability FROM attachment_legacy_aliases
      WHERE node_id=${NODE} AND normalized_path=${normalizeAttachmentLegacyPath("media/a.png")}`)
      .toEqual([{ asset_id: spec.attachmentId, availability: "resolved" }]);

    const reader = createLiveAttachmentReadRepository(createLiveDbSqlResolver({ sql: h.liveSql }));
    const admitSource = async (input: { cardId: string; sourceNodeId: string; attachmentPaths: string[] }) => {
      const attachmentIds: string[] = [];
      const attachmentPaths: string[] = [];
      const attachmentBindings: Array<{ attachment_id: string; node_id: string; path: string }> = [];
      for (const sourcePath of input.attachmentPaths) {
        const found = await reader.getLegacyAlias(input.sourceNodeId, normalizeAttachmentLegacyPath(sourcePath));
        if (found === null) { attachmentPaths.push(sourcePath); continue; }
        if (found.availability !== "resolved" || found.assetId === null) throw new Error("missing alias");
        const asset = await reader.getAsset(found.assetId);
        const evidence = await reader.getSqlScopeEvidence({ type: "card", id: input.cardId }, found.assetId);
        if (asset === null || asset.uploadStatus !== "committed" || evidence?.hasStoredRef !== true) throw new Error("denied");
        attachmentIds.push(found.assetId);
        attachmentBindings.push({ attachment_id: found.assetId, node_id: input.sourceNodeId, path: sourcePath });
      }
      return { attachment_ids: attachmentIds, attachment_paths: attachmentPaths, attachment_bindings: attachmentBindings };
    };
    reads = [];
    failRead = true;
    const prepared = await prepareCardAttachmentInput(attachment("media/a.png"), "another-node", { cardId, admitSource });
    expect(reads).toEqual([]);
    expect(prepared.attachment_ids).toEqual([spec.attachmentId]);
    expect(prepared.attachment_bindings).toEqual([{ attachment_id: spec.attachmentId, node_id: NODE, path: "media/a.png" }]);
  });

  it("creates no card when the source node is unreachable", async () => {
    failRead = true;
    await expect(createCard(attachment("media/offline.png"))).rejects.toMatchObject({
      code: "NODE_REJECTED",
      statusCode: 503,
      message: `첨부 "a.png"을 노드 ${NODE}에서 가져오지 못했습니다: 노드가 연결되어 있지 않습니다. 노드가 켜진 뒤 다시 실행하세요.`,
    });
    expect(await h.sql`SELECT id FROM cards`).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it("reuses a materialized incoming asset of the same session without reading the node", async () => {
    const path = `incoming/${SESSION}/assets/materialized-1/shot.png`;
    await insertAsset("materialized-1", { scope: { type: "session", id: SESSION } });
    const created = await createCard(attachment(path));
    expect(reads).toEqual([]);
    expect(uploads).toHaveLength(0);
    expect(await cardRefs(created.operation.target_id)).toEqual([{ attachment_id: "materialized-1" }]);
    expect(await h.sql`SELECT asset_id FROM attachment_legacy_aliases
      WHERE node_id=${NODE} AND normalized_path=${normalizeAttachmentLegacyPath(path)}`)
      .toEqual([{ asset_id: "materialized-1" }]);
  });

  it("falls back to the node when the materialized asset belongs to another session", async () => {
    const path = `incoming/${SESSION}/assets/materialized-2/shot.png`;
    await insertAsset("materialized-2", { scope: { type: "session", id: "another-session" } });
    const created = await createCard(attachment(path));
    expect(reads).toEqual([`${NODE}\u0000${path}`]);
    expect(uploads).toHaveLength(1);
    expect(await cardRefs(created.operation.target_id)).toEqual([{ attachment_id: uploads[0]!.attachmentId }]);
    expect(await h.sql`SELECT asset_id FROM attachment_legacy_aliases
      WHERE node_id=${NODE} AND normalized_path=${normalizeAttachmentLegacyPath(path)}`)
      .toEqual([{ asset_id: uploads[0]!.attachmentId }]);
  });

  it("reuses an existing user asset alias without reading the node or denying the agent", async () => {
    await insertAsset("user-owned", { ownerKind: "user_email", ownerKey: "owner@example.com", scope: null });
    await alias("user-owned", "media/owned.png");
    const created = await createCard(attachment("media/owned.png"));
    expect(reads).toEqual([]);
    expect(uploads).toHaveLength(0);
    expect(await cardRefs(created.operation.target_id)).toEqual([{ attachment_id: "user-owned" }]);
  });
});
