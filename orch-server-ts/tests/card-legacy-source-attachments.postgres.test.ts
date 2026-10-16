import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { collectCardAttachmentRefs } from "../src/cards/card_attachment_refs.js";
import {
  collectCardLegacyLocations,
  mergeCardSourceAttachmentRefs,
  resolveCardLegacySourceRefsTx,
} from "../src/cards/card_attachment_legacy_refs.js";
import {
  AttachmentReadError,
  createAttachmentReadService,
  normalizeAttachmentLegacyPath,
  type AttachmentReadStorageBinding,
} from "../src/attachments/attachment_read_service.js";
import { createLiveAttachmentReadRepository } from "../src/runtime/live_attachment_read_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import type { FolderActorParams, RepositorySql } from "../src/cards/control_plane/card_types.js";

const NODE = "legacy-node";
const STORAGE: AttachmentReadStorageBinding = {
  storage: { openObject: async () => new Response(new Uint8Array(8).fill(7)) },
  identity: "legacy-reader",
  location: { endpoint: "https://r2.example.test", bucket: "private-attachments" },
};
const filesUrl = (nodeId: string, path: string) => `/api/attachments/files?nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(path)}`;
function canonicalUrl(nodeId: string, path: string): string {
  const params = new URLSearchParams();
  params.set("nodeId", nodeId);
  params.set("path", normalizeAttachmentLegacyPath(path));
  return `/api/attachments/files?${params.toString()}`;
}

describe("legacy card attachment location parsing", () => {
  it("collects normalized locations from attachments, markdown and html only", () => {
    const markdown = [
      `인라인 ![그림](${filesUrl(NODE, "media\\a.png")})`,
      `<${filesUrl(NODE, "매체/a b.png")}>`,
      `[ref]: ${filesUrl(NODE, "media/a.png")}`,
      "[외부](https://example.com/api/attachments/files?nodeId=x&path=y.png)",
      "[노드](//host/api/attachments/files?nodeId=x&path=y.png)",
      "[중복](/api/attachments/files?nodeId=x&nodeId=y&path=z.png)",
      "```",
      filesUrl(NODE, "media/fenced.png"),
      "```",
    ].join("\n");
    expect(collectCardLegacyLocations({
      body: markdown,
      format: "markdown",
      attachments: [
        { nodeId: NODE, path: "media/a.png", name: "a.png" },
        { nodeId: NODE, path: "media/../media/a.png" },
        { nodeId: "", path: "media/skip.png" }, { nodeId: NODE, path: "" }, "not-an-object",
      ],
    })).toEqual([
      { nodeId: NODE, path: "media/a.png" },
      { nodeId: NODE, path: "매체/a b.png" },
    ]);
    const html = `<p><img src="${filesUrl(NODE, "media/a.png").replace(/&/g, "&amp;")}"><a href='${filesUrl(NODE, "media/b.png")}'>b</a><img src=${filesUrl(NODE, "media/unquoted.png")}></p>`;
    expect(collectCardLegacyLocations({ body: html, format: "html" })).toEqual([
      { nodeId: NODE, path: "media/a.png" },
      { nodeId: NODE, path: "media/b.png" },
    ]);
  });

  it("rejects a resolved alias whose asset id is empty", async () => {
    const fakeSql = (() => Promise.resolve([{ asset_id: "", availability: "resolved" }])) as unknown as RepositorySql;
    const actor: FolderActorParams = { actorKind: "agent", actorSessionId: "legacy-session" };
    await expect(resolveCardLegacySourceRefsTx(fakeSql, {
      cardId: "card", assigneeSessionId: null, actor,
      body: `![f](${filesUrl(NODE, "media/a.png")})`, format: "markdown",
    })).rejects.toMatchObject({ statusCode: 422, code: "ATTACHMENT_INVALID_LEGACY_ALIAS" });
  });

  it("keeps legacy metadata for a shared id and preserves request refs across item changes", () => {
    expect(mergeCardSourceAttachmentRefs(
      [{ attachment_id: "shared" }],
      [
        { attachment_id: "shared", legacy_url: "/api/attachments/files?nodeId=n&path=p" },
        { attachment_id: "only", legacy_url: "/api/attachments/files?nodeId=n&path=q" },
      ],
    )).toEqual([
      { attachment_id: "shared", legacy_url: "/api/attachments/files?nodeId=n&path=p" },
      { attachment_id: "only", legacy_url: "/api/attachments/files?nodeId=n&path=q" },
    ]);
    expect(collectCardAttachmentRefs({
      request: `![f](${filesUrl(NODE, "media/a.png")})`,
      attachments: [],
      items: [],
      previousRefs: [{ attachment_id: "shared", legacy_url: "/api/attachments/files?nodeId=n&path=p" }],
      previousItems: [{ id: 1, evidence: [{ type: "image", url: "/api/attachments/shared/content?context_type=owner" }] }],
    })).toEqual([{ attachment_id: "shared", legacy_url: "/api/attachments/files?nodeId=n&path=p" }]);
  });
});

