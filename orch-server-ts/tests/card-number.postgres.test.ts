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

describe("card number storage over PostgreSQL and HTTP", () => {
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

  function makeApp() {
    const app = Fastify();
    registerFolderRoutes(app, {
      provider: { listFolders: () => [{ id: folderId }, { id: movedFolderId }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds: [folderId, movedFolderId] }) },
      resolveDashboardUserId: () => userId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    });
    return app;
  }

  async function createCard(app: Fastify.FastifyInstance, title: string) {
    return app.inject({ method: "POST", url: "/api/cards", payload: {
      folderId,
      title,
      request: "번호 저장을 확인합니다",
      idempotencyKey: randomUUID(),
    } });
  }

  async function insertArchivedWithoutNumber(id: string) {
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,archived,number)
      VALUES (${id},${folderId},${id},'보관 카드','번호 없이 보관합니다',TRUE,NULL)`;
  }

  it("backfills only live cards in creation order and is unchanged when reapplied", async () => {
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/120_card_number.sql",
      import.meta.url,
    )), "utf8");

    try {
      await h.sql.unsafe("CREATE TEMP TABLE cards (id TEXT PRIMARY KEY, archived BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL)");
      await h.sql`INSERT INTO cards(id,archived,created_at) VALUES
        ('late',FALSE,'2026-01-03T00:00:00Z'),('early',FALSE,'2026-01-01T00:00:00Z'),
        ('middle',FALSE,'2026-01-02T00:00:00Z'),('archived',TRUE,'2025-12-01T00:00:00Z')`;
      await h.sql.unsafe(migration);

      const numbered = await h.sql<{ id: string; number: number | null }[]>`
        SELECT id,number FROM cards ORDER BY created_at,id COLLATE "C"`;
      expect(numbered).toEqual([
        { id: "archived", number: null },
        { id: "early", number: 1 },
        { id: "middle", number: 2 },
        { id: "late", number: 3 },
      ]);

      const next = await h.sql<{ number: number }[]>`
        INSERT INTO cards(id,archived,created_at) VALUES ('next',FALSE,'2026-01-04T00:00:00Z') RETURNING number`;
      expect(next[0]?.number).toBeGreaterThan(3);
      await h.sql.unsafe(migration);
      const reapplied = await h.sql<{ id: string; number: number | null }[]>`
        SELECT id,number FROM cards ORDER BY created_at,id COLLATE "C"`;
      expect(reapplied).toEqual([...numbered, { id: "next", number: next[0]!.number }]);
    } finally {
      await h.sql.unsafe("DROP TABLE IF EXISTS pg_temp.cards");
    }
  }, 60_000);

  it("rejects restoring a card while its number is null", async () => {
    try {
      await h.sql.unsafe("CREATE TEMP TABLE cards (id TEXT PRIMARY KEY, archived BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL)");
      await h.sql`INSERT INTO cards(id,archived,created_at) VALUES ('archived',TRUE,'2026-01-01T00:00:00Z')`;
      const migration = readFileSync(fileURLToPath(new URL(
        "../../packages/db-schema/sql/migrations/120_card_number.sql",
        import.meta.url,
      )), "utf8");
      await h.sql.unsafe(migration);
      await expect(h.sql`UPDATE cards SET archived=FALSE WHERE id='archived'`).rejects.toThrow();
      await h.sql`UPDATE cards SET number=nextval('cards_number_seq'),archived=FALSE WHERE id='archived'`;
      const restored = await h.sql<{ number: number; archived: boolean }[]>`SELECT number,archived FROM cards`;
      expect(restored[0]?.number).toBeGreaterThan(0);
      expect(restored[0]?.archived).toBe(false);
    } finally {
      await h.sql.unsafe("DROP TABLE IF EXISTS pg_temp.cards");
    }
  }, 60_000);

  it("assigns distinct numbers through concurrent creation and preserves them through move and archive", async () => {
    const app = makeApp();
    try {
      const [firstResponse, secondResponse] = await Promise.all([
        createCard(app, "첫 번째 카드"), createCard(app, "두 번째 카드"),
      ]);
      expect(firstResponse.statusCode).toBe(201);
      expect(secondResponse.statusCode).toBe(201);
      const first = firstResponse.json().card as { id: string; number: number; version: number };
      const second = secondResponse.json().card as { id: string; number: number };
      expect(Number.isInteger(first.number) && first.number > 0).toBe(true);
      expect(Number.isInteger(second.number) && second.number > 0).toBe(true);
      expect(first.number).not.toBe(second.number);

      const movedResponse = await app.inject({ method: "POST", url: `/api/cards/${first.id}/move`, payload: {
        folderId: movedFolderId, expectedVersion: first.version, idempotencyKey: randomUUID(),
      } });
      expect(movedResponse.statusCode).toBe(200);
      const moved = movedResponse.json().card as { id: string; number: number; version: number };
      expect(moved.number).toBe(first.number);

      const archivedResponse = await app.inject({ method: "PATCH", url: `/api/cards/${first.id}`, payload: {
        archived: true, expectedVersion: moved.version, idempotencyKey: randomUUID(),
      } });
      expect(archivedResponse.statusCode).toBe(200);
      expect(archivedResponse.json().card.number).toBe(first.number);

      const thirdResponse = await createCard(app, "세 번째 카드");
      expect(thirdResponse.statusCode).toBe(201);
      expect(thirdResponse.json().card.number).toBeGreaterThan(first.number);

      const detail = await app.inject(`/api/cards/${second.id}`);
      const list = await app.inject(`/api/cards?folderId=${folderId}`);
      const outline = await app.inject(`/api/folders/${movedFolderId}?view=outline&includeArchived=true`);
      expect(detail.json().card).toHaveProperty("number", second.number);
      expect(list.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: second.id, number: second.number }),
      ]));
      expect(outline.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.id, number: first.number }),
      ]));
    } finally {
      await app.close();
    }
  }, 60_000);

  it("shows null on REST and outline for a numberless archived card, then numbers it on restore", async () => {
    const app = makeApp();
    const id = randomUUID();
    try {
      await insertArchivedWithoutNumber(id);
      const detail = await app.inject(`/api/cards/${id}`);
      const outline = await app.inject(`/api/folders/${folderId}?view=outline&includeArchived=true`);
      expect(detail.json().card).toHaveProperty("number", null);
      expect(outline.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id, number: null }),
      ]));
      const maximum = await h.sql<{ number: number | null }[]>`SELECT MAX(number) AS number FROM cards`;
      const restored = await app.inject({ method: "PATCH", url: `/api/cards/${id}`, payload: {
        archived: false, expectedVersion: 1, idempotencyKey: randomUUID(),
      } });
      expect(restored.statusCode).toBe(200);
      expect(Number.isInteger(restored.json().card.number)).toBe(true);
      expect(restored.json().card.number).toBeGreaterThan(maximum[0]?.number ?? 0);

      const archived = await app.inject({ method: "PATCH", url: `/api/cards/${id}`, payload: {
        archived: true, expectedVersion: 2, idempotencyKey: randomUUID(),
      } });
      expect(archived.statusCode).toBe(200);
      const restoredAgain = await app.inject({ method: "PATCH", url: `/api/cards/${id}`, payload: {
        archived: false, expectedVersion: 3, idempotencyKey: randomUUID(),
      } });
      expect(restoredAgain.statusCode).toBe(200);
      expect(restoredAgain.json().card.number).toBe(restored.json().card.number);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("keeps an existing number when a numbered card is archived and restored", async () => {
    const app = makeApp();
    try {
      const created = await createCard(app, "번호가 있는 카드");
      const card = created.json().card as { id: string; number: number; version: number };
      const archived = await app.inject({ method: "PATCH", url: `/api/cards/${card.id}`, payload: {
        archived: true, expectedVersion: card.version, idempotencyKey: randomUUID(),
      } });
      const restored = await app.inject({ method: "PATCH", url: `/api/cards/${card.id}`, payload: {
        archived: false, expectedVersion: card.version + 1, idempotencyKey: randomUUID(),
      } });
      expect(archived.statusCode).toBe(200);
      expect(restored.statusCode).toBe(200);
      expect(restored.json().card.number).toBe(card.number);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("assigns distinct numbers when two numberless archived cards are restored concurrently", async () => {
    const app = makeApp();
    const firstId = randomUUID();
    const secondId = randomUUID();
    try {
      await insertArchivedWithoutNumber(firstId);
      await insertArchivedWithoutNumber(secondId);
      const maximum = await h.sql<{ number: number | null }[]>`SELECT MAX(number) AS number FROM cards`;
      const [first, second] = await Promise.all([firstId, secondId].map(id => app.inject({
        method: "PATCH", url: `/api/cards/${id}`, payload: {
          archived: false, expectedVersion: 1, idempotencyKey: randomUUID(),
        },
      })));
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstNumber = first.json().card.number as number;
      const secondNumber = second.json().card.number as number;
      expect(Number.isInteger(firstNumber) && firstNumber > (maximum[0]?.number ?? 0)).toBe(true);
      expect(Number.isInteger(secondNumber) && secondNumber > (maximum[0]?.number ?? 0)).toBe(true);
      expect(firstNumber).not.toBe(secondNumber);
    } finally {
      await app.close();
    }
  }, 60_000);
});
