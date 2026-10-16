import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { cardAttachmentIdLinks, collectCardAttachmentRefs } from "../src/cards/card_attachment_refs.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";

function ownerUrl(id: string): string {
  return `/api/attachments/${id}/content?context_type=owner`;
}
function cardUrl(id: string, cardId: string): string {
  return `/api/attachments/${id}/content?context_type=card&context_id=${cardId}`;
}

describe("card source attachment reference parsing and indexing", () => {
  it("collects internal attachment ids from markdown, auto links and reference definitions only", () => {
    const body = [
      `인라인 ![그림](${ownerUrl("asset-a")})`,
      `[문서](${cardUrl("asset-b", "card-1")})`,
      `<${ownerUrl("asset-c")}>`,
      "[ref]: " + ownerUrl("asset-d"),
      "[외부](https://example.com/a.png)",
      "[옛 경로](/api/nodes/node-1/workspaces/2024-01-01/a.png)",
      "```",
      ownerUrl("asset-fenced"),
      "```",
    ].join("\n");
    expect(cardAttachmentIdLinks(body)).toEqual(["asset-a", "asset-b", "asset-c", "asset-d"]);
  });

  it("merges request, attachments and item ids, dropping removed pure item refs and keeping compat metadata", () => {
    const refs = collectCardAttachmentRefs({
      request: `그림 ![x](${ownerUrl("req-1")})`,
      attachments: [{ attachment_id: "att-1" }, { name: "no id" }],
      items: [{ id: 1, evidence: [{ type: "image", attachment_id: "item-1", label: "x" }] }],
      previousRefs: [
        { attachment_id: "item-1" },
        { attachment_id: "item-gone" },
        { attachment_id: "legacy", legacy_url: "/old/path.png" },
      ],
      previousItems: [
        { id: 1, evidence: [{ type: "image", attachment_id: "item-1", label: "x" }] },
        { id: 2, evidence: [{ type: "image", attachment_id: "item-gone", label: "y" }] },
      ],
    });
    expect(refs).toEqual([
      { attachment_id: "req-1" },
      { attachment_id: "att-1" },
      { attachment_id: "item-1" },
      { attachment_id: "legacy", legacy_url: "/old/path.png" },
    ]);
  });

  it("keeps a single canonical copy when an id appears in several sources", () => {
    const refs = collectCardAttachmentRefs({
      request: ownerUrl("dup"),
      attachments: [{ attachment_id: "dup" }],
      items: [],
      previousRefs: [{ attachment_id: "dup", legacy_url: "/old.png" }],
      previousItems: [],
    });
    expect(refs).toEqual([{ attachment_id: "dup", legacy_url: "/old.png" }]);
  });
});

