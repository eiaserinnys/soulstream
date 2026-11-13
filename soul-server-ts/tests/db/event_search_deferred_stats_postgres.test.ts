import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

/**
 * Card #1332. The event search triggers write the shared corpus stats row at commit, an event
 * with nothing to index never touches it, and session row locks that cannot delete the row do
 * not queue the foreign key checks of other tables. The deadlock cases use two or three real
 * connections and a lock_timeout so a regression fails fast instead of hanging the run.
 */
const describePostgres = hasFullSchemaPostgresBackend ? describe.sequential : describe.skip;

type Sql = FullSchemaPostgresHarness["sql"];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

type Tx = Parameters<Parameters<Sql["begin"]>[0]>[0];

/** Opens a transaction on the peer, takes the lock, and keeps the transaction open until release(). */
async function holdLock(peer: Sql, lock: (tx: Tx) => PromiseLike<unknown>) {
  const holding = gate();
  const releaseGate = gate();
  const done = peer.begin(async (tx) => {
    await lock(tx);
    holding.open();
    await releaseGate.opened;
  });
  done.catch(() => holding.open());
  await holding.opened;
  return { release: async () => { releaseGate.open(); await done; } };
}

async function waitForLockWait(monitor: Sql, queryPattern: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const rows = await monitor`SELECT 1 FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query LIKE ${queryPattern}`;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no backend waited for a lock matching ${queryPattern}`);
}

async function addSessions(sql: Sql, ...ids: string[]) {
  for (const id of ids) await sql`INSERT INTO sessions (session_id, status) VALUES (${id}, 'idle')`;
}

async function statsRow(sql: Sql) {
  const [row] = await sql<Array<{ total_docs: string; total_doc_len: string; version: string }>>`
    SELECT total_docs::text, total_doc_len::text, xmin::text AS version
    FROM event_search_corpus_stats WHERE id = TRUE`;
  return row!;
}

describePostgres("event search stats row and session row lock levels", () => {
  let harness: FullSchemaPostgresHarness;
  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    await harness.sql`INSERT INTO event_search_corpus_stats (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`;
  }, 120_000);
  afterAll(async () => { await harness?.cleanup(); });

  it("installs the search triggers as deferred constraint triggers", async () => {
    const rows = await harness.sql<Array<{ tgname: string; definition: string }>>`
      SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'events'::regclass AND NOT tgisinternal
        AND tgname IN ('trg_event_search_terms', 'trg_event_search_corpus_stats_delete')
      ORDER BY tgname`;
    expect(rows.map((row) => row.tgname)).toEqual([
      "trg_event_search_corpus_stats_delete", "trg_event_search_terms",
    ]);
    for (const row of rows) {
      expect(row.definition).toContain("CREATE CONSTRAINT TRIGGER");
      expect(row.definition).toContain("DEFERRABLE INITIALLY DEFERRED");
      expect(row.definition).toContain("FOR EACH ROW");
    }
    expect(rows[0]!.definition).toContain("AFTER DELETE ON");
    expect(rows[1]!.definition).toMatch(/AFTER INSERT OR UPDATE OF searchable_text ON/);
  });

  it("does not deadlock when a transaction that appended an event waits for an ingress-held session row", async () => {
    // The production cycle: the card transaction appended an event (stats row) and then waited for
    // the session row an event ingress transaction holds; that ingress transaction then appends
    // its own event and needs the stats row. The card side keeps its old FOR SHARE read here on
    // purpose: the stats row alone must no longer close the cycle.
    const sql = harness.sql;
    const card = harness.createPeer();
    const ingress = harness.createPeer();
    await addSessions(sql, "dl-card", "dl-ingress");
    const ingressHoldsRow = gate();
    const cardIsWaiting = gate();

    const ingressDone = ingress.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '20s'`;
      // lockSession shape (event_ingress_repository.ts).
      await tx`SELECT node_id, status FROM sessions WHERE session_id = 'dl-ingress' FOR NO KEY UPDATE`;
      ingressHoldsRow.open();
      await cardIsWaiting.opened;
      await tx`SELECT event_append('dl-ingress', 'user_message', '{}', 'alpha ingress body', now())`;
    });
    const cardDone = (async () => {
      await ingressHoldsRow.opened;
      return await card.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '20s'`;
        await tx`SELECT event_append('dl-card', 'user_message', '{}', 'alpha card body', now())`;
        const waiting = tx`SELECT card_id FROM sessions WHERE session_id = 'dl-ingress' FOR SHARE`.execute();
        try {
          await waitForLockWait(sql, "%FROM sessions WHERE session_id = 'dl-ingress' FOR SHARE%");
        } finally {
          cardIsWaiting.open();
        }
        await waiting;
      });
    })();

    await expect(Promise.all([ingressDone, cardDone])).resolves.toBeDefined();
    const events = await sql`SELECT session_id FROM events WHERE session_id IN ('dl-card', 'dl-ingress')
      ORDER BY session_id`;
    expect(events).toEqual([{ session_id: "dl-card" }, { session_id: "dl-ingress" }]);
    const docs = await sql`SELECT count(*)::int AS n FROM event_search_documents`;
    expect(docs[0]?.n).toBe(2);
    await sql`DELETE FROM sessions WHERE session_id IN ('dl-card', 'dl-ingress')`;
  }, 60_000);

  it("writes the stats row only at commit", async () => {
    const sql = harness.sql;
    const other = harness.createPeer();
    await addSessions(sql, "dl-late");
    const before = await statsRow(sql);
    const appended = gate();
    const release = gate();
    const writer = sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '20s'`;
      await tx`SELECT event_append('dl-late', 'user_message', '{}', 'late stats body', now())`;
      appended.open();
      await release.opened;
    });
    await appended.opened;
    // Uncommitted: another connection still sees the old row and can lock it without waiting.
    await other.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SELECT id FROM event_search_corpus_stats WHERE id = TRUE FOR UPDATE`;
    });
    release.open();
    await writer;
    const after = await statsRow(sql);
    expect(Number(after.total_docs)).toBe(Number(before.total_docs) + 1);
    expect(Number(after.total_doc_len)).toBe(Number(before.total_doc_len) + 3);
    await sql`DELETE FROM sessions WHERE session_id = 'dl-late'`;
  }, 60_000);

  it("never touches the stats row for an event with nothing to index", async () => {
    const sql = harness.sql;
    const holder = harness.createPeer();
    await addSessions(sql, "dl-empty");
    const before = await statsRow(sql);
    const held = await holdLock(holder, (tx) => tx`SELECT id FROM event_search_corpus_stats WHERE id = TRUE FOR UPDATE`);
    try {
      // With another connection holding the stats row, an event without a body still commits.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SELECT event_append('dl-empty', 'tool_use', '{}', '', now())`;
        await tx`SELECT event_append('dl-empty', 'tool_use', '{}', NULL, now())`;
        await tx`SELECT event_append('dl-empty', 'tool_use', '{}', ' ,.-- ', now())`;
        await tx`UPDATE events SET searchable_text = '' WHERE session_id = 'dl-empty'`;
        await tx`DELETE FROM events WHERE session_id = 'dl-empty' AND id = 3`;
      });
      // Control: an event with a body has to wait for that connection.
      await expect(sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '1s'`;
        await tx`SELECT event_append('dl-empty', 'tool_use', '{}', 'needs the stats row', now())`;
      })).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await held.release();
    }
    const after = await statsRow(sql);
    expect(after).toEqual(before);
    const kept = await sql`SELECT count(*)::int AS n FROM events WHERE session_id = 'dl-empty'`;
    expect(kept[0]?.n).toBe(2);
    expect((await sql`SELECT count(*)::int AS n FROM event_search_documents`)[0]?.n).toBe(0);
    await sql`DELETE FROM sessions WHERE session_id = 'dl-empty'`;
  }, 60_000);

  it("still takes the stats row first for a term-changing update whose delta is zero", async () => {
    const sql = harness.sql;
    const holder = harness.createPeer();
    await addSessions(sql, "dl-zero");
    await sql`SELECT event_append('dl-zero', 'user_message', '{}', 'one two', now())`;
    const held = await holdLock(holder, (tx) => tx`SELECT id FROM event_search_corpus_stats WHERE id = TRUE FOR UPDATE`);
    try {
      await expect(sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '1s'`;
        await tx`UPDATE events SET searchable_text = 'two one' WHERE session_id = 'dl-zero' AND id = 1`;
      })).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await held.release();
    }
    await sql`DELETE FROM sessions WHERE session_id = 'dl-zero'`;
  }, 60_000);

  it("does not queue a foreign key insert behind a lockSession-shaped lock", async () => {
    const sql = harness.sql;
    await addSessions(sql, "dl-fk");
    const insertEvent = (id: number, timeout: string) => sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${timeout}'`);
      await tx`INSERT INTO events (session_id, id, event_type, searchable_text)
        VALUES ('dl-fk', ${id}, 'user_message', '')`;
    });

    const noKey = await holdLock(harness.createPeer(), (tx) =>
      tx`SELECT node_id FROM sessions WHERE session_id = 'dl-fk' FOR NO KEY UPDATE`);
    try {
      await insertEvent(1, "3s");
    } finally {
      await noKey.release();
    }

    // Control: the previous FOR UPDATE does hold the foreign key check back.
    const exclusive = await holdLock(harness.createPeer(), (tx) =>
      tx`SELECT node_id FROM sessions WHERE session_id = 'dl-fk' FOR UPDATE`);
    try {
      await expect(insertEvent(2, "1s")).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await exclusive.release();
    }
    expect((await sql`SELECT count(*)::int AS n FROM events WHERE session_id = 'dl-fk'`)[0]?.n).toBe(1);
    await sql`DELETE FROM sessions WHERE session_id = 'dl-fk'`;
  }, 60_000);

  it("leaves the same search rows, document frequencies, stats and results after commit", async () => {
    const sql = harness.sql;
    await addSessions(sql, "dl-life");
    const before = await statsRow(sql);

    await sql.begin(async (tx) => {
      const append = async (body: string) =>
        (await tx<Array<{ id: number }>>`SELECT event_append('dl-life', 'user_message', '{}', ${body}, now()) AS id`)[0]!.id;
      const rewrite = (id: number, body: string) =>
        tx`UPDATE events SET searchable_text = ${body} WHERE session_id = 'dl-life' AND id = ${id}`;
      await append("alpha beta beta");
      await append("");
      const third = await append("alpha gamma");
      await rewrite(third, "alpha gamma delta delta");
      const inserted = await append("zeta");
      await tx`DELETE FROM events WHERE session_id = 'dl-life' AND id = ${inserted}`;
      const rewritten = await append("eta theta");
      await rewrite(rewritten, "iota");
      await rewrite(rewritten, "");
    });

    const documents = await sql`SELECT k.session_id, m.event_id, m.doc_len
      FROM event_search_documents m JOIN event_search_session_keys k USING (session_key) ORDER BY m.event_id`;
    expect(documents).toEqual([
      { session_id: "dl-life", event_id: 1, doc_len: 3 },
      { session_id: "dl-life", event_id: 3, doc_len: 4 },
    ]);
    const postings = await sql`SELECT p.event_id, d.term, p.term_freq
      FROM event_search_postings p JOIN event_search_dictionary d USING (term_id)
      ORDER BY p.event_id, d.term`;
    expect(postings).toEqual([
      { event_id: 1, term: "alpha", term_freq: 1 }, { event_id: 1, term: "beta", term_freq: 2 },
      { event_id: 3, term: "alpha", term_freq: 1 }, { event_id: 3, term: "delta", term_freq: 2 },
      { event_id: 3, term: "gamma", term_freq: 1 },
    ]);
    const frequencies = await sql`SELECT term, document_count::int AS document_count
      FROM event_search_term_document_frequency WHERE document_count > 0 ORDER BY term`;
    expect(frequencies).toEqual([
      { term: "alpha", document_count: 2 }, { term: "beta", document_count: 1 },
      { term: "delta", document_count: 1 }, { term: "gamma", document_count: 1 },
    ]);
    const after = await statsRow(sql);
    expect(Number(after.total_docs) - Number(before.total_docs)).toBe(2);
    expect(Number(after.total_doc_len) - Number(before.total_doc_len)).toBe(7);
    const found = await sql`SELECT session_id, id FROM event_search('gamma', NULL, 10, NULL, NULL, 2, 3)
      ORDER BY id`;
    expect(found).toEqual([{ session_id: "dl-life", id: 3 }]);

    // A rolled-back transaction leaves no search row and no stats change.
    const checkpoint = await statsRow(sql);
    await expect(sql.begin(async (tx) => {
      await tx`SELECT event_append('dl-life', 'user_message', '{}', 'rolled back words', now())`;
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    expect(await statsRow(sql)).toEqual(checkpoint);
    expect((await sql`SELECT count(*)::int AS n FROM event_search_documents`)[0]?.n).toBe(2);

    // Deleting the session removes its rows and returns the stats to where they started.
    await sql`DELETE FROM sessions WHERE session_id = 'dl-life'`;
    const finish = await statsRow(sql);
    expect(finish.total_docs).toBe(before.total_docs);
    expect(finish.total_doc_len).toBe(before.total_doc_len);
    expect((await sql`SELECT count(*)::int AS n FROM event_search_documents`)[0]?.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM event_search_postings`)[0]?.n).toBe(0);
  }, 60_000);

  it("has indexes that serve the ON DELETE SET NULL checks of a session or event delete", async () => {
    const sql = harness.sql;
    // The check statements the foreign keys run, prepared with generic parameters like the trigger does.
    const checks: Array<{ index: string; types: string; args: string; statement: string }> = [
      { index: "idx_folder_operations_actor_session", types: "text, integer", args: "'s', 1",
        statement: "UPDATE ONLY folder_operations SET actor_session_id = NULL, actor_event_id = NULL WHERE $1 OPERATOR(pg_catalog.=) actor_session_id AND $2 OPERATOR(pg_catalog.=) actor_event_id" },
      ...["assignee", "created", "updated", "completed"].map((name) => ({
        index: `idx_cards_${name}_session_id`, types: "text", args: "'s'",
        statement: `UPDATE ONLY cards SET ${name}_session_id = NULL WHERE $1 OPERATOR(pg_catalog.=) ${name}_session_id`,
      })),
    ];
    for (const check of checks) {
      const plan = await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
        await tx.unsafe(`PREPARE ri_check (${check.types}) AS ${check.statement}`);
        const rows = await tx.unsafe(`EXPLAIN EXECUTE ri_check (${check.args})`);
        await tx.unsafe("DEALLOCATE ri_check");
        return rows;
      });
      const text = plan.map((row) => String(row["QUERY PLAN"])).join("\n");
      expect(text, `the check should use ${check.index}`).toContain(check.index);
    }
  }, 60_000);
});
