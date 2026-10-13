import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { SqlClient, FolderDbPort } from "../src/cards/control_plane/card_types.js";
import { PersistentReportService, type PublishPersistentReports } from "../src/session/persistent_report_service.js";
import { PerNodeSessionCache } from "../src/node/session_cache.js";
import { InMemorySseReplayBroadcaster, type SessionStreamEvent } from "../src/sse/replay_broadcaster.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// Delay only completed full statements. The production event_append and every
// service query still run against PostgreSQL; no audit persistence is mocked.
function observe(sql: SqlClient, after: (text: string) => Promise<void>): SqlClient {
  const wrap = (query: SqlClient): SqlClient => new Proxy(query, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      const template = args[0] as TemplateStringsArray;
      if (!Array.isArray(template) || !("raw" in template)) return result;
      const text = template.join("?").replace(/\s+/g, " ").trim();
      if (!/^SELECT (\* FROM (cards|folders)|event_append)/.test(text)) return result;
      return Promise.resolve(result).then(async rows => { await after(text); return rows; });
    },
    get(target, key, receiver) {
      if (key === "begin") return (run: Parameters<SqlClient["begin"]>[0]) =>
        target.begin(tx => run(wrap(tx as SqlClient)));
      return Reflect.get(target, key, receiver);
    },
  });
  return wrap(sql);
}

const audit: FolderDbPort = {
  async appendEventTx(tx, p) {
    const rows = await tx<{ id: number }[]>`SELECT event_append(
      ${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
    return rows[0]!.id;
  },
};
const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
const entry = (key: string, card_numbers: number[] = []) => ({
  key, kind: "ask" as const, title: key, card_numbers, context: "맥락", action: "결정", options: ["진행"],
});

describe("PAS report commit and lock ordering on production schema", () => {
  let sql: ReturnType<typeof postgres>;
  let adapted: SqlClient;
  let stop: () => void;
  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "report_order_test", password: "report_order_test", database: "report_order_test_db",
    });
    stop = container.stop;
    sql = postgres(`postgres://report_order_test:report_order_test@127.0.0.1:${container.port}/report_order_test_db`, {
      max: 6, onnotice: () => undefined, connection: { statement_timeout: 15000 },
    });
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    adapted = createBoardYjsSqlAdapter(sql as never);
  }, 90_000);
  afterAll(async () => { await sql?.end({ timeout: 2 }); stop?.(); });

  async function world(id: string, publish: PublishPersistentReports) {
    await sql`INSERT INTO folders(id,name) VALUES(${id},'보고 실행 계약')`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,status,metadata)
      VALUES(${id},${id},'test-node','roselin','running',${sql.json([{type:"persistent_session",value:{enabled:true}}])})`;
    const cards = new CardControlPlaneService(adapted, audit, undefined, undefined, publish);
    const created = await cards.createCard({
      ...human, folderId: id, title: "묶인 카드", request: "",
      assignee: { kind: "session", sessionId: id },
    });
    const cardId = created.operation.target_id;
    const number = Number((await sql`SELECT number FROM cards WHERE id=${cardId}`)[0]!.number);
    const reports = new PersistentReportService(adapted, publish);
    await reports.put(id, entry("old", [number]));
    return { cardId, reports };
  }

  it("commits human completion and the assigned PAS note without deadlock or lost audit", async () => {
    const id = "pas-lock-order";
    const { cardId, reports } = await world(id, () => undefined);
    const cardLocked = gate(), releaseCard = gate(), sessionLocked = gate();
    const completed = new CardControlPlaneService(observe(adapted, async text => {
      if (text.startsWith("SELECT * FROM cards") && text.includes("FOR UPDATE")) {
        cardLocked.resolve();
        await releaseCard.promise;
      }
    }), audit, undefined, undefined, () => undefined);
    const notes = new CardControlPlaneService(observe(adapted, async text => {
      if (text.startsWith("SELECT event_append")) sessionLocked.resolve();
    }), audit, undefined, undefined, () => undefined);
    const completion = completed.setCardStatus({ ...human, cardId, status: "done" });
    await cardLocked.promise;
    const note = notes.addCardNote({
      actorKind: "agent", actorSessionId: id, cardId, text: "노트 보존",
    });
    await sessionLocked.promise;
    releaseCard.resolve();
    const results = await Promise.allSettled([completion, note]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await sql`SELECT status FROM cards WHERE id=${cardId}`)[0]!.status).toBe("done");
    expect(await sql`SELECT body FROM card_comments WHERE card_id=${cardId} AND kind='note'`).toMatchObject([{body:"노트 보존"}]);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM events WHERE session_id=${id}`)[0]!.n)).toBe(1);
    expect(await reports.get(id)).toEqual([]);
  });

  it("publishes the committed prune before snapshot waiting; a later put stays latest in SSE, cache and DB", async () => {
    const id = "pas-publish-order";
    const cache = new PerNodeSessionCache();
    cache.upsertFromSessionUpdated({
      nodeId: "test-node", connectionId: "connection", message: {agent_session_id:id,status:"running"}, nowMs: Date.now(),
    });
    const stream = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const boards: string[][] = [];
    stream.subscribe(event => {
      const entries = event.payload.persistent_report as Array<{key:string}>;
      boards.push(entries.map(e => e.key));
    });
    const publish: PublishPersistentReports = updates => {
      for (const update of updates) {
        cache.patchPersistentReport(update.agent_session_id, update.persistent_report);
        stream.append({type:"session_updated",agent_session_id:update.agent_session_id,persistent_report:update.persistent_report});
      }
    };
    const { cardId, reports } = await world(id, publish);
    boards.length = 0;
    const snapshotWaiting = gate(), releaseSnapshot = gate();
    const cards = new CardControlPlaneService(observe(adapted, async text => {
      if (text.startsWith("SELECT * FROM folders")) {
        snapshotWaiting.resolve();
        await releaseSnapshot.promise;
      }
    }), audit, undefined, undefined, publish);
    const completion = cards.setCardStatus({ ...human, cardId, status: "done" });
    await snapshotWaiting.promise;
    try {
      // The pruning transaction has committed before this snapshot starts.
      expect(await reports.get(id)).toEqual([]);
      await reports.put(id, entry("new"));
    } finally { releaseSnapshot.resolve(); }
    await completion;
    expect(boards).toEqual([[], ["new"]]);
    expect((cache.findSession(id)!.payload.persistent_report as Array<{key:string}>).map(e=>e.key)).toEqual(["new"]);
    expect((await reports.get(id)).map(e=>e.key)).toEqual(["new"]);
  });
});
