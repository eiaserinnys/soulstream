import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema, appendCardEventTx } from "./card-work-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { cardHandlers } from "../src/mcp/card_handlers.js";
import { cardTools } from "@soulstream/mcp-contract";
import { z } from "zod";
import type { McpHostOptions, McpCallContext } from "../src/mcp/types.js";

const migrationUrl = new URL("../../packages/db-schema/sql/migrations/115_single_card_assignee.sql", import.meta.url);
const human = { actorKind: "user" as const, actorSessionId: null };
describe("single card ownership", () => {
  let h: PagePostgresHarness, cards: CardControlPlaneService;
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    // RED runs the old schema; GREEN also exercises the official migration.
    try { await h.sql.unsafe(await readFile(migrationUrl, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더'),('g','다른 폴더')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status,execution_registration_id,execution_command_id)
      VALUES ('owner','node','roselin','sol','running','reg','cmd'),('peer','node','roselin','sol','running','reg2','cmd2'),('wrong','node','other','luna','running','reg3','cmd3')`;
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx });
  }, 60000);
  beforeEach(async () => { await h.sql`DELETE FROM folder_operations`; await h.sql`DELETE FROM cards`; await h.sql`DELETE FROM events`; await h.sql`UPDATE sessions SET card_id=NULL,caller_session_id=NULL`; });
  afterAll(async () => h?.cleanup());
  const actor = (id = "owner") => ({ actorKind: "agent" as const, actorSessionId: id });
  async function make(assignee: Parameters<typeof cards.createCard>[0]["assignee"] = { kind: "agent", agentId: "roselin" }) {
    return (await cards.createCard({ ...human, folderId: "f", title: "요청", request: "원문", assignee })).operation.target_id;
  }
  it.each(["status", "work", "reply"])("claims an agent-owned card atomically during %s", async method => {
    const id = await make(); await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id='owner'`;
    if (method === "status") await cards.setCardStatus({ ...actor(), cardId: id, status: "running", idempotencyKey: "claim" });
    if (method === "work") await cards.startCardWork({ ...actor(), cardId: id, execution: { registrationId: "reg", executionCommandId: "cmd" }, idempotencyKey: "claim" });
    if (method === "reply") await cards.addComment({ ...actor(), cardId: id, mode: "reply", body: "답변", idempotencyKey: "claim" });
    expect((await cards.getCard(id))!.card).toMatchObject({ assignee_kind: "session", assignee_session_id: "owner", assignee_agent_id: null });
    expect((await h.sql`SELECT payload_json FROM folder_operations WHERE idempotency_key='claim'`)[0]!.payload_json).toMatchObject({ claimed_assignee: true });
    if (method === "status") expect((await cards.setCardStatus({ ...actor(), cardId: id, status: "running", idempotencyKey: "claim" })).idempotent).toBe(true);
    if (method === "work") expect((await cards.startCardWork({ ...actor(), cardId: id, execution: { registrationId: "reg", executionCommandId: "cmd" }, idempotencyKey: "claim" })).idempotent).toBe(true);
    if (method === "reply") await cards.addComment({ ...actor(), cardId: id, mode: "reply", body: "답변", idempotencyKey: "claim" });
    await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id='peer'`;
    await expect(cards.setCardStatus({ ...actor("peer"), cardId: id, status: "running" })).rejects.toThrow("assignee");
  });
  it.each(["wrong", "child"])("rejects the %s session", async kind => {
    const id = await make();
    const sid = kind === "child" ? "peer" : "wrong";
    await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id IN ('owner',${sid})`;
    if (kind === "child") await h.sql`UPDATE sessions SET caller_session_id='owner' WHERE session_id='peer'`;
    await expect(cards.setCardStatus({ ...actor(sid), cardId: id, status: "running" })).rejects.toThrow("assignee");
  });
  it("rejects second ownership across creation, patch, claim and unarchive, counting completed cards", async () => {
    const first = await make({ kind: "session", sessionId: "owner" });
    await cards.setCardStatus({ ...human, cardId: first, status: "done" });
    const error = { statusCode: 422, code: "INVALID_CARD_REQUEST", message: expect.stringContaining(first) };
    await expect(make({ kind: "session", sessionId: "owner" })).rejects.toMatchObject(error);
    const second = await make(); await h.sql`UPDATE sessions SET card_id=${second} WHERE session_id='owner'`;
    await expect(cards.setCardStatus({ ...actor(), cardId: second, status: "running" })).rejects.toMatchObject(error);
    await expect(cards.patchCard({ ...human, cardId: second, assignee: { kind: "session", sessionId: "owner" } })).rejects.toMatchObject(error);
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,archived,assignee_kind,assignee_session_id) VALUES ('archive','f','z','보관',TRUE,'session','owner')`;
    await expect(cards.patchCard({ ...human, cardId: "archive", archived: false })).rejects.toMatchObject(error);
    await cards.patchCard({ ...human, cardId: first, archived: true });
    await cards.setCardStatus({ ...actor(), cardId: second, status: "running" });
    expect((await cards.getCard(second))!.card.assignee_session_id).toBe("owner");
  });
  it("serializes concurrent ownership of different cards into one success and one readable 422", async () => {
    const a = await make(null), b = await make(null);
    const peer = new CardControlPlaneService(createBoardYjsSqlAdapter(h.peerLiveSql), { appendEventTx: appendCardEventTx });
    const results = await Promise.allSettled([cards.patchCard({ ...human, cardId: a, assignee: { kind: "session", sessionId: "owner" } }), peer.patchCard({ ...human, cardId: b, assignee: { kind: "session", sessionId: "owner" } })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message: expect.stringMatching(new RegExp(`${a}|${b}`)) });
  });
  it("inherits creator defaults and persists brief through the MCP contract with retry identity", async () => {
    const args = { folder_id: "f", title: "다음 일", request: "원문", queue: true, brief: "인계 내용", idempotency_key: "new-work" };
    const parsed = z.object(cardTools.create_card.config.inputSchema).strict().parse(args);
    const options = { cards: { cardServiceProvider: async () => cards, provider: { listFolders: async () => [{ id: "f" }] }, resolveAccess: async () => ({ restricted: false }) } } as unknown as McpHostOptions;
    const context = { principal: "internal", callerSessionId: "owner" } as McpCallContext;
    for (let i = 0; i < 2; i++) expect((await cardHandlers.create_card(options, parsed, context)).isError).not.toBe(true);
    const rows = await h.sql`SELECT * FROM cards`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assignee_kind: "agent", assignee_agent_id: "roselin", assignee_session_id: null, node_id: "node", model_preset: "sol", brief: "인계 내용", status: "queued" });
    const explicit = await cards.createCard({ ...actor(), folderId: "f", title: "명시", request: "", assignee: null });
    expect((await cards.getCard(explicit.operation.target_id))!.card).toMatchObject({ assignee_kind: null, node_id: null, model_preset: null });
  });
  it("changes status_changed_at only for a real status transition", async () => {
    const id = await make(null);
    await h.sql`UPDATE cards SET status_changed_at='2026-01-01' WHERE id=${id}`;
    await cards.patchCard({ ...human, cardId: id, brief: "경과" });
    await cards.setCardStatus({ ...human, cardId: id, status: "todo" });
    expect((await h.sql`SELECT status_changed_at FROM cards WHERE id=${id}`)[0]!.status_changed_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    await cards.setCardStatus({ ...human, cardId: id, status: "running" });
    expect((await h.sql`SELECT status_changed_at FROM cards WHERE id=${id}`)[0]!.status_changed_at.toISOString()).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

it("migration releases all but the newest card, preserves content and records reversible provenance", async () => {
  const h = await createPagePostgresHarness();
  try {
    const migration = await readFile(migrationUrl, "utf8");
    await h.sql`ALTER TABLE cards DROP COLUMN status_changed_at`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더')`;
    await h.sql`INSERT INTO sessions(session_id) VALUES ('owner')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,brief,status,assignee_kind,assignee_session_id,created_at,updated_at,archived)
      VALUES ('a','f','a','이전','원문','경과','running','session','owner','2026-01-01','2026-02-01',FALSE),
      ('b','f','b','동률','원문2','경과2','done','session','owner','2026-01-02','2026-02-02',FALSE),
      ('c','f','c','유지','원문3','경과3','review','session','owner','2026-01-02','2026-02-03',FALSE),
      ('z','f','z','보관','','','todo','session','owner','2026-01-03','2026-02-04',TRUE)`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body) VALUES ('r','a','보고','markdown','증거')`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,body) VALUES ('m','a','user','추가')`;
    await h.sql`INSERT INTO card_questions(id,card_id,text) VALUES ('q','a','결정?')`;
    await h.sql`UPDATE cards SET completed_kind='user',completed_user_id='director',completed_at='2026-02-02' WHERE id='b'`;
    const before = await h.sql`SELECT * FROM cards ORDER BY id`;
    await h.sql.unsafe(migration);
    const once = await h.sql`SELECT * FROM cards ORDER BY id`;
    const audit = await h.sql`SELECT * FROM folder_operations ORDER BY target_id`;
    expect(audit).toHaveLength(2);
    for (const id of ["a", "b"]) {
      const old = before.find(c => c.id === id)!, card = once.find(c => c.id === id)!;
      expect(card).toEqual({ ...old, assignee_kind: null, assignee_session_id: null, version: old.version + 1, status_changed_at: old.updated_at });
      expect(audit.find(o => o.target_id === id)).toMatchObject({ operation_type: "release_card_assignee", actor_kind: "system", idempotency_key: `migration-115:release:${id}`, payload_json: { previous_assignee_kind: "session", previous_assignee_session_id: "owner", kept_card_id: "c", rule: "latest_created_card" } });
    }
    expect(once.filter(c => c.assignee_session_id).map(c => c.id)).toEqual(["c", "z"]);
    await h.sql`UPDATE cards SET status_changed_at='2026-03-01' WHERE id='c'`;
    const updated = await h.sql`SELECT * FROM cards ORDER BY id`;
    await h.sql.unsafe(migration);
    expect(await h.sql`SELECT * FROM cards ORDER BY id`).toEqual(updated);
    expect(await h.sql`SELECT * FROM folder_operations ORDER BY target_id`).toEqual(audit);
    expect(await h.sql`SELECT body FROM card_reports`).toEqual([{ body: "증거" }]);
    expect(await h.sql`SELECT body FROM card_comments`).toEqual([{ body: "추가" }]);
    expect(await h.sql`SELECT text,answer FROM card_questions`).toEqual([{ text: "결정?", answer: null }]);
    await expect(h.sql`UPDATE cards SET assignee_session_id='owner' WHERE id='a'`).rejects.toMatchObject({ code: "23505", constraint_name: "uq_cards_assignee_session" });
  } finally { await h.cleanup(); }
}, 60000);

