import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardRepositoryRead } from "../src/cards/control_plane/card_repository_read.js";
import { CardMcpReadService, type CardMcpGetInput } from "../src/cards/card_mcp_read.js";
import { serializeCardRow } from "../src/folders/folder_contracts.js";
import type { CardItem } from "../src/cards/card_item_rules.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

const FOLDER_ID = "attachment-projection";
const ASSIGNEE = "projection-assignee";
const MEMBER = "projection-member";
const CARD_CONTENT = (cardId: string, id: string) =>
  "/api/attachments/" + encodeURIComponent(id) + "/content?context_type=card&context_id=" + encodeURIComponent(cardId);

describe("card attachment evidence projection", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let cardRepository: CardRepositoryRead;
  let reader: {
    getCard: (cardId: string, input: CardMcpGetInput, allowedFolderIds: readonly string[] | null) => Promise<Record<string, any>>;
  };
  let sequence = 0;
  const cardUpdates: string[] = [];
  const key = () => "card-attachment-projection:" + (++sequence);
  const user = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const agent = { actorKind: "agent" as const, actorSessionId: ASSIGNEE };
  const proof = (id: string, label = "화면", type: "image" | "link" = "image") => ({
    type, label, attachment_id: id,
  });

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql.unsafe("INSERT INTO folders(id,name) VALUES ($1,$2)", [FOLDER_ID, "첨부 투영"]);
    await h.sql.unsafe(
      "INSERT INTO sessions(session_id,status) VALUES ($1,'running'),($2,'running')",
      [ASSIGNEE, MEMBER],
    );
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    cardRepository = new CardRepositoryRead(sql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, {
      emitFolderUpdated: async () => {},
      emitCardUpdated: async (cardId) => { cardUpdates.push(cardId); },
    });
    reader = new CardMcpReadService(sql);
  }, 60_000);

  afterAll(async () => h?.cleanup());

  beforeEach(async () => {
    cardUpdates.length = 0;
    await h.sql.unsafe("DELETE FROM folder_operations WHERE folder_id=$1", [FOLDER_ID]);
    await h.sql.unsafe("DELETE FROM cards WHERE folder_id=$1", [FOLDER_ID]);
    await h.sql.unsafe("DELETE FROM file_assets");
    await h.sql.unsafe("UPDATE sessions SET card_id=NULL,status='running' WHERE session_id IN ($1,$2)", [ASSIGNEE, MEMBER]);
    await h.sql.unsafe(
      "INSERT INTO sessions(session_id,status) VALUES ($1,'running'),($2,'running') ON CONFLICT (session_id) DO NOTHING",
      [ASSIGNEE, MEMBER],
    );
  });

  async function makeCard(): Promise<string> {
    const created = await cards.createCard({
      ...user, folderId: FOLDER_ID, title: "첨부 증거", request: "요청 원문",
      assignee: { kind: "session", sessionId: ASSIGNEE }, idempotencyKey: key(),
    });
    const cardId = created.operation.target_id;
    await cards.setCardItems({ ...agent, cardId, items: ["증거 확인", "다음 확인"] });
    return cardId;
  }

  async function insertAsset(
    id: string,
    cardId: string,
    options: { mime?: string; status?: string } = {},
  ): Promise<void> {
    await h.sql`INSERT INTO file_assets(
      id,storage_key,storage_purpose,storage_endpoint,storage_bucket,owner_kind,owner_key,
      registration_scope,source_session_id,original_name,mime_type,byte_size,upload_status
    ) VALUES (
      ${id},${"private/" + id},'attachment','https://r2.example.test','private-attachments','agent_session',${MEMBER},
      ${h.sql.json({ type: "card", id: cardId })}::jsonb,${MEMBER},${id + ".bin"},${options.mime ?? "image/png"},8,${options.status ?? "committed"}
    )`;
  }

  async function storedItems(cardId: string): Promise<CardItem[]> {
    const rows = await h.sql.unsafe("SELECT items FROM cards WHERE id=$1", [cardId]);
    return (rows[0] as unknown as { items: CardItem[] }).items;
  }

  it("projects committed evidence through mutation, detail, and list reads while storage stays ID-only", async () => {
    const cardId = await makeCard();
    cardUpdates.length = 0;
    await insertAsset("ready-image", cardId);
    await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id=${MEMBER}`;
    const rawProof = proof("ready-image");

    const mutation = await cards.reportCardItem({
      ...agent, cardId, itemId: 1, state: "done", result: "저장됨",
      evidence: [rawProof], idempotencyKey: key(),
    });
    expect(cardUpdates.length).toBeGreaterThan(0);
    expect(cardUpdates.every((updatedId) => updatedId === cardId)).toBe(true);
    expect(mutation.operation.payload_json.evidence).toStrictEqual([rawProof]);
    expect((await storedItems(cardId))[0]!.evidence).toStrictEqual([rawProof]);

    const expectedContent = CARD_CONTENT(cardId, "ready-image");
    const mutationView = mutation.snapshot.cards[0]!.items[0]!.evidence[0] as unknown as Record<string, unknown>;
    expect(mutationView).toMatchObject({
      type: "image", label: "화면", url: expectedContent, attachment_id: "ready-image",
      descriptor: { attachment_id: "ready-image", name: "ready-image.bin", mime_type: "image/png", preview_kind: "image" },
      read_context: { type: "card", id: cardId }, previewUrl: expectedContent,
      originalUrl: expectedContent + "&download=true",
    });
    expect(mutationView).not.toHaveProperty("availability");

    await h.sql.unsafe("DELETE FROM sessions WHERE session_id=$1", [MEMBER]);
    const detail = await cards.getCard(cardId);
    const detailView = detail!.card.items[0]!.evidence[0] as unknown as Record<string, unknown>;
    expect(detailView).toStrictEqual(mutationView);
    const folder = await cards.getFolder(FOLDER_ID);
    expect(folder!.cards[0]!.items[0]!.evidence[0]).toStrictEqual(mutationView);
    const listed = await cards.projectCards(await cards.listCards({ folderId: FOLDER_ID }));
    expect(listed[0]!.items[0]!.evidence[0]).toStrictEqual(mutationView);

    const serialized = serializeCardRow(detail!.card);
    const serializedItems = serialized.items as { evidence: Record<string, unknown>[] }[];
    expect(serializedItems[0]!.evidence[0]).toMatchObject({ attachment_id: "ready-image", read_context: { type: "card", id: cardId } });
    const mcp = await reader.getCard(cardId, {}, null);
    expect(mcp.card.items[0].evidence[0]).toStrictEqual(mutationView);
  });

  it("keeps unavailable evidence local to its item and requires the stored card ref", async () => {
    const cardId = await makeCard();
    await insertAsset("ready-image", cardId);
    await insertAsset("pending-image", cardId, { status: "pending" });
    await insertAsset("unreferenced-image", cardId);
    const items = await storedItems(cardId);
    items[0]!.evidence = [
      proof("ready-image"),
      proof("text-link", "텍스트", "link"),
      proof("missing-image"),
      proof("pending-image"),
      proof("unreferenced-image"),
    ];
    await insertAsset("text-link", cardId, { mime: "text/plain" });
    const refs = ["ready-image", "text-link", "missing-image", "pending-image"].map((attachment_id) => ({ attachment_id }));
    await h.sql`UPDATE cards SET items=${h.sql.json(items)}::jsonb,attachment_refs=${h.sql.json(refs)}::jsonb WHERE id=${cardId}`;

    const detail = await cards.getCard(cardId);
    const evidence = detail!.card.items[0]!.evidence as unknown as Record<string, unknown>[];
    const ready = evidence[0]!;
    expect(ready).toMatchObject({ url: CARD_CONTENT(cardId, "ready-image"), descriptor: { preview_kind: "image" } });
    const textLink = evidence[1]!;
    expect(textLink).toMatchObject({
      url: CARD_CONTENT(cardId, "text-link") + "&download=true", previewUrl: null,
      originalUrl: CARD_CONTENT(cardId, "text-link") + "&download=true",
      descriptor: { preview_kind: "text" },
    });
    for (const [view, availability] of [[evidence[2]!, "missing"], [evidence[3]!, "unavailable"]] as const) {
      expect(view).toMatchObject({
        url: "", attachment_id: expect.any(String), availability,
        read_context: { type: "card", id: cardId }, previewUrl: null, originalUrl: "",
      });
      expect(view).not.toHaveProperty("descriptor");
    }
    expect(evidence[4]).toStrictEqual(proof("unreferenced-image"));
    const mcp = await reader.getCard(cardId, {}, null);
    expect(mcp.card.items[0].evidence).toStrictEqual(evidence);
  });

  it("projects titled inline links that the source-ref validator accepts", async () => {
    const cardId = await makeCard();
    await insertAsset("titled-image", cardId);
    const rawContent = "/api/attachments/titled-image/content?context_type=owner";
    const sourceBody = '![image](' + rawContent + ' "화면") and [file](<' + rawContent + '> \'원본\')';
    const refs = [{ attachment_id: "titled-image" }];
    await h.sql`UPDATE cards SET request=${sourceBody},attachment_refs=${h.sql.json(refs)}::jsonb WHERE id=${cardId}`;

    const detail = await cards.getCard(cardId);
    const cardContent = CARD_CONTENT(cardId, "titled-image");
    expect(detail!.card.request).toBe('![image](' + cardContent + ' "화면") and [file](<' + cardContent + '> \'원본\')');
    expect(detail!.card.request).not.toContain("context_type=owner");
  });

  it("projects only source-ref URLs before request clipping and fingerprints source refs", async () => {
    const cardId = await makeCard();
    await insertAsset("source-image", cardId);
    const rawContent = "/api/attachments/source-image/content?context_type=owner";
    const unreferencedContent = "/api/attachments/not-a-ref/content?context_type=owner";
    const sourceBody = "start ![image](" + rawContent + ") [external](https://example.test) ![old](" +
      unreferencedContent + ") end";
    const projectedBody = sourceBody.replace(rawContent, CARD_CONTENT(cardId, "source-image"));
    const refs = [{ attachment_id: "source-image" }];
    await h.sql`UPDATE cards SET request=${sourceBody},attachment_refs=${h.sql.json(refs)}::jsonb WHERE id=${cardId}`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id,attachment_refs)
      VALUES ('projection-report',${cardId},'보고','markdown',${sourceBody},${ASSIGNEE},${h.sql.json(refs)}::jsonb)`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id,attachment_refs)
      VALUES ('projection-html',${cardId},'HTML','html',${'<img src="' + rawContent + '">'},${ASSIGNEE},${h.sql.json(refs)}::jsonb)`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,session_id,attachment_refs)
      VALUES ('projection-comment',${cardId},'agent','comment',${sourceBody},${ASSIGNEE},${h.sql.json(refs)}::jsonb),
             ('projection-note',${cardId},'agent','note',${sourceBody},${ASSIGNEE},${h.sql.json(refs)}::jsonb)`;

    const detail = await cards.getCard(cardId);
    expect(detail!.card.request).toBe(projectedBody);
    expect(detail!.reports.find((row) => row.id === "projection-report")!.body).toBe(projectedBody);
    expect(detail!.reports.find((row) => row.id === "projection-html")!.body).toBe('<img src="' + rawContent + '">');
    expect(detail!.comments[0]!.body).toBe(projectedBody);
    expect(detail!.notes[0]!.body).toBe(projectedBody);
    expect((await cards.listReports(cardId)).find((row) => row.id === "projection-report")!.body).toBe(projectedBody);
    expect((await cardRepository.getComment(cardId, "projection-comment"))!.body).toBe(projectedBody);
    expect((await cards.listCardNotes({ ...agent, cardId, limit: 10 })).notes[0]!.body).toBe(projectedBody);
    // The write path validates internal attachment URLs (C-09), so the mutation
    // response check uses a body whose only internal URL is a stored ref.
    const noteBody = "note ![image](" + rawContent + ")";
    const serviceNote = await cards.addCardNote({ ...agent, cardId, text: noteBody, idempotencyKey: key() });
    expect(serviceNote.body).toBe(noteBody.replace(rawContent, CARD_CONTENT(cardId, "source-image")));

    const limit = 75;
    const first = await reader.getCard(cardId, { include: ["request", "reports", "comments", "notes"], text_limit: limit }, null);
    expect(first.sections.request.text).toBe(Array.from(projectedBody).slice(0, limit).join(""));
    // Page through the clipped request until the cursor ends; the projected
    // body is longer than two pages at this limit.
    let requestText: string = first.sections.request.text;
    let requestCursor: string | null = first.sections.request.nextCursor;
    while (requestCursor !== null) {
      const page = await reader.getCard(cardId, {
        include: ["request"], text_limit: limit, cursors: { request: requestCursor },
      }, null);
      requestText += page.sections.request.text;
      requestCursor = page.sections.request.nextCursor;
    }
    expect(requestText).toBe(projectedBody);
    expect(first.sections.reports.items.find((row: Record<string, unknown>) => row.id === "projection-report")!.body).toBe(projectedBody);
    expect(first.sections.comments.items[0]!.body).toBe(projectedBody);
    expect(first.sections.notes.items.find((row: Record<string, unknown>) => row.id === "projection-note")!.body).toBe(projectedBody);
    expect((await h.sql.unsafe("SELECT request FROM cards WHERE id=$1", [cardId]))[0]!.request).toBe(sourceBody);

    const unchanged = await reader.getCard(cardId, { include: ["reports", "comments", "notes"] }, null);
    expect((await reader.getCard(cardId, { since: unchanged.changeToken, include: ["reports", "comments", "notes"] }, null)))
      .toMatchObject({ unchanged: true });
    await h.sql.unsafe("UPDATE cards SET attachment_refs='[]'::jsonb WHERE id=$1", [cardId]);
    await h.sql.unsafe("UPDATE card_reports SET attachment_refs='[]'::jsonb WHERE card_id=$1", [cardId]);
    await h.sql.unsafe("UPDATE card_comments SET attachment_refs='[]'::jsonb WHERE card_id=$1", [cardId]);
    const changed = await reader.getCard(cardId, {
      since: unchanged.changeToken, include: ["request", "reports", "comments", "notes"],
    }, null);
    expect(changed.changed).toEqual(expect.arrayContaining(["card", "request", "reports", "comments", "notes"]));
  });
});
