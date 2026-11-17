import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { cardCapacitySessions } from "../src/cards/card_capacity.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

// 고치기 전 cardCapacitySessions 질의. 결과가 같은지 견주는 오라클로만 쓴다.
function legacyCapacity(sql: PagePostgresHarness["sql"]) {
  return sql<{ session_id: string; node_id: string }[]>`SELECT DISTINCT session_id,node_id FROM (
    SELECT op.payload_json->>'session_id' AS session_id,op.payload_json->>'node_id' AS node_id
    FROM folder_operations op JOIN cards c ON c.id=op.target_id
    LEFT JOIN sessions s ON s.session_id=op.payload_json->>'session_id'
    WHERE op.operation_type='dispatch_card' AND (s.status NOT IN ('completed','error','interrupted')
      OR s.session_id IS NULL AND c.status='running' AND op.id=(SELECT latest.id FROM folder_operations latest
        WHERE latest.target_id=c.id AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id AND r.operation_type='resume_card'
        AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
    UNION SELECT d.session_id,d.node_id FROM card_orchestration_dispatches d LEFT JOIN sessions s ON s.session_id=d.session_id
      WHERE d.state IN ('admitted','launching') OR d.state='running' AND s.status NOT IN ('completed','error','interrupted')
  ) occupied WHERE session_id IS NOT NULL AND node_id IS NOT NULL`;
}

const pairs = (rows: readonly { session_id: string; node_id: string }[]) =>
  rows.map(row => `${row.session_id}@${row.node_id}`).sort();

describe("card capacity sessions", () => {
  let h: PagePostgresHarness;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`CREATE TABLE card_orchestration_dispatches(
      id TEXT PRIMARY KEY,session_id TEXT,node_id TEXT,state TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('capacity-folder','실험')`;
    const t0 = "2026-11-17T00:00:00Z";
    const t1 = "2026-11-17T00:01:00Z";
    await h.sql`
      INSERT INTO cards(id,folder_id,position_key,title,status) VALUES
        ('cap-card','capacity-folder','a','활성 배차','running'),
        ('cap-resume','capacity-folder','b','재개','running'),
        ('cap-review','capacity-folder','c','검수','review'),
        ('cap-elsewhere','capacity-folder','d','다른 카드','todo'),
        ('cap-orch','capacity-folder','e','오케스트레이션','running'),
        ('cap-null','capacity-folder','f','세션 없음','running')`;
    await h.sql`
      INSERT INTO sessions(session_id,card_id,status,updated_at) VALUES
        ('cap-active','cap-card','running',${t0}),
        ('cap-done','cap-resume','completed',${t0}),
        ('cap-init','cap-review','initializing',${t0}),
        ('cap-foreign','cap-elsewhere','running',${t0}),
        ('cap-run-terminal','cap-orch','completed',${t0})`;
    await h.sql`
      INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,payload_json,created_at) VALUES
        ('c1','capacity-folder','card','cap-card','dispatch_card','{"node_id":"n1","session_id":"cap-active"}',${t0}),
        ('c2','capacity-folder','card','cap-resume','dispatch_card','{"node_id":"n2","session_id":"cap-done"}',${t0}),
        ('c2r','capacity-folder','card','cap-resume','resume_card','{"session_id":"cap-done"}',${t1}),
        ('c3','capacity-folder','card','cap-review','dispatch_card','{"node_id":"n3","session_id":"cap-init"}',${t0}),
        ('c4','capacity-folder','card','cap-elsewhere','dispatch_card','{"node_id":"n4","session_id":"cap-foreign"}',${t0}),
        ('c5','capacity-folder','card','cap-null','dispatch_card','{"node_id":"n5","session_id":"missing"}',${t0}),
        ('c6','capacity-folder','card','cap-orch','dispatch_card','{"node_id":"n1","session_id":"cap-done"}',${t0})`;
    await h.sql`
      INSERT INTO card_orchestration_dispatches(id,session_id,node_id,state) VALUES
        ('o1','cap-admitted','n6','admitted'),
        ('o2','cap-active','n7','running'),
        ('o3','cap-run-terminal','n8','running')`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("returns the same session/node pairs as the legacy query", async () => {
    const legacy = pairs(await legacyCapacity(h.sql));
    expect(legacy).toEqual([
      "cap-active@n1", "cap-active@n7", "cap-admitted@n6", "cap-done@n2", "cap-foreign@n4", "cap-init@n3",
      "missing@n5",
    ]);
    const rewritten = pairs(await cardCapacitySessions(createFolderContentSqlAdapter(h.liveSql)));
    expect(rewritten).toEqual(legacy);
  });
});