it.each(["eligible","archived","foreign"])("migration respects the explicit user exception, %s", async mode => {
  const h=await createPagePostgresHarness();
  const owner="41ecc1b4-7476-4866-a220-ab582a8244c5", keep="dcf30b19-f05b-4054-88fa-cc99f05bd03d";
  try {
    const migration=await readFile(migrationUrl,"utf8");
    await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더')`;
    await h.sql`INSERT INTO sessions(session_id) VALUES (${owner}),('other')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,status,assignee_kind,assignee_session_id,created_at,archived)
      VALUES (${keep},'f','a','진행 중','running','session',${mode === "foreign" ? "other" : owner},'2026-01-01',${mode === "archived"}),
      ('a4912668-9320-4435-8407-4dd85e9f755c','f','b','완료1','done','session',${owner},'2026-01-02',FALSE),
      ('c08dde0f-7c6d-49c9-8a80-5e2626a8399a','f','c','완료2','done','session',${owner},'2026-01-03',FALSE)`;
    await h.sql.unsafe(migration);
    const kept=await h.sql`SELECT id,status FROM cards WHERE assignee_session_id=${owner} AND NOT archived`;
    expect(kept).toEqual([{id:mode === "eligible" ? keep : "c08dde0f-7c6d-49c9-8a80-5e2626a8399a",status:mode === "eligible" ? "running" : "done"}]);
    const audit=await h.sql`SELECT payload_json FROM folder_operations`;
    expect(audit).toHaveLength(mode === "eligible" ? 2 : 1);
    for(const op of audit) expect(op.payload_json.rule).toBe(mode === "eligible" ? "user_override_keep_card" : "latest_created_card");
  } finally { await h.cleanup(); }
},60000);
