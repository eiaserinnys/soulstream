import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardExecutionService } from "../src/cards/card_execution_service.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";

describe("PAS work transaction storage", () => {
  let h: PagePostgresHarness;
  let sql: ReturnType<typeof createBoardYjsSqlAdapter>;
  let cards: CardControlPlaneService;
  let execution: CardExecutionService;
  let sequence = 0;
  const folderId = "pas-work-tx";
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const agent = { actorKind: "agent" as const, actorSessionId: "pas-agent" };
  const onMutation = vi.fn();
  const key = () => `pas-work-tx:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/116_card_execution_requests.sql", import.meta.url), "utf8"));
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'PAS 작업')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id,status,agent_id,node_id,model_preset)
      VALUES ('pas-agent',${folderId},'running','roselin','eiaserinnys','codex-6-luna')`;
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
    cards = new CardControlPlaneService(sql, db, undefined, onMutation);
    execution = new CardExecutionService({
      sql,
      cards,
      validate: async card => ({ nodeId: card.node_id ?? "eiaserinnys", agentId: "roselin", modelPreset: card.model_preset }),
      launch: async () => {},
      ensure: async () => ({ state: "started", execution: { registrationId: "registration", executionCommandId: "command" } }),
    });
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("creates a card and reserves its execution inside the caller's transaction", async () => {
    const cardId = `tx-card-${++sequence}`;
    const createKey = key();
    onMutation.mockClear();
    const saved = await sql.begin(async tx => {
      const created = await cards.createCardTx(tx, {
        ...agent, folderId, title: "원자 접수", request: "사용자 지시", idempotencyKey: createKey, cardId,
      });
      const reserved = await execution.reserveTx(tx, {
        ...human, cardId, expectedVersion: created.card.version, idempotencyKey: `reserve:${createKey}`,
      });
      return { created, reserved };
    });

    expect(saved.created.card.id).toBe(cardId);
    expect(saved.created.operation.target_id).toBe(cardId);
    expect(saved.reserved.card_id).toBe(cardId);
    expect(saved.reserved.state).toBe("pending");
    expect(onMutation).not.toHaveBeenCalled();
    expect(await h.sql`SELECT id FROM cards WHERE id=${cardId}`).toHaveLength(1);
    expect(await h.sql`SELECT id FROM folder_operations WHERE id=${saved.created.operation.id}`).toHaveLength(1);
    expect(await h.sql`SELECT id FROM card_execution_requests WHERE id=${saved.reserved.id}`).toHaveLength(1);
  });

  it("rolls a PAS comment and its operation back with the caller's transaction", async () => {
    const created = await cards.createCard({ ...human, folderId, title: "롤백 대상", request: "원문", idempotencyKey: key() });
    const cardId = created.operation.target_id;
    const card = (await cards.getCard(cardId))!.card;
    const commentId = `tx-comment-${sequence}`;
    onMutation.mockClear();

    await expect(sql.begin(async tx => {
      await cards.addCommentTx(tx, {
        ...agent, cardId, expectedVersion: card.version, idempotencyKey: key(), commentId,
        body: "접수된 후속 지시", mode: "spoken",
      });
      throw new Error("rollback caller transaction");
    })).rejects.toThrow("rollback caller transaction");

    expect(await h.sql`SELECT id FROM card_comments WHERE id=${commentId}`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM folder_operations WHERE target_id=${cardId} AND operation_type='add_card_comment'`).toHaveLength(0);
    expect((await cards.getCard(cardId))!.card.version).toBe(card.version);

    const committed = await sql.begin(tx => cards.addCommentTx(tx, {
      ...agent, cardId, expectedVersion: card.version, idempotencyKey: key(), commentId,
      body: "접수된 후속 지시", mode: "spoken",
    }));
    expect(committed.comment).toMatchObject({ id: commentId, card_id: cardId, author_kind: "user", kind: "spoken", body: "접수된 후속 지시" });
    expect(committed.card.id).toBe(cardId);
    expect(committed.operation.payload_json.comment_id).toBe(commentId);
    expect(typeof committed.eventId).toBe("number");
    expect(onMutation).not.toHaveBeenCalled();
  });

});
