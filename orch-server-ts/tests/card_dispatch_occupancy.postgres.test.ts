import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

// 고치기 전 occupancy 질의. 결과가 같은지 견주는 오라클로만 쓴다.
function legacyOccupancy(sql: PagePostgresHarness["sql"]) {
  return sql<{ node_id: string; count: number }[]>`SELECT op.payload_json->>'node_id' AS node_id,count(*)::int AS count
    FROM folder_operations op JOIN cards c ON c.id=op.target_id
    LEFT JOIN sessions s ON s.session_id=op.payload_json->>'session_id' AND s.card_id=c.id
    WHERE op.operation_type='dispatch_card' AND (
      s.status NOT IN ('completed','error','interrupted') OR s.session_id IS NULL AND c.status='running'
        AND op.id=(SELECT latest.id FROM folder_operations latest WHERE latest.target_id=c.id
          AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id
        AND r.operation_type='resume_card' AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
    GROUP BY op.payload_json->>'node_id'`;
}

describe("card dispatch occupancy", () => {
  let h: PagePostgresHarness;
  let repo: CardDispatchRepository;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('occupancy-folder','실험')`;
    repo = new CardDispatchRepository(async () => createFolderContentSqlAdapter(h.liveSql));
    const t0 = "2026-11-17T00:00:00Z";
    const t1 = "2026-11-17T00:01:00Z";
    await h.sql`
      INSERT INTO cards(id,folder_id,position_key,title,status) VALUES
        ('c-active-dispatch','occupancy-folder','a','실행 중 배차','running'),
        ('c-active-resume','occupancy-folder','b','재개 후 실행 중','running'),
        ('c-done-terminal','occupancy-folder','c','종료 세션 배차','done'),
        ('c-running-null','occupancy-folder','d','세션 없는 실행 중','running'),
        ('c-done-null','occupancy-folder','e','세션 없는 종료','done'),
        ('c-review-initializing','occupancy-folder','f','초기화 세션의 검수 카드','review'),
        ('c-done-unknown','occupancy-folder','g','알 수 없는 세션의 종료 카드','done'),
        ('c-queued-session','occupancy-folder','h','실행 중 세션이 붙은 대기 카드','queued'),
        ('c-running-foreign','occupancy-folder','i','다른 카드 세션을 가리키는 실행 중 카드','running'),
        ('c-active-no-op','occupancy-folder','j','배차 기록 없는 실행 중 카드','running'),
        ('c-elsewhere','occupancy-folder','k','다른 카드','todo')`;
    await h.sql`
      INSERT INTO sessions(session_id,card_id,status,updated_at) VALUES
        ('s-active','c-active-dispatch','running',${t0}),
        ('s-done','c-active-resume','completed',${t0}),
        ('s-init','c-review-initializing','initializing',${t0}),
        ('s-unknown','c-done-unknown','unknown',${t0}),
        ('s-queued','c-queued-session','running',${t0}),
        ('s-foreign','c-elsewhere','running',${t0})`;
    await h.sql`
      INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,payload_json,created_at) VALUES
        ('d1','occupancy-folder','card','c-active-dispatch','dispatch_card','{"node_id":"node-a","session_id":"s-active"}',${t0}),
        ('d2','occupancy-folder','card','c-active-resume','dispatch_card','{"node_id":"node-b","session_id":"s-done"}',${t0}),
        ('r2','occupancy-folder','card','c-active-resume','resume_card','{"session_id":"s-done"}',${t1}),
        ('d3','occupancy-folder','card','c-done-terminal','dispatch_card','{"node_id":"node-c","session_id":"s-done"}',${t0}),
        ('d4','occupancy-folder','card','c-running-null','dispatch_card','{"node_id":"node-d","session_id":"missing"}',${t0}),
        ('d5','occupancy-folder','card','c-done-null','dispatch_card','{"node_id":"node-e","session_id":"missing"}',${t0}),
        ('d6','occupancy-folder','card','c-review-initializing','dispatch_card','{"node_id":"node-f","session_id":"s-init"}',${t0}),
        ('d7','occupancy-folder','card','c-done-unknown','dispatch_card','{"node_id":"node-g","session_id":"s-unknown"}',${t0}),
        ('d8','occupancy-folder','card','c-queued-session','dispatch_card','{"node_id":"node-h","session_id":"s-queued"}',${t0}),
        ('d9','occupancy-folder','card','c-running-foreign','dispatch_card','{"node_id":"node-i","session_id":"s-foreign"}',${t0})`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("returns the same node counts as the legacy query", async () => {
    const legacy = Object.fromEntries((await legacyOccupancy(h.sql)).map(row => [row.node_id, row.count]));
    expect(legacy).toEqual({
      "node-a": 1, "node-b": 1, "node-d": 1, "node-f": 1, "node-g": 1, "node-h": 1, "node-i": 1,
    });
    expect(await repo.occupancy()).toEqual(legacy);
  });
});
