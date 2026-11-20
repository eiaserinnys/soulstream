import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SessionDeletionRepository } from "../src/session/session_deletion_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

let h: PagePostgresHarness;
let repository: SessionDeletionRepository;

beforeAll(async () => {
  h = await createPagePostgresHarness();
  const schema = await readFile(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
  const sessionDelete = schema.match(/CREATE OR REPLACE FUNCTION session_delete\([\s\S]*?\n\$\$;/)?.[0];
  if (!sessionDelete) throw new Error("session_delete is missing from schema.sql");
  await h.sql.unsafe(sessionDelete);
  await h.sql`INSERT INTO folders(id, name) VALUES ('folder', '세션 삭제 시험')`;
  repository = new SessionDeletionRepository({ resolveSql: async () => h.liveSql, close: async () => {} });
}, 120_000);

afterAll(async () => { await h?.cleanup(); });

it("clears a limit reservation and records the change when deleting its assigned session", async () => {
  const sql = h.sql;
  await sql`INSERT INTO sessions(session_id, status) VALUES ('reserved-owner', 'interrupted')`;
  await sql`
    INSERT INTO cards(id, folder_id, position_key, title, assignee_kind, assignee_session_id,
      status, blocked_kind, limit_resume_session_id, limit_resume_at, version)
    VALUES ('reserved-card', 'folder', 'a', '예약 카드', 'session', 'reserved-owner',
      'blocked', 'limit', 'reserved-owner', '2030-01-01T00:00:00Z', 4)
  `;

  await repository.deleteSession({ sessionId: "reserved-owner" });

  expect(await sql`SELECT session_id FROM sessions WHERE session_id='reserved-owner'`).toHaveLength(0);
  const [card] = await sql`SELECT * FROM cards WHERE id='reserved-card'`;
  expect(card).toMatchObject({
    assignee_session_id: null, limit_resume_session_id: null, limit_resume_at: null,
    status: "blocked", blocked_kind: "limit", version: 5,
    now: { text: "담당이 바뀌어 자동 재개 예약을 해제했습니다", turn: "agent", ask: null, sessionId: null },
  });
  expect(card!.now.updatedAt).toEqual(expect.any(String));
  const operations = await sql`SELECT * FROM folder_operations WHERE target_id='reserved-card'`;
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    folder_id: "folder", target_kind: "card", operation_type: "update_card", actor_kind: "system",
    payload_json: {
      limit_resume_session_id: null, limit_resume_at: null, deleted_session_id: "reserved-owner",
      now: { text: "담당이 바뀌어 자동 재개 예약을 해제했습니다", turn: "agent" },
    },
  });
});

it("deletes a session without changing the now or version of its unreserved card", async () => {
  const sql = h.sql;
  const now = { text: "기존 상황", turn: "agent", ask: null, updatedAt: "2026-01-01T00:00:00.000Z", sessionId: null };
  await sql`INSERT INTO sessions(session_id, status) VALUES ('unreserved-owner', 'interrupted')`;
  await sql`
    INSERT INTO cards(id, folder_id, position_key, title, assignee_kind, assignee_session_id, now, version)
    VALUES ('unreserved-card', 'folder', 'b', '예약 없는 카드', 'session', 'unreserved-owner', ${sql.json(now)}, 7)
  `;

  await repository.deleteSession({ sessionId: "unreserved-owner" });

  expect(await sql`SELECT session_id FROM sessions WHERE session_id='unreserved-owner'`).toHaveLength(0);
  const [card] = await sql`SELECT * FROM cards WHERE id='unreserved-card'`;
  expect(card).toMatchObject({ assignee_session_id: null, now, version: 7 });
  expect(await sql`SELECT * FROM folder_operations WHERE target_id='unreserved-card'`).toHaveLength(0);
});
