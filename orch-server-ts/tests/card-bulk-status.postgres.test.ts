import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

// bulk_set_card_status moves many cards with one key, reporting each card separately.
describe("bulk_set_card_status", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  const actor = { actorKind: "agent" as const, actorSessionId: "pas" };
  const authorize = async () => {};
  let sequence = 0;
  const key = (name: string) => `bulk-${name}-${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`CREATE TABLE worktrees(id TEXT PRIMARY KEY)`;
    await h.sql`ALTER TABLE sessions ADD COLUMN worktree_id TEXT REFERENCES worktrees(id)`;
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT`;
    await h.sql`INSERT INTO worktrees(id) VALUES('wt-1')`;
    await h.sql`INSERT INTO folders(id,name) VALUES('bulk','일괄')`;
    await h.sql`INSERT INTO sessions(session_id,status,agent_id) VALUES('pas','idle','pas-agent')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES('worker','idle'),('busy','idle'),('spare','idle')`;
    await h.sql`UPDATE sessions SET worktree_id='wt-1' WHERE session_id='worker'`;
    cards = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx });
  }, 60_000);
  afterAll(async () => h?.cleanup());

  const queuedCard = (name: string, assignee?: { kind: "session"; sessionId: string } | { kind: "human"; userId: string }) =>
    cards.createCard({ ...actor, folderId: "bulk", title: name, request: "", queue: true,
      ...(assignee ? { assignee } : {}), idempotencyKey: key(name) });

  it("holds a queued card without a session assignee", async () => {
    const created = await queuedCard("세션 없는 카드");
    const cardId = created.operation.target_id;
    const before = (await cards.getCard(cardId))!.card;

    const { results } = await cards.bulkSetCardStatus({ ...actor, cardIds: [cardId], status: "on_hold",
      idempotencyKey: key("hold") }, authorize);

    expect(results).toEqual([{ card_id: cardId, number: before.number, ok: true, status: "on_hold", version: before.version + 1 }]);
    const after = (await cards.getCard(cardId))!.card;
    expect(after.status).toBe("on_hold");
    expect(after.assignee_session_id).toBeNull();
    expect(after.queue_position_key).toBeNull();
  });

  it("holds a card whose idle assignee session stays connected, keeping its worktree", async () => {
    const created = await queuedCard("담당 있는 카드", { kind: "session", sessionId: "worker" });
    const cardId = created.operation.target_id;
    const reason = "잠시 보류";

    const { results } = await cards.bulkSetCardStatus({ ...actor, cardIds: [cardId], status: "on_hold", reason,
      idempotencyKey: key("hold") }, authorize);

    expect(results[0]).toMatchObject({ card_id: cardId, ok: true, status: "on_hold" });
    const after = (await cards.getCard(cardId))!.card;
    expect(after).toMatchObject({ status: "on_hold", assignee_kind: "session", assignee_session_id: "worker" });
    const session = (await h.sql`SELECT worktree_id FROM sessions WHERE session_id='worker'`)[0]!;
    expect(session.worktree_id).toBe("wt-1");
    const notes = await h.sql`SELECT kind,body,session_id FROM card_comments WHERE card_id=${cardId} AND kind='note'`;
    expect(notes).toEqual([{ kind: "note", body: reason, session_id: "pas" }]);
  });

  it("refuses to queue a card whose assignee session is connected", async () => {
    const cardId = (await h.sql`SELECT id FROM cards WHERE title='담당 있는 카드'`)[0]!.id as string;

    const { results } = await cards.bulkSetCardStatus({ ...actor, cardIds: [cardId], status: "queued",
      idempotencyKey: key("queue") }, authorize);

    expect(results[0]).toMatchObject({ card_id: cardId, ok: false });
    expect(results[0]!.ok === false && results[0]!.error).toContain("보류·취소만 가능합니다");
    expect((await cards.getCard(cardId))!.card.status).toBe("on_hold");
  });

  it("reports a running card as a per-card failure", async () => {
    const created = await queuedCard("실행 중 카드", { kind: "session", sessionId: "busy" });
    const cardId = created.operation.target_id;
    await h.sql`UPDATE cards SET status='running' WHERE id=${cardId}`;

    const { results } = await cards.bulkSetCardStatus({ ...actor, cardIds: [cardId], status: "on_hold",
      idempotencyKey: key("hold") }, authorize);

    expect(results[0]).toMatchObject({ card_id: cardId, ok: false });
    expect(results[0]!.ok === false && results[0]!.error).toContain("담당이 실행 중입니다");
    expect((await cards.getCard(cardId))!.card.status).toBe("running");
  });

  it("keeps the other cards moving when one card is refused", async () => {
    const first = await queuedCard("첫 카드");
    const refused = await queuedCard("사람 담당 카드", { kind: "human", userId: "director" });
    const last = await queuedCard("마지막 카드", { kind: "session", sessionId: "spare" });
    const ids = [first, refused, last].map(card => card.operation.target_id);

    const { results } = await cards.bulkSetCardStatus({ ...actor, cardIds: ids, status: "on_hold",
      idempotencyKey: key("hold") }, authorize);

    expect(results.map(item => item.ok)).toEqual([true, false, true]);
    expect(results[0]).toMatchObject({ card_id: ids[0], status: "on_hold" });
    expect(results[1]).toMatchObject({ card_id: ids[1], ok: false });
    expect(results[1]!.ok === false && results[1]!.error).toContain("사람이 담당인 카드는");
    expect(results[2]).toMatchObject({ card_id: ids[2], status: "on_hold" });
    expect((await cards.getCard(ids[0]!))!.card.status).toBe("on_hold");
    expect((await cards.getCard(ids[1]!))!.card.status).toBe("queued");
    expect((await cards.getCard(ids[2]!))!.card.status).toBe("on_hold");
  });
});
