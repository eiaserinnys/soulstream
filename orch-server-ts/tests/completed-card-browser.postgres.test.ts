import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";
import type { LiveDbSqlResolver } from "../src/runtime/live_db_sql.js";

// The existing harness creates an empty disposable test database, never DATABASE_URL.
let h: PagePostgresHarness;
let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  h = await createPagePostgresHarness();
  await h.sql`INSERT INTO folders(id,name) VALUES ('public','공개'),('private','비공개')`;
  await h.sql`INSERT INTO pages(id,title,version) VALUES ('public-page','공개',1)`;
  await h.sql`UPDATE folders SET project_page_id='public-page' WHERE id='public'`;
  await h.sql`INSERT INTO cards(id,folder_id,title,request,position_key,status,completed_at)
    SELECT lpad(i::text,4,'0'), CASE WHEN i % 2 = 0 THEN 'public' ELSE 'private' END,
      '완료 ' || i, CASE WHEN i % 10 = 0 THEN 'Needle 요청' ELSE '일반 요청' END,
      i::text,'done','2026-10-02 00:00:00.123456+00'::timestamptz - (i / 4) * interval '1 hour'
    FROM generate_series(1,1000) AS i`;
  await h.sql`INSERT INTO cards(id,folder_id,title,request,position_key,status)
    VALUES ('active','public','활성 카드','','a','running')`;
  const service = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: async () => 1 });
  app = Fastify();
  registerCardRoutes(app, {
    nodeCredentials: null,
    provider: { listFolders: () => [{id:'public'},{id:'private'}], listSessionAssignments: () => ({}) },
    accessProvider: { resolveAccess: () => ({restricted:true,allowedFolderIds:['public']}) },
    resolveDashboardUserId: () => 'fixture', cardServiceProvider: async () => service,
  });
}, 60_000);
afterAll(async () => { await app?.close(); await h?.cleanup(); });

it('excludes done in SQL for active inventory and preserves the legacy default', async () => {
  expect((await app.inject('/api/cards?includeCompleted=false')).json().cards.map((c:{id:string})=>c.id)).toEqual(['active']);
  expect((await app.inject('/api/cards')).json().cards).toHaveLength(501);
});
it('pages authorized completed cards without duplicate/missing microsecond ties', async () => {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query:URLSearchParams = new URLSearchParams({status:'done',limit:'60',...(cursor ? {cursor}: {})});
    const response = await app.inject(`/api/cards?${query}`);
    expect(response.statusCode).toBe(200);
    const page:{cards:{id:string;folderId:string;completedAt:string}[];nextCursor:string|null} = response.json();
    expect(page.cards.length).toBeLessThanOrEqual(60);
    expect(page.cards.every((c:{folderId:string;completedAt:string})=>c.folderId==='public' && Boolean(c.completedAt))).toBe(true);
    ids.push(...page.cards.map((c:{id:string})=>c.id));
    cursor = page.nextCursor;
    expect(cursor === null || typeof cursor === 'string').toBe(true);
  } while (cursor);
  const expected = await h.sql`SELECT id FROM cards WHERE status='done' AND folder_id='public' ORDER BY completed_at DESC,id COLLATE "C" DESC`;
  expect(ids).toEqual(expected.map(c=>c.id));
  expect(new Set(ids).size).toBe(500);
});
it('combines an exclusive period, literal case-insensitive title/request search and folder permission', async () => {
  const q = new URLSearchParams({status:'done',folderId:'public',completedFrom:'2026-09-28T00:00:00Z',completedBefore:'2026-10-01T00:00:00Z',q:'needle'});
  const page = (await app.inject(`/api/cards?${q}`)).json();
  expect(page.cards.length).toBeGreaterThan(0);
  expect(page.cards.every((c:{request:string;completedAt:string})=>c.request.includes('Needle') && c.completedAt >= '2026-09-28' && c.completedAt < '2026-10-01')).toBe(true);
  expect((await app.inject('/api/cards?status=done&folderId=private')).json().cards).toEqual([]);
  expect((await app.inject('/api/cards?status=done&q=%25')).json().cards).toEqual([]);
});
it('rejects malformed page boundaries', async () => {
  for (const query of ['limit=101','cursor=broken','completedFrom=yesterday']) {
    expect((await app.inject(`/api/cards?status=done&${query}`)).statusCode).toBe(400);
  }
});
it('aggregate/snapshot excludes completed before activity projection and retains default compatibility', async () => {
  const repo=new PlannerRepository({resolveSql:async()=>h.liveSql} as LiveDbSqlResolver);
  repo.getSubfolders=async()=>({items:[],nextCursor:null});
  repo.getSessions=async()=>({items:[],nextCursor:null});
  for(const includeCompleted of [undefined,true,false]) {
    const aggregate=await repo.getFolder('public',{limit:20,includeCompleted});
    expect(aggregate?.cards).toHaveLength(includeCompleted===false?1:501);
  }
  const service=new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql),{appendEventTx:async()=>1});
  expect((await service.getFolder('public',false))?.cards.map(card=>card.id)).toEqual(['active']);
});
type PagedCardFixture = {
  id: string; status: string; updatedAt: string; title: string; request?: string; number?: number | null;
};
async function seedPagedCards(rows: readonly PagedCardFixture[]) {
  await h.sql`DELETE FROM cards WHERE id LIKE 'paged-%'`;
  for (const row of rows)
    await h.sql`INSERT INTO cards(id,folder_id,title,request,position_key,status,updated_at,number)
      VALUES (${row.id},'public',${row.title},${row.request ?? row.title},${row.id},${row.status},
        ${row.updatedAt}::timestamptz,${row.number ?? null})`;
}

