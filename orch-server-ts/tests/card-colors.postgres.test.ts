import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { CARD_COLOR_KEYS } from "@soulstream/wire-schema/card-colors";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { registerFolderRoutes } from "../src/folders/folder_routes.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("card post-it color storage over PostgreSQL and HTTP", () => {
  let h: FullSchemaPostgresHarness;
  let cards: CardControlPlaneService;
  const folderId = randomUUID();
  const userId = "postit-color-test@example.com";
  const cardUpdates: string[] = [];

  beforeAll(async () => {
    h = await createFullSchemaPostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES (${folderId},'Post-it colors')`;
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.sql as unknown as LivePostgresSql), {
      appendEventTx: async () => 0,
    }, {
      emitFolderUpdated: async () => {},
      emitCardUpdated: async cardId => { cardUpdates.push(cardId); },
    });
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("backfills existing rows and gives later rows a constrained database default", async () => {
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/118_card_color.sql",
      import.meta.url,
    )), "utf8");

    try {
      await h.sql.unsafe("CREATE TEMP TABLE cards (id TEXT PRIMARY KEY)");
      await h.sql`INSERT INTO cards(id) VALUES ('existing')`;
      await h.sql.unsafe(migration);

      const existing = await h.sql<{ color: string }[]>`SELECT color FROM cards WHERE id='existing'`;
      const created = await h.sql<{ color: string }[]>`INSERT INTO cards(id) VALUES ('new') RETURNING color`;
      expect(CARD_COLOR_KEYS).toContain(existing[0]?.color);
      expect(CARD_COLOR_KEYS).toContain(created[0]?.color);
      await expect(h.sql`INSERT INTO cards(id,color) VALUES ('invalid','chartreuse')`).rejects.toThrow();
      await expect(h.sql`INSERT INTO cards(id,color) VALUES ('null-color',NULL)`).rejects.toThrow();
    } finally {
      await h.sql.unsafe("DROP TABLE IF EXISTS pg_temp.cards");
    }
  }, 60_000);

  it("assigns a database color once and preserves it across PATCH, reads, status, and retries", async () => {
    const app = Fastify();
    registerFolderRoutes(app, {
      provider: { listFolders: () => [{ id: folderId }], listSessionAssignments: () => ({}) },
      accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds: [folderId] }) },
      resolveDashboardUserId: () => userId,
      cardServiceProvider: async () => cards,
      authBearerToken: "service-test",
      environment: "production",
    });

    try {
      const createKey = randomUUID();
      const createPayload = {
        folderId,
        title: "색상 보존 확인",
        request: "데이터베이스 기본 색상을 유지합니다",
        idempotencyKey: createKey,
      };
      const created = await app.inject({ method: "POST", url: "/api/cards", payload: createPayload });
      expect(created.statusCode).toBe(201);
      const firstCard = created.json().card as { id: string; color: string; version: number };
      expect(CARD_COLOR_KEYS).toContain(firstCard.color);

      const replay = await app.inject({ method: "POST", url: "/api/cards", payload: createPayload });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({ idempotent: true, card: { id: firstCard.id, color: firstCard.color } });

      const secondCreated = await app.inject({ method: "POST", url: "/api/cards", payload: {
        ...createPayload,
        title: "두 번째 카드",
        idempotencyKey: randomUUID(),
      } });
      expect(secondCreated.statusCode).toBe(201);
      const secondCard = secondCreated.json().card as { id: string; color: string };
      expect(CARD_COLOR_KEYS).toContain(secondCard.color);

      const beforePatchUpdates = cardUpdates.filter(id => id === firstCard.id).length;
      const patched = await app.inject({ method: "PATCH", url: `/api/cards/${firstCard.id}`, payload: {
        color: "lavender",
        expectedVersion: firstCard.version,
        idempotencyKey: randomUUID(),
      } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().card).toMatchObject({ color: "lavender", version: firstCard.version + 1 });
      expect(cardUpdates.filter(id => id === firstCard.id)).toHaveLength(beforePatchUpdates + 1);

      const invalidColor = await app.inject({ method: "PATCH", url: `/api/cards/${firstCard.id}`, payload: {
        color: "#fff7c6",
        expectedVersion: firstCard.version + 1,
        idempotencyKey: randomUUID(),
      } });
      const nullColor = await app.inject({ method: "PATCH", url: `/api/cards/${firstCard.id}`, payload: {
        color: null,
        expectedVersion: firstCard.version + 1,
        idempotencyKey: randomUUID(),
      } });
      expect(invalidColor.statusCode).toBe(422);
      expect(nullColor.statusCode).toBe(422);

      const completed = await app.inject({ method: "POST", url: `/api/cards/${firstCard.id}/status`, payload: {
        status: "done",
        expectedVersion: firstCard.version + 1,
        idempotencyKey: randomUUID(),
      } });
      expect(completed.statusCode).toBe(200);

      const detail = await app.inject(`/api/cards/${firstCard.id}`);
      const list = await app.inject(`/api/cards?folderId=${folderId}`);
      const outline = await app.inject(`/api/folders/${folderId}?view=outline`);
      const completedList = await app.inject("/api/cards?status=done");
      expect(detail.json().card.color).toBe("lavender");
      expect(list.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstCard.id, color: "lavender" }),
        expect.objectContaining({ id: secondCard.id, color: secondCard.color }),
      ]));
      expect(outline.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstCard.id, color: "lavender" }),
        expect.objectContaining({ id: secondCard.id, color: secondCard.color }),
      ]));
      expect(completedList.json().cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstCard.id, color: "lavender" }),
      ]));

      const stored = await h.sql<{ color: string; version: number }[]>`SELECT color,version FROM cards WHERE id=${firstCard.id}`;
      expect(stored[0]).toMatchObject({ color: "lavender", version: firstCard.version + 2 });
      const operations = await cards.listOperations(folderId);
      expect(operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ target_id: firstCard.id, operation_type: "update_card" }),
        expect.objectContaining({ target_id: firstCard.id, operation_type: "set_card_status" }),
      ]));
    } finally {
      await app.close();
    }
  }, 60_000);
});