describe("card source attachment references against PostgreSQL", () => {
  let h: PagePostgresHarness;
  let sql: ReturnType<typeof createBoardYjsSqlAdapter>;
  let cards: CardControlPlaneService;
  let sequence = 0;
  const folderId = "source-attachment-folder";
  const agent = { actorKind: "agent" as const, actorSessionId: "source-session" };
  const key = () => `source-attachment:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'소스 첨부')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id,status,agent_id,node_id,model_preset)
      VALUES ('source-session',${folderId},'running','roselin','eiaserinnys','codex-6-luna'),
             ('second-session',${folderId},'running','roselin','eiaserinnys','codex-6-luna')`;
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
    await h.sql`DELETE FROM file_assets`;
  });

  async function makeCard(request = "요청", actor = agent): Promise<string> {
    const created = await cards.createCard({ ...actor, folderId, title: "소스 첨부 카드", request, idempotencyKey: key() });
    return created.operation.target_id;
  }

  async function assign(cardId: string, sessionId = "source-session"): Promise<void> {
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id=${sessionId} WHERE id=${cardId}`;
  }

  async function insertAsset(id: string, options: {
    readonly ownerKey?: string;
    readonly ownerKind?: string;
    readonly scope?: { readonly type: string; readonly id: string } | null;
    readonly uploadStatus?: string;
  } = {}): Promise<void> {
    await h.sql`INSERT INTO file_assets (
      id, storage_key, storage_purpose, owner_kind, owner_key, registration_scope, source_session_id,
      original_name, mime_type, byte_size, upload_status
    ) VALUES (
      ${id}, ${`private/${id}`}, 'attachment', ${options.ownerKind ?? "agent_session"}, ${options.ownerKey ?? "source-session"},
      ${options.scope === undefined || options.scope === null ? null : h.sql.json(options.scope)}::jsonb,
      ${options.ownerKey ?? "source-session"}, ${`${id}.png`}, 'image/png', 8, ${options.uploadStatus ?? "committed"}
    )`;
  }

  async function cardRefs(cardId: string) {
    return (await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM cards WHERE id=${cardId}`)[0]!.attachment_refs;
  }

  it("stores the actor's own scope-less attachment when creating a card with a request link", async () => {
    await insertAsset("asset-own");
    const cardId = await makeCard(`첨부 ![그림](${ownerUrl("asset-own")})`);
    expect(await cardRefs(cardId)).toEqual([{ attachment_id: "asset-own" }]);
  });

  it("stores a same-card markdown report reference on the report row", async () => {
    const cardId = await makeCard();
    await assign(cardId);
    await insertAsset("asset-report", { scope: { type: "card", id: cardId } });
    await cards.addReport({ ...agent, cardId, title: "보고", format: "markdown", body: `결과 ![그림](${cardUrl("asset-report", cardId)})`, idempotencyKey: key() });
    const rows = await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM card_reports WHERE card_id=${cardId}`;
    expect(rows[0]!.attachment_refs).toEqual([{ attachment_id: "asset-report" }]);
    expect(await cardRefs(cardId)).toEqual([]);
  });

  it("stores references for spoken comments, replies and notes on the comment row", async () => {
    const cardId = await makeCard();
    await assign(cardId);
    await insertAsset("asset-comment");
    await cards.addComment({ ...agent, cardId, kind: "spoken", body: `발언 ![그림](${ownerUrl("asset-comment")})`, idempotencyKey: key() });
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,session_id,kind,body)
      VALUES ('prior',${cardId},'user','source-session','comment','이전 사용자 글')`;
    await cards.addComment({ ...agent, cardId, mode: "reply", body: `답변 ![그림](${ownerUrl("asset-comment")})`, idempotencyKey: key() });
    await cards.addCardNote({ ...agent, cardId, text: `노트 ![그림](${ownerUrl("asset-comment")})`, idempotencyKey: key() });
    const rows = await h.sql<{ kind: string; attachment_refs: unknown }[]>`SELECT kind, attachment_refs FROM card_comments WHERE card_id=${cardId} AND id <> 'prior' ORDER BY created_at, id`;
    expect(rows.map((row) => [row.kind, row.attachment_refs])).toEqual([
      ["spoken", [{ attachment_id: "asset-comment" }]],
      ["comment", [{ attachment_id: "asset-comment" }]],
      ["note", [{ attachment_id: "asset-comment" }]],
    ]);
  });

  it("stores references through createCardTx and addCommentTx", async () => {
    await insertAsset("asset-tx");
    const cardId = `tx-card-${++sequence}`;
    const created = await sql.begin(async tx => cards.createCardTx(tx, {
      ...agent, folderId, title: "트랜잭션 카드", request: `첨부 ![그림](${ownerUrl("asset-tx")})`, idempotencyKey: key(), cardId,
    }));
    expect(await cardRefs(cardId)).toEqual([{ attachment_id: "asset-tx" }]);
    await sql`UPDATE cards SET assignee_kind='session',assignee_session_id='source-session' WHERE id=${cardId}`;
    await sql.begin(async tx => cards.addCommentTx(tx, {
      ...agent, cardId, expectedVersion: created.card.version, idempotencyKey: key(), commentId: `tx-comment-${sequence}`,
      body: `발언 ![그림](${ownerUrl("asset-tx")})`, mode: "spoken",
    }));
    const rows = await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM card_comments WHERE card_id=${cardId}`;
    expect(rows[0]!.attachment_refs).toEqual([{ attachment_id: "asset-tx" }]);
  });

  it("rejects a link to a different card's context and saves nothing", async () => {
    const cardId = await makeCard();
    await assign(cardId);
    const before = (await cards.getCard(cardId))!.card.version;
    await expect(cards.addReport({ ...agent, cardId, title: "거부", format: "markdown", body: `![그림](${cardUrl("asset-other", "other-card")})`, idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 422, code: "ATTACHMENT_INVALID_CARD_REFERENCE" });
    expect(await h.sql`SELECT id FROM card_reports WHERE card_id=${cardId}`).toHaveLength(0);
    expect((await cards.getCard(cardId))!.card.version).toBe(before);
  });

  it("rejects a new attachment link from a non-agent actor and saves nothing", async () => {
    const cardId = await makeCard();
    await insertAsset("asset-human", { ownerKey: "director@example.com", ownerKind: "user_email" });
    await expect(cards.addReport({ actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com", cardId, title: "거부", format: "markdown", body: `![그림](${ownerUrl("asset-human")})`, idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 422, code: "ATTACHMENT_INVALID_CARD_REFERENCE" });
    expect(await h.sql`SELECT id FROM card_reports WHERE card_id=${cardId}`).toHaveLength(0);
  });

  it("denies a new attachment owned by another session and rolls back the source row", async () => {
    const cardId = await makeCard();
    await assign(cardId);
    await insertAsset("asset-foreign", { ownerKey: "second-session" });
    await expect(cards.addReport({ ...agent, cardId, title: "거부", format: "markdown", body: `![그림](${ownerUrl("asset-foreign")})`, idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_LINK_DENIED" });
    expect(await h.sql`SELECT id FROM card_reports WHERE card_id=${cardId}`).toHaveLength(0);
    expect(await cardRefs(cardId)).toEqual([]);
  });

  it("keeps external, legacy and fenced example URLs out of the stored references", async () => {
    const cardId = await makeCard();
    await assign(cardId);
    const body = [
      "[외부](https://example.com/a.png)",
      "[옛 경로](/api/nodes/node-1/workspaces/2024-01-01/a.png)",
      "```",
      ownerUrl("asset-fenced"),
      "```",
    ].join("\n");
    await cards.addReport({ ...agent, cardId, title: "예시", format: "markdown", body, idempotencyKey: key() });
    const rows = await h.sql<{ body: string; attachment_refs: unknown }[]>`SELECT body, attachment_refs FROM card_reports WHERE card_id=${cardId}`;
    expect(rows[0]!.attachment_refs).toEqual([]);
    expect(rows[0]!.body).toBe(body);
  });

  it("stores no reference for an html report body", async () => {
    const cardId = await makeCard();
    await assign(cardId);
    await cards.addReport({ ...agent, cardId, title: "HTML", format: "html", body: `<img src="${ownerUrl("asset-html")}">`, idempotencyKey: key() });
    const rows = await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM card_reports WHERE card_id=${cardId}`;
    expect(rows[0]!.attachment_refs).toEqual([]);
  });

  it("re-cites an already-linked reference after the source session is deleted", async () => {
    await insertAsset("asset-own");
    const cardId = await makeCard(`첨부 ![그림](${ownerUrl("asset-own")})`);
    await h.sql`DELETE FROM sessions WHERE session_id='source-session'`;
    await cards.addReport({ actorKind: "agent" as const, actorSessionId: "second-session", cardId, title: "재인용", format: "markdown", body: `다시 ![그림](${ownerUrl("asset-own")})`, idempotencyKey: key() });
    const rows = await h.sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM card_reports WHERE card_id=${cardId}`;
    expect(rows[0]!.attachment_refs).toEqual([{ attachment_id: "asset-own" }]);
  });
});
