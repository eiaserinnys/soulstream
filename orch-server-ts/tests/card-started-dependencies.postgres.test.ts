import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { readCardDependencies } from "../src/cards/card_dependencies.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("dependencies of started cards", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  const sendMessage = vi.fn(async (..._args: unknown[]) => {});
  const warn = vi.fn();
  const human = { actorKind: "user" as const, actorSessionId: null };
  const owner = { actorKind: "agent" as const, actorSessionId: "owner" };
  let sequence = 0;
  const key = () => `started-dependency-${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN metadata JSONB, ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
    await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES('started-deps','시작한 카드 선행')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES('owner','running'),('other','running'),('pas','idle')`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":0}}','test')`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined, change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(async () => sql), cards: async () => cards, defaultNodeId: "node",
      resolveTarget: card => ({ nodeId: "node", agentId: card.assignee_agent_id ?? "dev", modelPreset: "test", available: true, reason: null }),
      launch: async () => {}, sendMessage, deliveryExists: async () => false, abandonDelivery: async () => {}, notify: async () => {}, warn });
  }, 60_000);
  afterAll(async () => h?.cleanup());

  async function waiting(status: "running" | "blocked" | "review", dependsOn: string[] = []) {
    const id = (await cards.createCard({ ...human, folderId: "started-deps", title: `시작한 카드 ${status}`, request: "",
      assignee: { kind: "session", sessionId: "owner" }, idempotencyKey: key() })).operation.target_id;
    await cards.setCardStatus({ ...human, cardId: id, status });
    if (dependsOn.length) await cards.setCardDependencies({ ...owner, cardId: id, dependsOn, idempotencyKey: key() });
    return id;
  }
  async function predecessor(title: string) {
    return (await cards.createCard({ ...human, folderId: "started-deps", title, request: "", idempotencyKey: key() })).operation.target_id;
  }
  const dependsOn = async (cardId: string) => (await readCardDependencies(createFolderContentSqlAdapter(h.liveSql), [cardId])).get(cardId)?.map(item => item.id) ?? [];
  async function release(cardId: string) {
    await cards.setCardStatus({ ...human, cardId, status: "done" });
    await dispatcher.drain();
  }
  const reset = async () => {
    await h.sql`DELETE FROM card_dependencies`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    sendMessage.mockClear();
    warn.mockClear();
  };

  it("lets the assigned session set and clear predecessors of a started card", async () => {
    await reset();
    const a = await waiting("running");
    const b = await predecessor("선행 B");
    const before = (await cards.getCard(a))!.card.version;
    const number = (await cards.getCard(b))!.card.number;
    await cards.setCardDependencies({ ...owner, cardId: a, dependsOn: [`#${number}`], idempotencyKey: key() });
    expect(await dependsOn(a)).toEqual([b]);
    expect((await cards.getCard(a))!.card.version).toBeGreaterThan(before);
    await cards.setCardDependencies({ ...owner, cardId: a, dependsOn: [], idempotencyKey: key() });
    expect(await dependsOn(a)).toEqual([]);
  });

  it("rejects a session that is not the assignee and leaves the predecessors untouched", async () => {
    await reset();
    const b = await predecessor("선행 B");
    const a = await waiting("running", [b]);
    await expect(cards.setCardDependencies({ actorKind: "agent", actorSessionId: "other", cardId: a, dependsOn: [], idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(cards.setCardDependencies({ actorKind: "agent", actorSessionId: "pas", cardId: a, dependsOn: [], idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect(await dependsOn(a)).toEqual([b]);
  });

  it("rejects a cycle with 409 and keeps the existing predecessors", async () => {
    await reset();
    const a = await waiting("running");
    const b = await predecessor("선행 B");
    const c = await predecessor("선행 C");
    await cards.setCardDependencies({ ...owner, cardId: a, dependsOn: [c], idempotencyKey: key() });
    await cards.updateUnstartedCard({ ...human, cardId: b, dependsOn: [a], idempotencyKey: key() }, async () => {});
    await expect(cards.setCardDependencies({ ...owner, cardId: a, dependsOn: [b], idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 409, code: "CARD_DEPENDENCY_CYCLE" });
    expect(await dependsOn(a)).toEqual([c]);
  });

  it("tells a blocked assignee once, only when its last predecessor is done", async () => {
    await reset();
    const b = await predecessor("선행 B");
    const c = await predecessor("선행 C");
    const a = await waiting("blocked", [b, c]);
    await release(b);
    expect(sendMessage).not.toHaveBeenCalled();
    await release(c);
    expect(sendMessage).toHaveBeenCalledOnce();
    const [sessionId, text, admission, delivery] = sendMessage.mock.calls[0]!;
    expect(sessionId).toBe("owner");
    expect(admission).toBeUndefined();
    expect(text).toEqual(expect.stringMatching(/^\[선행 카드 완료\]/));
    expect(delivery).toEqual({ deliveryId: `card-dependencies-met:${a}:${[b, c].sort().join(",")}`, actorKind: "system", actorSessionId: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not tell the assignee of a card in review", async () => {
    await reset();
    const b = await predecessor("선행 B");
    const c = await predecessor("선행 C");
    await waiting("review", [b, c]);
    await release(b);
    await release(c);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