it('pages active cards in status-group order and excludes closed cards when includeClosed=false', async () => {
  await seedPagedCards([
    {id:'paged-excl-todo', status:'todo', updatedAt:'2026-11-01 00:00:00+00', title:'pagedexcl todo'},
    {id:'paged-excl-run', status:'running', updatedAt:'2026-11-02 00:00:00+00', title:'pagedexcl running'},
    {id:'paged-excl-done', status:'done', updatedAt:'2026-11-03 00:00:00+00', title:'pagedexcl done'},
    {id:'paged-excl-cancel', status:'cancelled', updatedAt:'2026-11-04 00:00:00+00', title:'pagedexcl cancel'},
  ]);
  const page = (await app.inject('/api/cards?limit=50&includeClosed=false&q=pagedexcl')).json();
  expect(page.cards.map((c:{id:string})=>c.id)).toEqual(['paged-excl-todo','paged-excl-run']);
  expect(page.nextCursor).toBeNull();
});

it('traverses every card without duplicates or gaps in status-group and update order', async () => {
  await seedPagedCards([
    {id:'paged-page-todo-a', status:'todo', updatedAt:'2026-11-02 00:00:01+00', title:'pagedpage todo a'},
    {id:'paged-page-todo-b', status:'todo', updatedAt:'2026-11-02 00:00:02+00', title:'pagedpage todo b'},
    {id:'paged-page-queued', status:'queued', updatedAt:'2026-11-02 00:00:03+00', title:'pagedpage queued'},
    {id:'paged-page-blocked', status:'blocked', updatedAt:'2026-11-02 00:00:04+00', title:'pagedpage blocked'},
    {id:'paged-page-run-a', status:'running', updatedAt:'2026-11-02 00:00:05+00', title:'pagedpage run a'},
    {id:'paged-page-run-b', status:'running', updatedAt:'2026-11-02 00:00:05+00', title:'pagedpage run b'},
    {id:'paged-page-review', status:'review', updatedAt:'2026-11-02 00:00:06+00', title:'pagedpage review'},
    {id:'paged-page-hold', status:'on_hold', updatedAt:'2026-11-02 00:00:07+00', title:'pagedpage hold'},
    {id:'paged-page-done-a', status:'done', updatedAt:'2026-11-02 00:00:08+00', title:'pagedpage done a'},
    {id:'paged-page-done-b', status:'done', updatedAt:'2026-11-02 00:00:09+00', title:'pagedpage done b'},
    {id:'paged-page-cancel', status:'cancelled', updatedAt:'2026-11-02 00:00:10+00', title:'pagedpage cancel'},
  ]);
  const ids: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  do {
    // limit 4 puts the first page boundary between the two same-updated_at running cards,
    // so a cursor that forgets the id tie-break drops one of them instead of passing silently.
    const query: URLSearchParams = new URLSearchParams({limit:'4',includeClosed:'true',q:'pagedpage',...(cursor ? {cursor} : {})});
    const response = await app.inject(`/api/cards?${query}`);
    expect(response.statusCode).toBe(200);
    const page:{cards:{id:string}[];nextCursor:string | null} = response.json();
    pageSizes.push(page.cards.length);
    ids.push(...page.cards.map(card=>card.id));
    cursor = page.nextCursor;
  } while (cursor);
  const expected = await h.sql`SELECT id FROM cards WHERE folder_id='public' AND archived=FALSE
    AND (strpos(lower(title),'pagedpage') > 0 OR strpos(lower(request),'pagedpage') > 0 OR strpos('#' || COALESCE(number::text,''),'pagedpage') > 0)
    ORDER BY CASE status WHEN 'todo' THEN 1 WHEN 'queued' THEN 2 WHEN 'running' THEN 3 WHEN 'blocked' THEN 4
      WHEN 'review' THEN 5 WHEN 'on_hold' THEN 6 WHEN 'done' THEN 7 WHEN 'cancelled' THEN 8 ELSE 9 END,
      updated_at DESC, id COLLATE "C" DESC`;
  expect(ids).toEqual(expected.map(row=>row.id));
  expect(ids).toHaveLength(11);
  expect(new Set(ids).size).toBe(ids.length);
  expect(pageSizes).toEqual([4,4,3]);
});

