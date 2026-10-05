import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionReadRepository } from "../src/control_plane/repositories/session_read_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

// Real PostgreSQL: the child's number is the session's place among everything attached to its card, not among the children.
describe("active child sessions carry their card reference", () => {
  let h: FullSchemaPostgresHarness;
  let repository: SessionReadRepository;
  let numbered: { id: string; number: number };

  beforeAll(async () => {
    h = await createFullSchemaPostgresHarness();
    // The runtime hands this repository the board-yjs adapter, cast to the driver's type.
    repository = new SessionReadRepository(createBoardYjsSqlAdapter(h.sql as unknown as LivePostgresSql) as unknown as SqlClient);
    await h.sql`INSERT INTO folders(id,name) VALUES ('folder-a','A')`;
    numbered = (await h.sql<{ id: string; number: number }[]>`
      INSERT INTO cards(id,folder_id,position_key,title) VALUES ('card-numbered','folder-a','a','번호 있는 카드') RETURNING id,number`)[0]!;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,archived,number)
      VALUES ('card-numberless','folder-a','b','번호 없는 보관 카드',TRUE,NULL)`;
    await h.sql`INSERT INTO sessions(session_id,status,caller_session_id,card_id,display_name,created_at) VALUES
      ('earlier-on-card','completed',NULL,'card-numbered','먼저 붙은 세션','2026-01-01T00:00:00Z'),
      ('child-on-card','running','owner','card-numbered','내가 부른 세션','2026-01-02T00:00:00Z'),
      ('child-initializing','initializing','owner','card-numbered','시작 중인 세션','2026-01-03T00:00:00Z'),
      ('child-numberless','running','owner','card-numberless','번호 없는 카드의 세션','2026-01-04T00:00:00Z'),
      ('child-cardless','running','owner',NULL,'카드 없는 세션','2026-01-05T00:00:00Z'),
      ('finished-child','completed','owner','card-numbered','끝난 세션','2026-01-06T00:00:00Z'),
      ('other-owners-child','running','someone-else','card-numbered','남의 세션','2026-01-07T00:00:00Z')`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("gives #N.sK to children on a numbered card, and null to children on a numberless card or on no card", async () => {
    const { sessions, total } = await repository.listActiveChildSessionsSummary("owner");

    expect(total).toBe(4);
    expect(Object.fromEntries(sessions.map((session) => [session.session_id, session.reference]))).toEqual({
      "child-on-card": `#${numbered.number}.s2`,
      "child-initializing": `#${numbered.number}.s3`,
      "child-numberless": null,
      "child-cardless": null,
    });
    expect(sessions.find((session) => session.session_id === "child-numberless")?.card_id).toBe("card-numberless");
  });

  it("returns an empty list without asking for references when the caller has no active children", async () => {
    await expect(repository.listActiveChildSessionsSummary("nobody")).resolves.toEqual({ sessions: [], total: 0 });
  });
});
