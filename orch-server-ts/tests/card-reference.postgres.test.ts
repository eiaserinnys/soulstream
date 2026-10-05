import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import {
  findCardSessionByOrdinal,
  findCardsByNumber,
  readCardChildOrdinals,
  readSessionReferences,
} from "../src/cards/card_reference_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

// Real PostgreSQL: the ordinal order and the number lookup are SQL, so they are checked against rows.
describe("card number references over PostgreSQL", () => {
  let h: FullSchemaPostgresHarness;
  let sql: ReturnType<typeof createBoardYjsSqlAdapter>;
  let cards: CardControlPlaneService;
  const open = "folder-open";
  const closed = "folder-closed";
  const longTitle = `${"가".repeat(59)}😀뒤에 잘릴 글`;
  let a: { id: string; number: number };
  let b: { id: string; number: number };
  let outside: { id: string; number: number };
  const numberless = "numberless-archived";

  async function insertCard(id: string, folderId: string, title: string) {
    return (await h.sql<{ id: string; number: number }[]>`
      INSERT INTO cards(id,folder_id,position_key,title) VALUES (${id},${folderId},${id},${title}) RETURNING id,number`)[0]!;
  }

  beforeAll(async () => {
    h = await createFullSchemaPostgresHarness();
    sql = createBoardYjsSqlAdapter(h.sql as unknown as LivePostgresSql);
    cards = new CardControlPlaneService(sql, { appendEventTx: async () => 0 }, { emitFolderUpdated: async () => {}, emitCardUpdated: async () => {} });
    await h.sql`INSERT INTO folders(id,name) VALUES (${open},'열린 폴더'),(${closed},'막힌 폴더')`;
    a = await insertCard("card-a", open, longTitle);
    b = await insertCard("card-b", open, "두 번째 카드");
    outside = await insertCard("card-outside", closed, "막힌 폴더의 카드");
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,archived,number)
      VALUES (${numberless},${open},'z','번호 없는 보관 카드',TRUE,NULL)`;
    // card-a sessions: s-old is oldest; s-tie-a and s-tie-b share a timestamp, so the id breaks the tie.
    await h.sql`INSERT INTO sessions(session_id,card_id,display_name,created_at) VALUES
      ('s-tie-b','card-a','동시 생성 B','2026-01-02T00:00:00Z'),
      ('s-old','card-a',NULL,'2026-01-01T00:00:00Z'),
      ('s-tie-a','card-a','동시 생성 A','2026-01-02T00:00:00Z'),
      ('s-numberless',${numberless},'번호 없는 카드의 세션','2026-01-01T00:00:00Z'),
      ('s-free',NULL,'카드 없는 세션','2026-01-01T00:00:00Z'),
      ('s-outside','card-outside','막힌 폴더의 세션','2026-01-01T00:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,created_at) VALUES
      ('r-late','card-a','나중 보고','markdown','b','2026-01-05T00:00:00Z'),
      ('r-early','card-a','먼저 보고','markdown','b','2026-01-04T00:00:00Z')`;
    await h.sql`INSERT INTO card_questions(id,card_id,text,asked_at) VALUES
      ('q-2','card-a','둘째 질문','2026-01-07T00:00:00Z'),
      ('q-1','card-a','첫째 질문','2026-01-06T00:00:00Z')`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES
      ('c-3','card-a','user','comment','셋째','2026-01-10T00:00:00Z'),
      ('c-1','card-a','user','comment','첫째','2026-01-08T00:00:00Z'),
      ('c-note','card-a','agent','note','노트도 센다','2026-01-09T00:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body) VALUES ('r-other','card-b','다른 카드 보고','markdown','b')`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("numbers sessions, reports, questions and comments from 1 in their own order", async () => {
    const ordinals = await readCardChildOrdinals(sql, a.id);
    expect(Object.fromEntries(ordinals.sessions)).toEqual({ "s-old": 1, "s-tie-a": 2, "s-tie-b": 3 });
    expect(Object.fromEntries(ordinals.reports)).toEqual({ "r-early": 1, "r-late": 2 });
    expect(Object.fromEntries(ordinals.questions)).toEqual({ "q-1": 1, "q-2": 2 });
    // Notes are comment rows: every row counts, whatever its kind.
    expect(Object.fromEntries(ordinals.comments)).toEqual({ "c-1": 1, "c-note": 2, "c-3": 3 });
    expect(Object.fromEntries((await readCardChildOrdinals(sql, b.id)).reports)).toEqual({ "r-other": 1 });
  });

  it("gives a session its number only when its card has one", async () => {
    const references = await readSessionReferences(sql, ["s-tie-a", "s-old", "s-numberless", "s-free", "missing"]);
    expect(Object.fromEntries(references)).toEqual({
      "s-tie-a": { cardNumber: a.number, ordinal: 2 },
      "s-old": { cardNumber: a.number, ordinal: 1 },
    });
  });

  it("finds cards by number whatever their archive state and the nth session of a card", async () => {
    await h.sql`UPDATE cards SET archived=TRUE WHERE id='card-b'`;
    const found = await findCardsByNumber(sql, [a.number, b.number, 999_999]);
    expect(found.map(card => card.id).sort()).toEqual(["card-a", "card-b"]);
    expect(await findCardSessionByOrdinal(sql, a.id, 3)).toEqual({ session: { session_id: "s-tie-b", display_name: "동시 생성 B" }, total: 3 });
    expect(await findCardSessionByOrdinal(sql, a.id, 4)).toEqual({ session: null, total: 3 });
    expect(await findCardSessionByOrdinal(sql, b.id, 1)).toEqual({ session: null, total: 0 });
  });

  it("resolves a card number and a session number to the full ID and a trimmed title", async () => {
    const results = await cards.resolveReferences([`#${a.number}`, `#${a.number}.s1`, `#${a.number}.s3`, `#${b.number}`]);
    expect(results).toEqual([
      { ref: `#${a.number}`, kind: "card", id: "card-a", title: "가".repeat(59) + "😀" },
      { ref: `#${a.number}.s1`, kind: "session", id: "s-old", title: "이름 없음" },
      { ref: `#${a.number}.s3`, kind: "session", id: "s-tie-b", title: "동시 생성 B" },
      // Archived cards keep their number and still resolve.
      { ref: `#${b.number}`, kind: "card", id: "card-b", title: "두 번째 카드" },
    ]);
  });

  it("reports numbers that were never issued and session positions that do not exist", async () => {
    expect(await cards.resolveReferences(["#999999", `#${a.number}.s5`, "#999999.s1"])).toEqual([
      { ref: "#999999", error: "#999999 번호의 카드가 없습니다." },
      { ref: `#${a.number}.s5`, error: `카드 #${a.number}에 붙은 세션은 3개입니다. #${a.number}.s5는 없습니다.` },
      { ref: "#999999.s1", error: "#999999 번호의 카드가 없습니다." },
    ]);
  });

  it("answers a card in a folder the caller may not see exactly like a card that does not exist", async () => {
    const allow = (folderId: string) => folderId === open;
    expect(await cards.resolveReferences([`#${outside.number}`, `#${outside.number}.s1`, `#${a.number}`], allow)).toEqual([
      { ref: `#${outside.number}`, error: `#${outside.number} 번호의 카드가 없습니다.` },
      { ref: `#${outside.number}.s1`, error: `#${outside.number} 번호의 카드가 없습니다.` },
      expect.objectContaining({ ref: `#${a.number}`, kind: "card", id: "card-a" }),
    ]);
    expect(await cards.resolveReferences([`#${outside.number}`])).toEqual([expect.objectContaining({ id: "card-outside" })]);
  });

  it("does not resolve references that are not a card or a session of a card", async () => {
    const results = await cards.resolveReferences(["not-a-reference", `#${a.number}.r1`]);
    expect(results.map(result => "error" in result)).toEqual([true, true]);
  });

  it("exposes the child ordinals and session references through the service", async () => {
    expect((await cards.getCardChildOrdinals(a.id)).sessions.get("s-old")).toBe(1);
    expect((await cards.getSessionReferences(["s-old"])).get("s-old")).toEqual({ cardNumber: a.number, ordinal: 1 });
  });
});
