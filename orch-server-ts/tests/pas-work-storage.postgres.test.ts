import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardMutationCore } from "../src/cards/control_plane/card_mutation_core.js";
import { CardRepository } from "../src/cards/control_plane/card_repository.js";
import type { FolderDbPort, FolderOperationRow, RepositorySql } from "../src/cards/control_plane/card_types.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
// @ts-expect-error JavaScript migration contract boundary, matching existing migration tests.
import { loadMigrationManifest } from "../../packages/db-schema/scripts/migration-contract.mjs";

describe("PAS work storage primitives", () => {
  let h: PagePostgresHarness;
  const actor = { actorKind: "user" as const, actorSessionId: null, actorUserId: "pas-work-user" };
  const db = { appendEventTx: async () => 0 };

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('pas-work-storage','PAS work storage')`;
  }, 60_000);

  afterAll(async () => h?.cleanup());

  it("rolls back card mutation and operation when the in-transaction observer fails", async () => {
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    const sessionId = "pas-observer-session";
    await h.sql`INSERT INTO sessions(session_id,status) VALUES (${sessionId},'running')`;
    const eventDb: FolderDbPort = {
      appendEventTx: async (tx, params) => {
        const rows = await tx<{ id: number }[]>`SELECT event_append(${params.sessionId},${params.eventType},${params.payload},${params.searchableText},${params.createdAt},${params.dedupeKey ?? null}) AS id`;
        return rows[0]!.id;
      },
    };
    const observer = vi.fn(async (tx: RepositorySql, operation: FolderOperationRow) => {
      expect(operation.target_kind).toBe("card");
      expect(await tx`SELECT id FROM folder_operations WHERE id=${operation.id}`).toHaveLength(1);
      expect(await tx`SELECT id FROM cards WHERE id=${operation.target_id}`).toHaveLength(1);
      expect(await tx`SELECT id FROM events WHERE session_id=${sessionId}`).toHaveLength(1);
      throw new Error("observer failed");
    });
    const cards = new CardControlPlaneService(sql, eventDb, undefined, undefined, observer);

    await expect(cards.createCard({
      ...actor,
      actorSessionId: sessionId,
      folderId: "pas-work-storage",
      title: "atomic card",
      request: "atomic request",
      idempotencyKey: "observer-failure",
    })).rejects.toThrow("observer failed");

    expect(observer).toHaveBeenCalledTimes(1);
    expect(await h.sql`SELECT id FROM cards WHERE title='atomic card'`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='observer-failure'`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM events WHERE session_id=${sessionId}`).toHaveLength(0);
    expect(await h.sql`SELECT last_event_id FROM sessions WHERE session_id=${sessionId}`).toEqual([{ last_event_id: 0 }]);
  }, 60_000);

  it("runs the observer for sessionless card mutations inside the same transaction", async () => {
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    const cards = new CardControlPlaneService(sql, db);
    const made = await cards.createCard({
      ...actor,
      folderId: "pas-work-storage",
      title: "sessionless target",
      request: "original brief",
    });
    const cardId = made.operation.target_id;
    await h.sql`UPDATE cards SET brief='original brief' WHERE id=${cardId}`;
    const observer = vi.fn(async (tx: RepositorySql, operation: FolderOperationRow) => {
      expect(operation.target_kind).toBe("card");
      expect(await tx`SELECT id FROM folder_operations WHERE id=${operation.id}`).toHaveLength(1);
      expect(await tx`SELECT brief FROM cards WHERE id=${cardId}`).toEqual([{ brief: "changed brief" }]);
      throw new Error("sessionless observer failed");
    });
    const core = new CardMutationCore(db, new CardRepository(sql), undefined, observer);

    await expect(core.mutateWithoutSession({
      folderId: "pas-work-storage",
      targetKind: "card",
      targetId: cardId,
      operationType: "sessionless_card_change",
      actor: { actorKind: "system", actorSessionId: null },
      payload: { brief: "changed brief" },
      idempotencyKey: "sessionless-observer-failure",
      apply: async (tx) => { await tx`UPDATE cards SET brief='changed brief' WHERE id=${cardId}`; },
    })).rejects.toThrow("sessionless observer failed");

    expect(observer).toHaveBeenCalledTimes(1);
    expect((await h.sql`SELECT brief FROM cards WHERE id=${cardId}`)[0]!.brief).toBe("original brief");
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='sessionless-observer-failure'`).toHaveLength(0);
  }, 60_000);

  it("skips folder operations and idempotent replays", async () => {
    const observer = vi.fn(async () => {});
    const cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), db, undefined, undefined, observer);
    const params = {
      ...actor,
      folderId: "pas-work-storage",
      title: "observed card",
      request: "same request",
      idempotencyKey: "observed-card-create",
    };

    const first = await cards.createCard(params);
    const replay = await cards.createCard(params);
    await cards.setFolderStatus({
      ...actor,
      folderId: "pas-work-storage",
      expectedVersion: 1,
      status: "completed",
      idempotencyKey: "folder-status-change",
    });

    expect(first.operation.target_kind).toBe("card");
    expect(replay.idempotent).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("adds a nullable report target foreign key that clears when its session is deleted", async () => {
    const migrations = await loadMigrationManifest();
    const migration = migrations.find((item: { id: string; sql: string }) => item.id === "122_card_report_target_session.sql");
    expect(migration).toBeDefined();
    if (!migration) return;

    await h.sql`ALTER TABLE cards DROP COLUMN IF EXISTS report_target_session_id`;
    await h.sql.unsafe(migration.sql);
    await h.sql.unsafe(migration.sql);
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title) VALUES ('report-target-card','pas-work-storage','z','report target')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('report-target-session','running')`;
    await h.sql`UPDATE cards SET report_target_session_id='report-target-session' WHERE id='report-target-card'`;

    expect(await h.sql`SELECT report_target_session_id FROM cards WHERE id='report-target-card'`)
      .toEqual([{ report_target_session_id: "report-target-session" }]);
    await h.sql`DELETE FROM sessions WHERE session_id='report-target-session'`;
    expect(await h.sql`SELECT report_target_session_id FROM cards WHERE id='report-target-card'`)
      .toEqual([{ report_target_session_id: null }]);
    expect(await h.sql`INSERT INTO cards(id,folder_id,position_key,title) VALUES ('no-report-target','pas-work-storage','zz','nullable') RETURNING report_target_session_id`)
      .toEqual([{ report_target_session_id: null }]);
  }, 60_000);
});