describe("legacy card attachment references against PostgreSQL", () => {
  let h: PagePostgresHarness;
  let sql: ReturnType<typeof createBoardYjsSqlAdapter>;
  let cards: CardControlPlaneService;
  let sequence = 0;
  const folderId = "legacy-source-folder";
  const agent = { actorKind: "agent" as const, actorSessionId: "legacy-session" };
  const user = { actorKind: "user" as const, actorSessionId: null, actorUserId: "owner@example.com" };
  const key = () => `legacy-source:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'레거시 첨부')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id,status,agent_id,node_id,model_preset)
      VALUES ('legacy-session',${folderId},'running','roselin','eiaserinnys','codex-6-luna')`;
    sql = createBoardYjsSqlAdapter(h.liveSql);
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
    cards = new CardControlPlaneService(sql, db);
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  beforeEach(async () => {
    await h.sql`DELETE FROM card_comments`;
    await h.sql`DELETE FROM card_reports`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM attachment_legacy_aliases`;
    await h.sql`DELETE FROM file_assets`;
  });

  async function makeCard(request = "요청", actor: FolderActorParams = agent): Promise<string> {
    const created = await cards.createCard({ ...actor, folderId, title: "레거시 첨부 카드", request, idempotencyKey: key() });
    return created.operation.target_id;
  }
  async function assign(cardId: string, sessionId = "legacy-session"): Promise<void> {
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id=${sessionId} WHERE id=${cardId}`;
  }
  async function insertAsset(id: string, options: { readonly ownerKey?: string; readonly ownerKind?: string; readonly uploadStatus?: string; readonly garbageCollected?: boolean; readonly scope?: { readonly type: string; readonly id: string } | null } = {}): Promise<void> {
    await h.sql`INSERT INTO file_assets (
      id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
      owner_kind, owner_key, registration_scope, source_session_id,
      original_name, mime_type, byte_size, upload_status, garbage_collected_at
    ) VALUES (
      ${id}, ${`private/${id}`}, 'attachment', ${STORAGE.location.endpoint}, ${STORAGE.location.bucket},
      ${options.ownerKind ?? "user_email"}, ${options.ownerKey ?? "owner@example.com"},
      ${options.scope === undefined || options.scope === null ? null : h.sql.json(options.scope)}::jsonb,
      ${options.ownerKey ?? "owner@example.com"}, ${`${id}.png`}, 'image/png', 8,
      ${options.uploadStatus ?? "committed"},
      ${options.garbageCollected === true ? new Date("2026-01-01T00:00:00Z") : null}
    )`;
  }
  async function insertAlias(assetId: string, options: { readonly nodeId?: string; readonly path?: string; readonly availability?: "resolved" | "missing" } = {}): Promise<void> {
    const availability = options.availability ?? "resolved";
    await h.sql`INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES (${options.nodeId ?? NODE}, ${normalizeAttachmentLegacyPath(options.path ?? "media/a.png")},
        ${availability === "missing" ? null : assetId}, ${"C:\\legacy\\a.png"}, ${availability})`;
  }
  async function cardRefs(cardId: string): Promise<unknown> {
    return (await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM cards WHERE id=${cardId}`)[0]!.attachment_refs;
  }
  const ref = (id: string, path: string) => [{ attachment_id: id, legacy_url: canonicalUrl(NODE, path) }];

  it("stores resolved legacy refs for a user card request and createCardTx", async () => {
    await insertAsset("legacy-user");
    await insertAlias("legacy-user");
    const cardId = await makeCard(`첨부 ![그림](${filesUrl(NODE, "media/a.png")})`, user);
    expect(await cardRefs(cardId)).toEqual(ref("legacy-user", "media/a.png"));
    const txCardId = `legacy-tx-${++sequence}`;
    await sql.begin(async (tx) => cards.createCardTx(tx, {
      ...user, folderId, title: "트랜잭션", request: "요청",
      attachments: [{ nodeId: NODE, path: "media/a.png", name: "a.png", mimeType: "image/png" }],
      idempotencyKey: key(), cardId: txCardId,
    }));
    expect(await cardRefs(txCardId)).toEqual(ref("legacy-user", "media/a.png"));
  });

  it("stores legacy refs for report markdown and html without touching the body", async () => {
    await insertAsset("legacy-src");
    await insertAsset("legacy-space");
    await insertAlias("legacy-src");
    await insertAlias("legacy-space", { path: "매체/a b.png" });
    const cardId = await makeCard();
    const markdown = `결과 [그림](${filesUrl(NODE, "media/a.png")})\n[매체](${filesUrl(NODE, "매체/a b.png")})`;
    await cards.addReport({ ...user, cardId, title: "md", format: "markdown", body: markdown, idempotencyKey: key() });
    const html = `<p><img src="${filesUrl(NODE, "media/a.png").replace(/&/g, "&amp;")}"><a href="${filesUrl(NODE, "매체/a b.png")}">b</a></p>`;
    await cards.addReport({ ...user, cardId, title: "html", format: "html", body: html, idempotencyKey: key() });
    const rows = await h.sql<{ title: string; body: string; attachment_refs: unknown }[]>`
      SELECT title, body, attachment_refs FROM card_reports WHERE card_id=${cardId} ORDER BY created_at, id`;
    const expected = [...ref("legacy-src", "media/a.png"), ...ref("legacy-space", "매체/a b.png")];
    expect(rows.map((row) => [row.title, row.body, row.attachment_refs])).toEqual([
      ["md", markdown, expected],
      ["html", html, expected],
    ]);
    expect(canonicalUrl(NODE, "매체/a b.png")).toBe("/api/attachments/files?nodeId=legacy-node&path=%EB%A7%A4%EC%B2%B4%2Fa+b.png");
  });

  it("stores legacy refs for spoken comments and notes on the comment row", async () => {
    await insertAsset("legacy-cmt", { ownerKind: "agent_session", ownerKey: "legacy-session" });
    await insertAlias("legacy-cmt", { path: "media/cmt.png" });
    const cardId = await makeCard();
    await assign(cardId);
    await cards.addComment({ ...agent, cardId, kind: "spoken", body: `발언 [그림](${filesUrl(NODE, "media/cmt.png")})`, idempotencyKey: key() });
    await cards.addCardNote({ ...agent, cardId, text: `노트 [그림](${filesUrl(NODE, "media/cmt.png")})`, idempotencyKey: key() });
    const rows = await h.sql<{ kind: string; body: string; attachment_refs: unknown }[]>`
      SELECT kind, body, attachment_refs FROM card_comments WHERE card_id=${cardId} ORDER BY created_at, id`;
    expect(rows.map((row) => [row.kind, row.body, row.attachment_refs])).toEqual([
      ["spoken", `발언 [그림](${filesUrl(NODE, "media/cmt.png")})`, ref("legacy-cmt", "media/cmt.png")],
      ["note", `노트 [그림](${filesUrl(NODE, "media/cmt.png")})`, ref("legacy-cmt", "media/cmt.png")],
    ]);
  });

  it("stores non-resolved aliases unchanged and rolls back resolved failures", async () => {
    await insertAsset("legacy-absent");
    await insertAsset("legacy-missing");
    await insertAlias("legacy-missing", { path: "media/old.png", availability: "missing" });
    await insertAsset("legacy-foreign", { ownerKey: "other@example.com" });
    await insertAlias("legacy-foreign");
    await insertAsset("legacy-agent-owner", { ownerKind: "agent_session" });
    await insertAlias("legacy-agent-owner", { path: "media/agent.png" });
    await insertAsset("legacy-gc", { garbageCollected: true });
    await insertAlias("legacy-gc", { path: "media/gc.png" });
    await insertAsset("legacy-pending", { uploadStatus: "pending" });
    await insertAlias("legacy-pending", { path: "media/pending.png" });
    const cardId = await makeCard();
    const report = (title: string, path: string) => cards.addReport({ ...user, cardId, title, format: "markdown", body: `[f](${filesUrl(NODE, path)})`, idempotencyKey: key() });
    await report("absent", "media/none.png");
    await report("missing", "media/old.png");
    await expect(report("foreign", "media/a.png")).rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_LINK_DENIED" });
    await expect(report("agent", "media/agent.png")).rejects.toMatchObject({ statusCode: 403 });
    await expect(report("gc", "media/gc.png")).rejects.toMatchObject({ statusCode: 404, code: "ATTACHMENT_NOT_FOUND" });
    await expect(report("pending", "media/pending.png")).rejects.toMatchObject({ statusCode: 409, code: "ATTACHMENT_NOT_COMMITTED" });
    const rows = await h.sql<{ title: string; body: string; attachment_refs: unknown }[]>`
      SELECT title, body, attachment_refs FROM card_reports WHERE card_id=${cardId} ORDER BY created_at, id`;
    expect(rows.map((row) => [row.title, row.attachment_refs])).toEqual([["absent", []], ["missing", []]]);
  });

  it("normalizes the owner email, ignores forged fields and denies a missing actor", async () => {
    await insertAsset("legacy-case", { ownerKey: "  OWNER@Example.com " });
    await insertAlias("legacy-case");
    const cardId = await makeCard();
    await cards.addReport({ ...user, cardId, title: "ok", format: "markdown", body: `ownerEmail: attacker@example.com [f](${filesUrl(NODE, "media/a.png")})`, idempotencyKey: key() });
    expect((await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM card_reports WHERE card_id=${cardId}`)[0]!.attachment_refs)
      .toEqual(ref("legacy-case", "media/a.png"));
    await expect(cards.addReport({ actorKind: "user" as const, actorSessionId: null, cardId, title: "anon", format: "markdown", body: `[f](${filesUrl(NODE, "media/a.png")})`, idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_LINK_DENIED" });
    expect(await h.sql`SELECT id FROM card_reports WHERE card_id=${cardId} AND title='anon'`).toHaveLength(0);
  });

  it("allows upload scopes without a card or matching the current card and denies another card", async () => {
    const cardId = await makeCard();
    await insertAsset("legacy-session-scope", { scope: { type: "session", id: "legacy-session" } });
    await insertAlias("legacy-session-scope", { path: "media/s.png" });
    await insertAsset("legacy-folder-scope", { scope: { type: "folder", id: folderId } });
    await insertAlias("legacy-folder-scope", { path: "media/f.png" });
    await insertAsset("legacy-card-scope", { scope: { type: "card", id: cardId } });
    await insertAlias("legacy-card-scope", { path: "media/c.png" });
    await insertAsset("legacy-other-scope", { scope: { type: "card", id: "elsewhere" } });
    await insertAlias("legacy-other-scope", { path: "media/o.png" });
    const body = [`[s](${filesUrl(NODE, "media/s.png")})`, `[f](${filesUrl(NODE, "media/f.png")})`, `[c](${filesUrl(NODE, "media/c.png")})`].join("\n");
    await cards.addReport({ ...user, cardId, title: "allowed", format: "markdown", body, idempotencyKey: key() });
    const rows = await h.sql<{ attachment_refs: { attachment_id: string }[] }[]>`SELECT attachment_refs FROM card_reports WHERE card_id=${cardId}`;
    expect(rows[0]!.attachment_refs.map((r) => r.attachment_id)).toEqual(["legacy-session-scope", "legacy-folder-scope", "legacy-card-scope"]);
    await expect(cards.addReport({ ...user, cardId, title: "denied", format: "markdown", body: `[o](${filesUrl(NODE, "media/o.png")})`, idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_LINK_DENIED" });
  });

  it("lets a different card reader read the resolved asset through the legacy alias", async () => {
    await insertAsset("legacy-p2b");
    await insertAlias("legacy-p2b");
    const cardId = await makeCard(`첨부 [그림](${filesUrl(NODE, "media/a.png")})`, user);
    const repository = createLiveAttachmentReadRepository(createLiveDbSqlResolver({ sql: h.liveSql }));
    const scopeGuard = (allow: boolean) => async (_actor: unknown, scope: { type: string; id: string }): Promise<void> => {
      if (allow && scope.type === "card" && scope.id === cardId) return;
      throw new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "denied", 403);
    };
    const build = (allow: boolean) => createAttachmentReadService({
      repository,
      access: { requireScope: scopeGuard(allow) as never },
      resolveReadStorage: async () => STORAGE,
      readPageAttachmentEvidence: async () => null,
    });
    const readerB = async () => ({ kind: "user" as const, email: "reader-b@example.com" });
    const result = await build(true).legacy(readerB, NODE, normalizeAttachmentLegacyPath("media/a.png"), undefined, { method: "GET" });
    if (result.kind === "response") {
      expect(result.response.status).toBe(200);
      expect([...new Uint8Array(await result.response.arrayBuffer())]).toEqual(new Array(8).fill(7));
    }
    await expect(build(false).legacy(readerB, NODE, "media/a.png", undefined, { method: "GET" }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
