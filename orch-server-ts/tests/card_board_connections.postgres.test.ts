import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { readCardBoardSessions } from "../src/session/card_board_connections.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

// 고치기 전 relations CTE로 카드 하나를 읽는 질의. 결과가 같은지 견주는 오라클로만 쓴다.
function legacyBoardSessions(sql: PagePostgresHarness["sql"], cardId: string) {
  return sql<{ session_id: string; session_type: string | null; metadata: unknown }[]>`WITH actors AS (
    SELECT id AS card_id,created_session_id AS session_id FROM cards WHERE created_session_id IS NOT NULL
    UNION SELECT target_id,actor_session_id FROM folder_operations WHERE target_kind='card'
      AND operation_type IN ('create_card','execute_card','add_card_comment') AND actor_session_id IS NOT NULL
  ), links AS (
    SELECT card_id,session_id FROM actors
    UNION SELECT child.id,a.session_id FROM cards child JOIN cards parent
      ON parent.assignee_session_id=child.created_session_id AND parent.id<>child.id
      JOIN actors a ON a.card_id=parent.id
  )
  SELECT s.session_id,s.session_type,s.metadata FROM sessions s
  WHERE s.session_id IN (SELECT session_id FROM links WHERE card_id=${cardId})`;
}

const enabled = [{ type: "persistent_session", value: { enabled: true } }];
const disabled = [{ type: "persistent_session", value: { enabled: false } }];

describe("card board connections", () => {
  let h: PagePostgresHarness;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN metadata JSONB`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('board-folder','실험')`;
    await h.sql`
      INSERT INTO sessions(session_id,session_type,metadata) VALUES
        ('s-parent-assignee',NULL,${h.sql.json(enabled)}),
        ('s-actor',NULL,${h.sql.json(enabled)}),
        ('s-exec','claude',${h.sql.json(enabled)}),
        ('s-comment',NULL,${h.sql.json(enabled)}),
        ('s-ignored',NULL,${h.sql.json(enabled)}),
        ('s-parent-creator',NULL,${h.sql.json(enabled)}),
        ('s-parent-actor',NULL,${h.sql.json(enabled)}),
        ('s-llm','llm',${h.sql.json(enabled)}),
        ('s-disabled',NULL,${h.sql.json(disabled)}),
        ('s-other-creator',NULL,${h.sql.json(enabled)}),
        ('s-other-actor',NULL,${h.sql.json(enabled)})`;
    await h.sql`
      INSERT INTO cards(id,folder_id,position_key,title,status,created_session_id,assignee_session_id) VALUES
        ('c-target','board-folder','a','대상 카드','running','s-parent-assignee',NULL),
        ('c-parent','board-folder','b','부모 카드','running','s-parent-creator','s-parent-assignee'),
        ('c-other','board-folder','c','무관한 카드','running','s-other-creator',NULL)`;
    await h.sql`
      INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,actor_session_id) VALUES
        ('b1','board-folder','card','c-target','create_card','s-actor'),
        ('b2','board-folder','card','c-target','execute_card','s-exec'),
        ('b3','board-folder','card','c-target','add_card_comment','s-comment'),
        ('b4','board-folder','card','c-target','set_card_status','s-ignored'),
        ('b5','board-folder','card','c-target','create_card','s-llm'),
        ('b6','board-folder','card','c-target','add_card_comment','s-disabled'),
        ('b7','board-folder','card','c-parent','create_card','s-parent-actor'),
        ('b8','board-folder','card','c-other','create_card','s-other-actor')`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("returns the same persistent board sessions as the legacy relations query", async () => {
    const legacyRows = await legacyBoardSessions(h.sql, "c-target");
    const legacy = legacyRows
      .filter(row => row.session_type !== "llm" && readPersistentEnabled(row.metadata))
      .map(row => row.session_id).sort();
    expect(legacy).toEqual([
      "s-actor", "s-comment", "s-exec", "s-parent-actor", "s-parent-assignee", "s-parent-creator",
    ]);
    const rewritten = await readCardBoardSessions(createFolderContentSqlAdapter(h.liveSql), "c-target");
    expect([...rewritten].sort()).toEqual(legacy);
  });
});
