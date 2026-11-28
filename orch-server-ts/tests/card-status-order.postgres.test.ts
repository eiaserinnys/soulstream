import { afterAll, beforeAll, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";

let h: PagePostgresHarness;
let repo: CardControlPlaneService;
beforeAll(async () => {
  h = await createPagePostgresHarness();
  repo = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: async () => 1 });
  await h.sql`INSERT INTO folders(id,name) VALUES ('order-a','A'),('order-b','B')`;
  await h.sql`INSERT INTO cards(id,folder_id,title,request,position_key,status,queue_position_key,updated_at,status_changed_at) VALUES
    ('o1','order-a','첫째','','a','review',NULL,'2026-10-09','2026-10-01'),
    ('o2','order-a','둘째','','b','review',NULL,'2026-10-02','2026-10-05'),
    ('o3','order-b','셋째','','a','review',NULL,'2026-10-03','2026-10-03'),
    ('q1','order-a','대기1','','c','queued','b','2026-10-01','2026-10-09'),
    ('q2','order-a','대기2','','d','queued','a','2026-10-01','2026-10-02'),
    ('bl','order-a','한도 막힘','','e','blocked','a','2026-10-01','2026-10-02')`;
}, 60_000);
afterAll(async () => { await h?.cleanup(); });

const ids = (rows: { id: string }[]) => rows.map(row => row.id);

it("listCards는 기본이 폴더 위치순이고 status_changed 정렬을 고르면 상태 변경 시각 내림차순이다", async () => {
  expect(ids(await repo.listCards({ folderId: "order-a", status: "review" }))).toEqual(["o1", "o2"]);
  expect(ids(await repo.listCards({ status: "review", order: "status_changed" }))).toEqual(["o2", "o3", "o1"]);
});

it("listPagedCards는 상태 묶음 안에서 상태 변경순이고 커서도 그 시각을 쓴다", async () => {
  const first = await repo.listPagedCards({ status: "review", includeClosed: true, limit: 2, q: "" });
  expect(ids(first.cards)).toEqual(["o2", "o3"]);
  const second = await repo.listPagedCards({ status: "review", includeClosed: true, limit: 2, q: "", after: decodeCursor(first.nextCursor!) });
  expect(ids(second.cards)).toEqual(["o1"]);
});

it("getToday는 attention·queued 안에서 상태 변경 시각순을 쓴다", async () => {
  const planner = new PlannerRepository({ resolveSql: async () => h.liveSql, close: async () => {} });
  const today = (await planner.getToday())!;
  expect(today.attention.filter(c => ["o1", "o2", "o3", "bl"].includes(String(c.id))).map(c => c.id)).toEqual(["o2", "o3", "bl", "o1"]);
  expect(today.queued.filter(c => String(c.id).startsWith("q")).map(c => c.id)).toEqual(["q2", "q1"]);
});

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}
