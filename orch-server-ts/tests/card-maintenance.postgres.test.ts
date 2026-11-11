import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

// update_unstarted_card keeps status/queue and edits only the fields the caller named.
describe("update_unstarted_card", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  const actor = { actorKind: "agent" as const, actorSessionId: "pas" };
  const authorize = async () => {};
  let sequence = 0;
  const key = (name: string) => `maintenance-${name}-${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT`;
    await h.sql`INSERT INTO folders(id,name) VALUES('edit','편집'),('other','다른 폴더')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES('pas','idle'),('owner','idle')`;
    cards = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx });
  }, 60_000);
  afterAll(async () => h?.cleanup());

  it("changes the named fields on a queued card and keeps omitted ones", async () => {
    const created = await cards.createCard({ ...actor, folderId: "edit", title: "초기 제목", request: "초기 요청",
      brief: "초기 인계", queue: true, assignee: { kind: "agent", agentId: "dev" }, nodeId: "node-1", modelPreset: "preset-1",
      idempotencyKey: key("create") });
    const cardId = created.operation.target_id;
    const before = (await h.sql`SELECT * FROM cards WHERE id=${cardId}`)[0]!;

    const result = await cards.updateUnstartedCard({ ...actor, cardId, title: "새 제목", request: "새 요청",
      agentId: "dev-2", idempotencyKey: key("update") }, authorize);

    expect(result.idempotent).toBe(false);
    expect(result.changed_fields).toEqual(["title", "request", "agent_id"]);
    expect(result.card).toMatchObject({ id: cardId, status: "queued", version: before.version + 1 });
    const after = (await h.sql`SELECT * FROM cards WHERE id=${cardId}`)[0]!;
    expect(after.title).toBe("새 제목");
    expect(after.request).toBe("새 요청");
    expect(after.assignee_kind).toBe("agent");
    expect(after.assignee_agent_id).toBe("dev-2");
    expect(after.assignee_session_id).toBeNull();
    expect(after.assignee_user_id).toBeNull();
    expect(after.brief).toBe("초기 인계");
    expect(after.node_id).toBe("node-1");
    expect(after.model_preset).toBe("preset-1");
    expect(after.status).toBe("queued");
    expect(after.queue_position_key).toBe(before.queue_position_key);
  });

  it("refuses a card whose assignee session is connected", async () => {
    const created = await cards.createCard({ ...actor, folderId: "edit", title: "담당 카드", request: "",
      assignee: { kind: "session", sessionId: "owner" }, idempotencyKey: key("create") });
    const cardId = created.operation.target_id;

    await expect(cards.updateUnstartedCard({ ...actor, cardId, title: "바꾸기",
      idempotencyKey: key("update") }, authorize)).rejects.toMatchObject({ statusCode: 409, code: "CARD_NOT_UNSTARTED" });
    const after = (await h.sql`SELECT title,version FROM cards WHERE id=${cardId}`)[0]!;
    expect(after.title).toBe("담당 카드");
    expect(after.version).toBe(1);
  });

  it("replays the same key without changing the card twice", async () => {
    const created = await cards.createCard({ ...actor, folderId: "other", title: "멱등 카드", request: "",
      assignee: { kind: "agent", agentId: "dev" }, idempotencyKey: key("create") });
    const cardId = created.operation.target_id;
    const idempotencyKey = key("update");

    const first = await cards.updateUnstartedCard({ ...actor, cardId, title: "한 번만",
      idempotencyKey }, authorize);
    const second = await cards.updateUnstartedCard({ ...actor, cardId, title: "한 번만",
      idempotencyKey }, authorize);

    expect(second.idempotent).toBe(true);
    expect(second.card).toEqual(first.card);
    expect(second.changed_fields).toEqual(["title"]);
    const after = (await h.sql`SELECT title,version FROM cards WHERE id=${cardId}`)[0]!;
    expect(after.title).toBe("한 번만");
    expect(after.version).toBe(first.card.version);
    const operations = await h.sql`SELECT count(*)::int AS count FROM folder_operations
      WHERE idempotency_key=${`card-maintenance:update_unstarted_card:pas:${idempotencyKey}`}`;
    expect(operations[0]!.count).toBe(1);
  });
});
