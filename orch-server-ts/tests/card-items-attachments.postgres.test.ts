import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import {
  AttachmentReadError,
  createAttachmentReadService,
  type AttachmentReadActor,
  type AttachmentReadStorageBinding,
} from "../src/attachments/attachment_read_service.js";
import { createLiveAttachmentReadRepository } from "../src/runtime/live_attachment_read_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

const ORIGINAL_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const ENDPOINT = "https://r2.example.test";
const BUCKET = "private-attachments";

describe("card item evidence attachment ids", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let sequence = 0;
  const key = () => `card-item-attachments:${++sequence}`;
  const user = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const agent = (sessionId: string) => ({ actorKind: "agent" as const, actorSessionId: sessionId });
  const assignee = agent("session-a");

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('item-attachments','첨부 증거')`;
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx });
  }, 60_000);

  afterAll(async () => h?.cleanup());

  beforeEach(async () => {
    await h.sql`DELETE FROM folder_operations WHERE folder_id='item-attachments'`;
    await h.sql`DELETE FROM cards WHERE folder_id='item-attachments'`;
    await h.sql`DELETE FROM file_assets`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('session-a','running'),('session-b','running'),('session-c','running')
      ON CONFLICT (session_id) DO NOTHING`;
  });

  async function makeCard(sessionId = "session-a", itemTitles = ["첨부 확인", "두 번째 확인"]) {
    const created = await cards.createCard({
      ...user, folderId: "item-attachments", title: "첨부 증거 카드", request: "요청 원문",
      assignee: { kind: "session", sessionId }, idempotencyKey: key(),
    });
    const cardId = created.operation.target_id;
    await cards.setCardItems({ ...agent(sessionId), cardId, items: itemTitles });
    return cardId;
  }
  async function joinCard(sessionId: string, cardId: string) {
    await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id=${sessionId}`;
  }
  async function cardScopedAsset(id: string, cardId: string, options: {
    owner?: string; ownerKind?: string; mime?: string; status?: string;
  } = {}) {
    const owner = options.owner ?? "session-b";
    await h.sql`INSERT INTO file_assets(
      id, storage_key, storage_purpose, storage_endpoint, storage_bucket, owner_kind, owner_key,
      registration_scope, source_session_id, original_name, mime_type, byte_size, upload_status
    ) VALUES (
      ${id}, ${`private/${id}`}, 'attachment', ${ENDPOINT}, ${BUCKET}, ${options.ownerKind ?? "agent_session"}, ${owner},
      ${h.sql.json({ type: "card", id: cardId })}::jsonb,
      ${owner}, ${`${id}.png`}, ${options.mime ?? "image/png"}, 8, ${options.status ?? "committed"}
    )`;
  }
  const proof = (attachmentId: string, label = "화면") => ({ type: "image" as const, label, attachment_id: attachmentId });
  const report = (cardId: string, itemId: number, evidence?: ReturnType<typeof proof>[], extra: { actor?: ReturnType<typeof agent>; result?: string } = {}) =>
    cards.reportCardItem({
      ...(extra.actor ?? assignee), cardId, itemId, state: "done", result: extra.result ?? "첨부를 확인했습니다",
      ...(evidence === undefined ? {} : { evidence }), idempotencyKey: key(),
    });
  const storedCard = async (cardId: string) => (await h.sql<{ items: { evidence: unknown[] }[]; attachment_refs: unknown; version: number }[]>`
    SELECT items, attachment_refs, version FROM cards WHERE id=${cardId}`)[0]!;
  // 집계 ref의 순서는 항목 순서를 따를 뿐 계약이 아니므로 정렬해서 비교한다.
  const refIds = async (cardId: string) => ((await storedCard(cardId)).attachment_refs as { attachment_id: string }[]).map((ref) => ref.attachment_id).sort();

  it("links a member's committed card image by id only and stores the item and aggregate ref together", async () => {
    const cardId = await makeCard();
    await joinCard("session-b", cardId);
    await cardScopedAsset("img-b", cardId);
    const before = await storedCard(cardId);

    const result = await report(cardId, 1, [proof("img-b")]);
    expect(result.operation.payload_json.evidence).toStrictEqual([proof("img-b")]);

    const stored = await storedCard(cardId);
    expect(stored.items[0]!.evidence).toStrictEqual([proof("img-b")]);
    expect(stored.attachment_refs).toStrictEqual([{ attachment_id: "img-b" }]);
    expect(stored.version).toBe(before.version + 1);
    const detail = await cards.getCard(cardId);
    const contentUrl = "/api/attachments/img-b/content?context_type=card&context_id=" + encodeURIComponent(cardId);
    expect(detail!.card.items[0]!.evidence[0]).toStrictEqual({
      type: "image", label: "화면", url: contentUrl, attachment_id: "img-b",
      descriptor: {
        attachment_id: "img-b", name: "img-b.png", mime_type: "image/png", byte_size: 8,
        checksum_sha256: null, width: null, height: null, preview_kind: "image", preview_mime_type: "image/png",
      },
      read_context: { type: "card", id: cardId }, previewUrl: contentUrl,
      originalUrl: contentUrl + "&download=true",
    });
    expect(detail!.card.attachment_refs).toStrictEqual([{ attachment_id: "img-b" }]);
  });

  it("rolls back the item, refs, version and operation for an unusable attachment", async () => {
    const cardId = await makeCard();
    await joinCard("session-b", cardId);
    const otherCardId = await makeCard("session-c");
    await cardScopedAsset("img-pending", cardId, { status: "pending" });
    await cardScopedAsset("img-elsewhere", otherCardId);
    await cardScopedAsset("img-stranger", cardId, { owner: "session-c" });
    await cardScopedAsset("img-user-owned", cardId, { ownerKind: "user_email", owner: "director" });
    await cardScopedAsset("img-svg", cardId, { mime: "image/svg+xml" });
    const before = await storedCard(cardId);
    const operations = async () => (await h.sql`SELECT id FROM folder_operations WHERE target_id=${cardId} AND operation_type='report_card_item'`).length;

    const cases: [string, number, string][] = [
      ["img-missing", 404, "ATTACHMENT_NOT_FOUND"],
      ["img-pending", 409, "ATTACHMENT_NOT_COMMITTED"],
      ["img-elsewhere", 403, "ATTACHMENT_CARD_SCOPE_DENIED"],
      ["img-stranger", 403, "ATTACHMENT_LINK_DENIED"],
      ["img-user-owned", 403, "ATTACHMENT_LINK_DENIED"],
      ["img-svg", 422, "ATTACHMENT_IMAGE_REQUIRED"],
    ];
    for (const [id, statusCode, code] of cases) {
      await expect(report(cardId, 1, [proof(id)])).rejects.toMatchObject({ statusCode, code });
    }
    // 한 항목 안에서 앞의 증거가 유효해도 뒤의 증거가 거절되면 전체가 되돌아간다.
    await cardScopedAsset("img-ok", cardId);
    await expect(report(cardId, 1, [proof("img-ok"), proof("img-missing")])).rejects.toMatchObject({ statusCode: 404 });

    const after = await storedCard(cardId);
    expect(after).toStrictEqual(before);
    expect(await operations()).toBe(0);
  });

  it("keeps an id that another item still uses, and removes it from the refs once nothing uses it", async () => {
    const cardId = await makeCard();
    await cardScopedAsset("img-1", cardId, { owner: "session-a" });
    await cardScopedAsset("img-2", cardId, { owner: "session-a" });

    await report(cardId, 1, [proof("img-1"), proof("img-2")]);
    await report(cardId, 2, [proof("img-1", "같은 증거")]);
    expect(await refIds(cardId)).toEqual(["img-1", "img-2"]);

    await report(cardId, 1, [proof("img-2")]);
    expect(await refIds(cardId)).toEqual(["img-1", "img-2"]);

    await report(cardId, 2, []);
    expect(await refIds(cardId)).toEqual(["img-2"]);
    expect(await h.sql`SELECT id FROM file_assets WHERE id='img-1'`).toHaveLength(1);
  });

  it("does not drop the extra metadata of a source ref that an item also uses", async () => {
    const cardId = await makeCard();
    await cardScopedAsset("img-legacy", cardId, { owner: "session-a" });
    const legacy = { attachment_id: "img-legacy", legacy_url: "/api/attachments/files?nodeId=n&path=p.png" };
    await h.sql`UPDATE cards SET attachment_refs=${h.sql.json([legacy])} WHERE id=${cardId}`;

    await report(cardId, 1, [proof("img-legacy")]);
    expect((await storedCard(cardId)).attachment_refs).toStrictEqual([legacy]);
    await report(cardId, 1, []);
    expect((await storedCard(cardId)).attachment_refs).toStrictEqual([legacy]);
  });

  it("keeps url evidence as given and lets only the assignee session report", async () => {
    const cardId = await makeCard();
    await joinCard("session-b", cardId);
    await cardScopedAsset("img-b", cardId);
    const link = { type: "link" as const, label: "외부", url: "https://example.com/result" };

    await cards.reportCardItem({ ...assignee, cardId, itemId: 1, state: "done", result: "외부 링크를 달았습니다", evidence: [link], idempotencyKey: key() });
    const stored = await storedCard(cardId);
    expect(stored.items[0]!.evidence).toStrictEqual([link]);
    expect(stored.attachment_refs).toStrictEqual([]);

    await expect(report(cardId, 2, [proof("img-b")], { actor: agent("session-b") })).rejects.toMatchObject({ statusCode: 422 });
    expect(await refIds(cardId)).toEqual([]);
  });

  it("stores url evidence that points at another owner's attachment without making a ref, while the same id as attachment_id is denied", async () => {
    const cardId = await makeCard();
    await cardScopedAsset("img-foreign", cardId, { owner: "session-c" });
    const viaUrl = { type: "image" as const, label: "남의 첨부", url: `/api/attachments/img-foreign/content?context_type=card&context_id=${cardId}` };

    await cards.reportCardItem({ ...assignee, cardId, itemId: 1, state: "done", result: "URL 증거를 달았습니다", evidence: [viaUrl], idempotencyKey: key() });
    const stored = await storedCard(cardId);
    expect(stored.items[0]!.evidence).toStrictEqual([viaUrl]);
    expect(stored.attachment_refs).toStrictEqual([]);

    await expect(report(cardId, 1, [proof("img-foreign")])).rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_LINK_DENIED" });
    expect(await storedCard(cardId)).toStrictEqual(stored);
  });

  const storage = { openObject: vi.fn(async () => new Response(ORIGINAL_BYTES)) };
  const binding: AttachmentReadStorageBinding = { storage, identity: "item-reader", location: { endpoint: ENDPOINT, bucket: BUCKET } };
  const reader: AttachmentReadActor = { kind: "user", email: "reader@example.com" };
  const readerFor = (cardId: string, allow: boolean) => createAttachmentReadService({
    repository: createLiveAttachmentReadRepository(createLiveDbSqlResolver({ sql: h.liveSql })),
    access: {
      requireScope: async (_actor, scope) => {
        if (allow && scope.type === "card" && scope.id === cardId) return;
        throw new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "denied", 403);
      },
    },
    resolveReadStorage: async () => binding,
    readPageAttachmentEvidence: async () => null,
  });

  it("does not turn an unverified stored request url into a card ref when an item is reported", async () => {
    const cardId = await makeCard();
    await cardScopedAsset("img-foreign", cardId, { owner: "session-c" });
    // 이 기능 전에 저장된, 검증되지 않은 request 본문이 타인 소유 첨부를 가리키고 ref는 비어 있는 옛 상태.
    await h.sql`UPDATE cards SET request=${"옛 요청 ![x](/api/attachments/img-foreign/content)"}, attachment_refs=${h.sql.json([])} WHERE id=${cardId}`;
    await expect(readerFor(cardId, true).metadata(reader, "img-foreign", { type: "card", id: cardId })).rejects.toMatchObject({ statusCode: 403 });

    await report(cardId, 1);
    expect((await storedCard(cardId)).attachment_refs).toStrictEqual([]);
    await expect(readerFor(cardId, true).metadata(reader, "img-foreign", { type: "card", id: cardId })).rejects.toMatchObject({ statusCode: 403 });
    await expect(readerFor(cardId, true).content(reader, "img-foreign", { type: "card", id: cardId }, { method: "GET" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps a verified request ref when an item that used the same id stops using it", async () => {
    const cardId = await makeCard();
    await cardScopedAsset("img-shared", cardId, { owner: "session-a" });
    await h.sql`UPDATE cards SET request=${"요청 ![x](/api/attachments/img-shared/content)"}, attachment_refs=${h.sql.json([{ attachment_id: "img-shared" }])} WHERE id=${cardId}`;

    await report(cardId, 1, [proof("img-shared")]);
    expect(await refIds(cardId)).toEqual(["img-shared"]);
    await report(cardId, 1, []);
    expect(await refIds(cardId)).toEqual(["img-shared"]);
  });

  describe("after the producing session is deleted", () => {
    async function linkedThenProducerDeleted() {
      const cardId = await makeCard();
      await joinCard("session-b", cardId);
      await cardScopedAsset("img-b", cardId);
      await report(cardId, 1, [proof("img-b")]);
      await h.sql`DELETE FROM sessions WHERE session_id='session-b'`;
      return cardId;
    }

    it("keeps the ref, lets the assignee edit the item or repeat the same evidence, and still serves card readers", async () => {
      const cardId = await linkedThenProducerDeleted();
      expect(await refIds(cardId)).toEqual(["img-b"]);

      await cards.reportCardItem({ ...assignee, cardId, itemId: 1, state: "done", result: "결과만 고쳤습니다", idempotencyKey: key() });
      await report(cardId, 1, [proof("img-b")], { result: "같은 증거로 다시 보고했습니다" });
      await report(cardId, 1, [proof("img-b", "다른 이름")]);
      expect(await refIds(cardId)).toEqual(["img-b"]);
      expect((await storedCard(cardId)).items[0]!.evidence).toStrictEqual([proof("img-b", "다른 이름")]);

      const service = readerFor(cardId, true);
      const metadata = await service.metadata(reader, "img-b", { type: "card", id: cardId });
      expect(metadata).toMatchObject({ descriptor: { attachment_id: "img-b", mime_type: "image/png" }, upload_status: "committed" });
      const content = await service.content(reader, "img-b", { type: "card", id: cardId }, { method: "GET" });
      expect(new Uint8Array(await content.arrayBuffer())).toStrictEqual(ORIGINAL_BYTES);
      expect(storage.openObject).toHaveBeenCalledWith(expect.objectContaining({ storageKey: "private/img-b" }));

      const denied = readerFor(cardId, false);
      await expect(denied.metadata(reader, "img-b", { type: "card", id: cardId })).rejects.toMatchObject({ statusCode: 403 });
      await expect(denied.content(reader, "img-b", { type: "card", id: cardId }, { method: "GET" })).rejects.toMatchObject({ statusCode: 403 });
    });

    it("still requires the kept evidence to be committed and, for an image, a raster image", async () => {
      const cardId = await linkedThenProducerDeleted();
      await h.sql`UPDATE file_assets SET mime_type='image/svg+xml' WHERE id='img-b'`;
      await expect(report(cardId, 1, [proof("img-b")])).rejects.toMatchObject({ statusCode: 422, code: "ATTACHMENT_IMAGE_REQUIRED" });
      await h.sql`UPDATE file_assets SET mime_type='image/png',upload_status='pending' WHERE id='img-b'`;
      await expect(report(cardId, 1, [proof("img-b")])).rejects.toMatchObject({ statusCode: 409, code: "ATTACHMENT_NOT_COMMITTED" });
      expect(await refIds(cardId)).toEqual(["img-b"]);
    });

    it("does not let a new item adopt the deleted producer's attachment", async () => {
      const cardId = await linkedThenProducerDeleted();
      await expect(report(cardId, 2, [proof("img-b")])).rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_LINK_DENIED" });
    });
  });
});
