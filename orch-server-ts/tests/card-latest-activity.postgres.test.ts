import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { projectCardActivity } from "../src/cards/card_latest_activity.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";

// Reuse the existing disposable PostgreSQL harness; never read DATABASE_URL.
let h: PagePostgresHarness;
beforeAll(async () => {
  h = await createPagePostgresHarness();
  await h.sql`INSERT INTO folders(id,name) VALUES ('activity-a','A'),('activity-b','B')`;
  await h.sql`INSERT INTO cards(id,folder_id,title,request,position_key,status,created_at,updated_at) VALUES
    ('a','activity-a','A','최초 원문','a','running','2026-09-01','2026-10-01'),
    ('b','activity-a','B','','b','review','2026-09-01','2026-10-01'),
    ('c','activity-a','C','','c','queued','2026-09-01','2026-10-01'),
    ('secret','activity-b','비공개','','a','running','2026-09-01','2026-10-01')`;
  await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,created_at) VALUES
    ('r1','a','보고 제목','html','<p>보고 원문</p>','2026-09-02'),
    ('r2','b','동시각 보고','markdown','보고 원문 B','2026-09-03'),
    ('r9','secret','비공개','markdown','혼입 금지','2026-09-10')`;
  await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES
    ('c1','a','user','comment','  다음 지시\n원문  ','2026-09-04'),
    ('c2','a','agent','spoken','자동 코멘트 제외','2026-09-10'),
    ('c3','a','user','comment','  \n  ','2026-09-11'),
    ('c4','b','user','spoken','구두 지시','2026-09-03')`;
}, 60_000);
afterAll(async () => { await h?.cleanup(); });

it("projects the newest nonempty user instruction/report for the exact batch with deterministic ties", async () => {
  const cards = await h.sql`SELECT * FROM cards WHERE folder_id='activity-a' ORDER BY id`;
  const result = await projectCardActivity(h.liveSql, cards);
  expect(result.map(c => c.latest_activity)).toEqual([
    { kind: "instruction", format: "markdown", body: "  다음 지시\n원문  ", createdAt: "2026-09-04T00:00:00.000Z" },
    { kind: "report", format: "markdown", body: "보고 원문 B", createdAt: "2026-09-03T00:00:00.000Z" },
    null,
  ]);
  await h.sql`DELETE FROM card_comments WHERE card_id='a' AND author_kind='user'`;
  expect((await projectCardActivity(h.liveSql, cards))[0]!.latest_activity).toMatchObject({ kind: "report", format: "html", body: "<p>보고 원문</p>" });
  await h.sql`DELETE FROM card_reports WHERE card_id='a'`;
  expect((await projectCardActivity(h.liveSql, cards))[0]!.latest_activity).toMatchObject({ kind: "instruction", body: "최초 원문", createdAt: "2026-09-01T00:00:00.000Z" });
});

it("uses one projection query for multiple cards and none for an empty authorized result", async () => {
  const cards = await h.sql`SELECT * FROM cards WHERE folder_id='activity-a'`;
  let count = 0;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    count++; return h.liveSql(strings, ...values);
  }, { json: h.liveSql.json }) as typeof h.liveSql;
  await projectCardActivity(sql, cards);
  expect(count).toBe(1);
  expect(await projectCardActivity(sql, [])).toEqual([]);
  expect(count).toBe(1);
});

it("keeps authorized list results and detail/store refresh contracts additive", async () => {
  const service = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), { appendEventTx: async () => 1 });
  const app = Fastify();
  registerCardRoutes(app, {
    provider: { listFolders: () => [{ id: 'activity-a' }, { id: 'activity-b' }], listSessionAssignments: () => ({}) },
    accessProvider: { resolveAccess: () => ({ restricted: true, allowedFolderIds: ['activity-a'] }) },
    resolveDashboardUserId: () => 'fixture', cardServiceProvider: async () => service,
  });
  try {
    const result = (await app.inject('/api/cards')).json();
    expect(result.cards.map((c: {id:string}) => c.id)).toEqual(['a','b','c']);
    expect(result.cards[0]).toMatchObject({ request: '최초 원문', latestActivity: {body:'최초 원문'} });
    expect((await app.inject('/api/cards/secret')).statusCode).toBe(403);
    expect((await app.inject('/api/cards/a')).json().card.latestActivity).toEqual(result.cards[0].latestActivity);
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,created_at) VALUES ('later','a','새 보고','markdown','새 원문','2026-09-15')`;
    expect((await app.inject('/api/cards/a')).json().card.latestActivity.body).toBe('새 원문');
    const snapshot = await service.getFolder('activity-a');
    expect(snapshot!.cards.find(c=>c.id==='a')!.latest_activity).toMatchObject({body:'새 원문'});
    const planner = new PlannerRepository({resolveSql:async()=>h.liveSql,close:async()=>{}});
    await h.sql`INSERT INTO pages(id,title,daily_date,version) VALUES ('activity-day','데일리','2026-10-01',1)`;
    expect((await planner.getToday('2026-10-01'))!.running.find(c=>c.id==='a')!.latestActivity).toMatchObject({body:'새 원문'});
  } finally { await app.close(); }
});
