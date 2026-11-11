import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService, type CardMutationChange } from "../src/cards/card_control_plane_service.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

const item = (id: number, title: string) => ({ id, title, state: "todo", result: null, evidence: [], caveat: null,
  rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: "2026-11-11T00:00:00.000Z", reportedAt: null });

// merge_cards closes unstarted sources and folds their material into the target in one transaction.
describe("merge_cards", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  const actor = { actorKind: "agent" as const, actorSessionId: "pas" };
  const authorize = async () => {};
  const cardUpdates: string[] = [];
  const mutations: CardMutationChange[] = [];
  let sequence = 0;
  const key = (name: string) => `merge-${name}-${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT`;
    await h.sql`INSERT INTO folders(id,name) VALUES('merge-a','합치기 A'),('merge-b','합치기 B')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES('pas','idle')`;
    cards = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx },
      { emitFolderUpdated: async () => {}, emitCardUpdated: async cardId => { cardUpdates.push(cardId); } },
      change => { mutations.push(change); });
  }, 60_000);
  afterAll(async () => h?.cleanup());

  async function seedItems(cardId: string, titles: string[]) {
    await h.sql`UPDATE cards SET items=${h.sql.json(titles.map((title, index) => item(index + 1, title)))}::jsonb WHERE id=${cardId}`;
  }
  async function seedComment(cardId: string, input: { authorKind: "user" | "agent"; kind: "comment" | "spoken" | "note";
    body: string; itemId?: number }) {
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,item_id)
      VALUES(${randomUUID()},${cardId},${input.authorKind},NULL,${input.authorKind === "user" ? null : "pas"},${input.kind},${input.body},${input.itemId ?? null})`;
  }
  const notes = async (cardId: string) =>
    await h.sql`SELECT body,item_id FROM card_comments WHERE card_id=${cardId} AND kind='note' ORDER BY created_at,id`;
  const operations = async (cardId: string) =>
    await h.sql`SELECT count(*)::int AS count FROM folder_operations WHERE target_id=${cardId}`;

  it("folds two sources from different folders with their comments, notes, items and attachments", async () => {
    const target = await cards.createCard({ ...actor, folderId: "merge-a", title: "합칠 대상", request: "대상 요청",
      brief: "대상 인계", queue: true, assignee: { kind: "agent", agentId: "dev" },
      attachments: [{ nodeId: "n1", path: "/w/a.png", name: "a.png", mimeType: "image/png" }], idempotencyKey: key("target") });
    const targetId = target.operation.target_id;
    await seedItems(targetId, ["대상 항목 1", "대상 항목 2", "대상 항목 3"]);
    const source1 = await cards.createCard({ ...actor, folderId: "merge-a", title: "원천 1", request: "요청 하나",
      brief: "인계 하나", queue: true, assignee: { kind: "agent", agentId: "dev" },
      attachments: [{ nodeId: "n1", path: "/w/a.png", name: "a.png", mimeType: "image/png" },
        { nodeId: "n2", path: "/w/b.png", name: "b.png", mimeType: "image/png" }], idempotencyKey: key("source1") });
    const source1Id = source1.operation.target_id;
    await seedItems(source1Id, ["원천 하나 항목 1", "원천 하나 항목 2", "원천 하나 항목 3"]);
    await seedComment(source1Id, { authorKind: "user", kind: "comment", body: "첫 번째 의견" });
    await seedComment(source1Id, { authorKind: "user", kind: "spoken", body: "말한 것" });
    await seedComment(source1Id, { authorKind: "agent", kind: "note", body: "원천 하나 노트", itemId: 1 });
    const source2 = await cards.createCard({ ...actor, folderId: "merge-b", title: "원천 2", request: "요청 둘",
      brief: "인계 둘", queue: true, assignee: { kind: "agent", agentId: "dev" },
      attachments: [{ nodeId: "n2", path: "/w/b.png", name: "b.png", mimeType: "image/png" }], idempotencyKey: key("source2") });
    const source2Id = source2.operation.target_id;
    await seedItems(source2Id, ["원천 둘 항목 1", "원천 둘 항목 2"]);
    await seedComment(source2Id, { authorKind: "user", kind: "comment", body: "두 번째 의견" });
    await seedComment(source2Id, { authorKind: "agent", kind: "note", body: "원천 둘 노트" });

    const before = (await cards.getCard(targetId))!.card;
    const numbers = new Map((await Promise.all([targetId, source1Id, source2Id].map(async id =>
      [id, (await cards.getCard(id))!.card.number!] as const))));
    cardUpdates.length = 0;
    mutations.length = 0;
    const result = await cards.mergeCards({ ...actor, targetCardId: targetId, sourceCardIds: [source1Id, source2Id],
      idempotencyKey: key("merge") }, authorize);

    expect(result.idempotent).toBe(false);
    expect(result.card).toMatchObject({ id: targetId, status: "queued", version: before.version + 1 });
    expect(result.merged_cards.map(card => card.id)).toEqual([source1Id, source2Id]);
    expect(result.moved).toEqual({ request_sections: 2, comments: 3, notes: 2, items: 5, attachments: 1 });

    const merged = (await cards.getCard(targetId))!.card;
    expect(merged.status).toBe("queued");
    expect(merged.queue_position_key).toBe(before.queue_position_key);
    expect(merged.request).toContain("대상 요청");
    expect(merged.request).toContain(`## 합친 카드 #${numbers.get(source1Id)} 「원천 1」`);
    expect(merged.request).toContain("요청 하나");
    expect(merged.request).toContain(`### #${numbers.get(source1Id)}의 커멘트`);
    expect(merged.request).toContain("첫 번째 의견");
    expect(merged.request).toContain("말한 것");
    expect(merged.request).toContain(`## 합친 카드 #${numbers.get(source2Id)} 「원천 2」`);
    expect(merged.request).toContain(`### #${numbers.get(source2Id)}의 커멘트`);
    expect(merged.request).toContain("두 번째 의견");
    expect(merged.brief).toContain("대상 인계");
    expect(merged.brief).toContain(`## 합친 카드 #${numbers.get(source1Id)} 「원천 1」의 인계`);
    expect(merged.brief).toContain("인계 둘");
    expect(merged.items.map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(merged.items.map(row => row.title)).toEqual(["대상 항목 1", "대상 항목 2", "대상 항목 3",
      "원천 하나 항목 1", "원천 하나 항목 2", "원천 하나 항목 3", "원천 둘 항목 1", "원천 둘 항목 2"]);
    expect(merged.attachments.map(attachment => [attachment.nodeId, attachment.path]))
      .toEqual([["n1", "/w/a.png"], ["n2", "/w/b.png"]]);

    const targetNotes = await notes(targetId);
    expect(targetNotes).toHaveLength(3);
    expect(targetNotes).toEqual(expect.arrayContaining([
      { body: `[#${numbers.get(source1Id)}에서 옮김] 원천 하나 노트`, item_id: 4 },
      { body: `[#${numbers.get(source2Id)}에서 옮김] 원천 둘 노트`, item_id: null },
      { body: `합친 카드: #${numbers.get(source1Id)} 「원천 1」, #${numbers.get(source2Id)} 「원천 2」`, item_id: null },
    ]));
    for (const sourceId of [source1Id, source2Id]) {
      const source = (await cards.getCard(sourceId))!.card;
      expect(source.status).toBe("cancelled");
      expect(source.queue_position_key).toBeNull();
      expect(source.now).toMatchObject({ text: `#${numbers.get(targetId)} 카드에 합쳐 닫았습니다`, turn: "outside", sessionId: "pas" });
      expect((await notes(sourceId)).map(row => row.body)).toContain(
        `이 카드는 #${numbers.get(targetId)} 「합칠 대상」에 합쳐 닫았다`);
    }
    expect(cardUpdates).toEqual([source1Id, source2Id, targetId]);
    expect(mutations.map(change => change.result.operation.target_id)).toEqual([source1Id, source2Id, targetId]);
  });

  it("leaves every participant untouched when one source is not unstarted", async () => {
    const target = await cards.createCard({ ...actor, folderId: "merge-a", title: "남을 대상", request: "대상",
      queue: true, assignee: { kind: "agent", agentId: "dev" }, idempotencyKey: key("target") });
    const targetId = target.operation.target_id;
    const source1 = await cards.createCard({ ...actor, folderId: "merge-a", title: "괜찮은 원천", request: "원천",
      queue: true, assignee: { kind: "agent", agentId: "dev" }, idempotencyKey: key("source1") });
    const source1Id = source1.operation.target_id;
    await seedComment(source1Id, { authorKind: "user", kind: "comment", body: "남아야 하는 의견" });
    const ineligible = await cards.createCard({ ...actor, folderId: "merge-b", title: "사람 담당 원천", request: "원천",
      assignee: { kind: "human", userId: "director" }, idempotencyKey: key("source2") });
    const ineligibleId = ineligible.operation.target_id;
    const snapshot = async () => ({
      target: (await cards.getCard(targetId))!.card,
      source: (await cards.getCard(source1Id))!.card,
      ineligible: (await cards.getCard(ineligibleId))!.card,
      notes: (await notes(targetId)).length,
      operations: (await operations(targetId)).length,
    });
    const before = await snapshot();

    await expect(cards.mergeCards({ ...actor, targetCardId: targetId, sourceCardIds: [source1Id, ineligibleId],
      idempotencyKey: key("merge") }, authorize)).rejects.toMatchObject({ statusCode: 409, code: "CARD_NOT_UNSTARTED" });

    const after = await snapshot();
    expect(after.target).toMatchObject({ version: before.target.version, request: before.target.request, status: "queued" });
    expect(after.source).toMatchObject({ version: before.source.version, status: "queued" });
    expect(after.ineligible.version).toBe(before.ineligible.version);
    expect(after.notes).toBe(before.notes);
    expect(after.operations).toBe(before.operations);
    expect((await cards.getCard(targetId))!.card.request).toBe("대상");
  });

  it("replays the same key with the stored result and does not copy notes twice", async () => {
    const target = await cards.createCard({ ...actor, folderId: "merge-a", title: "재호출 대상", request: "대상",
      queue: true, assignee: { kind: "agent", agentId: "dev" }, idempotencyKey: key("target") });
    const targetId = target.operation.target_id;
    const source = await cards.createCard({ ...actor, folderId: "merge-b", title: "재호출 원천", request: "원천",
      queue: true, assignee: { kind: "agent", agentId: "dev" }, idempotencyKey: key("source") });
    const sourceId = source.operation.target_id;
    await seedComment(sourceId, { authorKind: "agent", kind: "note", body: "한 번만 옮겨야 하는 노트" });
    const idempotencyKey = key("merge");

    const first = await cards.mergeCards({ ...actor, targetCardId: targetId, sourceCardIds: [sourceId],
      idempotencyKey }, authorize);
    const afterFirst = await notes(targetId);
    const second = await cards.mergeCards({ ...actor, targetCardId: targetId, sourceCardIds: [sourceId],
      idempotencyKey }, authorize);

    expect(second.idempotent).toBe(true);
    expect({ ...second, idempotent: false }).toEqual(first);
    expect(await notes(targetId)).toEqual(afterFirst);
    expect((await notes(targetId)).filter(row => row.body.includes("한 번만 옮겨야 하는 노트"))).toHaveLength(1);
  });
});