it('searches paged cards by title, request and #number and rejects malformed cursors', async () => {
  await seedPagedCards([
    {id:'paged-num-target', status:'todo', updatedAt:'2026-11-05 00:00:00+00', title:'번호 검색 카드', request:'pagednum 요청', number:987001},
    {id:'paged-num-other', status:'running', updatedAt:'2026-11-05 00:00:01+00', title:'pagednum 다른 카드', request:'pagednum 요청'},
  ]);
  const byWord = (await app.inject('/api/cards?limit=10&includeClosed=true&q=pagednum')).json();
  expect(byWord.cards.map((c:{id:string})=>c.id)).toEqual(['paged-num-target','paged-num-other']);
  const byNumber = (await app.inject('/api/cards?limit=10&includeClosed=true&q=%23987001')).json();
  expect(byNumber.cards.map((c:{id:string})=>c.id)).toEqual(['paged-num-target']);
  expect(byNumber.nextCursor).toBeNull();
  expect((await app.inject('/api/cards?limit=10&includeClosed=false&cursor=broken')).statusCode).toBe(400);
});

it('measures the existing 1000-card fixture response and database plan', async () => {
  const started=performance.now();
  const response=await app.inject('/api/cards?status=done&limit=60');
  const elapsedMs=performance.now()-started;
  const plans=await h.sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM cards
    WHERE status='done' AND archived=FALSE AND completed_at IS NOT NULL AND folder_id=ANY(ARRAY['public'])
    ORDER BY completed_at DESC,id COLLATE "C" DESC LIMIT 61`;
  console.info('completed-fixture-metrics',JSON.stringify({fixture:1000,requests:1,page:response.json().cards.length,
    bytes:Buffer.byteLength(response.body),elapsedMs,plan:plans[0]}));
  expect(response.json().cards).toHaveLength(60);
});
