import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { registerFolderRoutes } from "../src/folders/folder_routes.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("card numbers over PostgreSQL and HTTP", () => {
  let h: FullSchemaPostgresHarness;
  let cards: CardControlPlaneService;
  const folderId = randomUUID();
  const movedFolderId = randomUUID();
  const userId = "card-number-test@example.com";

  beforeAll(async () => {
    h = await createFullSchemaPostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'Card numbers'),(${movedFolderId},'Moved cards')`;
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.sql as unknown as LivePostgresSql), {
      appendEventTx: async () => 0,
    }, {
      emitFolderUpdated: async () => {},
      emitCardUpdated: async () => {},
    });
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("assigns unique numbers through concurrent card creation and preserves them through move and archive", async () => {
    const app = Fastify();
    registerFolderRoutes(app, {
      provider: { listFolders: () => [{ id: folderId }, { id: movedFolderId }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds: [folderId, movedFolderId] }) },
      resolveDashboardUserId: () => userId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    });

    try {
      const create = (title: string) => app.inject({ method: "POST", url: "/api/cards", payload: {
        folderId,
        title,
        request: "번호를 저장합니다",
        idempotencyKey: randomUUID(),
      } });
      const [firstResponse, secondResponse] = await Promise.all([create("첫 번째 카드"), create("두 번째 카드")]);
      expect(firstResponse.statusCode).toBe(201);
      expect(secondResponse.statusCode).toBe(201);

      const first = firstResponse.json().card as { id: string; number: number; version: number };
      const second = secondResponse.json().card as { id: string; number: number };
      expect(Number.isInteger(first.number) && first.number > 0).toBe(true);
      expect(Number.isInteger(second.number) && second.number > 0).toBe(true);
      expect(first.number).not.toBe(second.number);

      const movedResponse = await app.inject({ method: "POST", url: `/api/cards/${first.id}/move`, payload: {
        folderId: movedFolderId,
        expectedVersion: first.version,
        idempotencyKey: randomUUID(),
      } });
      expect(movedResponse.statusCode).toBe(200);
      const moved = movedResponse.json().card as { id: string; number: number; version: number };
      expect(moved.number).toBe(first.number);

      const archivedResponse = await app.inject({ method: "PATCH", url: `/api/cards/${first.id}`, payload: {
        archived: true,
        expectedVersion: moved.version,
        idempotencyKey: randomUUID(),
      } });
      expect(archivedResponse.statusCode).toBe(200);

      const thirdResponse = await app.inject({ method: "POST", url: "/api/cards", payload: {
        folderId: movedFolderId,
        title: "세 번째 카드",
        request: "보관된 번호 뒤에서 시작합니다",
        idempotencyKey: randomUUID(),
      } });
      expect(thirdResponse.statusCode).toBe(201);
      const third = thirdResponse.json().card as { id: string; number: number };
      expect(third.number).toBeGreaterThan(first.number);

      const detail = await app.inject(`/api/cards/${second.id}`);
      const list = await app.inject(`/api/cards?folderId=${folderId}`);
      const outline = await app.inject(`/api/folders/${movedFolderId}?view=outline&includeArchived=true`);
      expect(detail.json().card).toHaveProperty("number", second.number);
      expect(list.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: second.id, number: second.number }),
      ]));
      expect(outline.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.id, number: first.number }),
        expect.objectContaining({ id: third.id, number: third.number }),
      ]));
    } finally {
      await app.close();
    }
  }, 60_000);

  it("backfills by creation order, continues the identity, and rejects explicit numbers", async () => {
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/120_card_number.sql",
      import.meta.url,
    )), "utf8");

    try {
      await h.sql.unsafe("CREATE TEMP TABLE cards (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL)");
      await h.sql`INSERT INTO cards(id,created_at) VALUES
        ('late','2026-01-03T00:00:00Z'),('early','2026-01-01T00:00:00Z'),('middle','2026-01-02T00:00:00Z')`;
      await h.sql.unsafe(migration);

      const numbered = await h.sql<{ id: string; number: number }[]>`
        SELECT id,number FROM cards ORDER BY created_at,id COLLATE "C"`;
      expect(numbered).toEqual([
        { id: "early", number: 1 },
        { id: "middle", number: 2 },
        { id: "late", number: 3 },
      ]);

      await h.sql.unsafe(migration);
      const reapplied = await h.sql<{ id: string; number: number }[]>`
        SELECT id,number FROM cards ORDER BY created_at,id COLLATE "C"`;
      expect(reapplied).toEqual(numbered);

      const next = await h.sql<{ number: number }[]>`
        INSERT INTO cards(id,created_at) VALUES ('next','2026-01-04T00:00:00Z') RETURNING number`;
      expect(next[0]?.number).toBe(4);
      await expect(h.sql`INSERT INTO cards(id,created_at,number)
        VALUES ('manual','2026-01-05T00:00:00Z',99)`).rejects.toThrow();
    } finally {
      await h.sql.unsafe("DROP TABLE IF EXISTS pg_temp.cards");
    }
  }, 60_000);
});
