import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { SessionMutationRepository } from
  "../src/control_plane/repositories/session_mutation_repository.js";
import { createSessionReconciliationSink } from
  "../src/node/session_reconciliation_sink.js";

type TransitionRow = {
  applied: boolean;
  status: string;
  termination_reason: string | null;
  termination_event_id: number | null;
};

describe("a session interrupted by a node disconnect", () => {
  let h: PagePostgresHarness;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS termination_detail TEXT,
      ADD COLUMN IF NOT EXISTS last_assistant_text TEXT,
      ADD COLUMN IF NOT EXISTS was_running_at_shutdown BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE`;
    const canonicalSchema = await readFile(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const startMarker = "CREATE OR REPLACE FUNCTION session_apply_terminal_transition(";
    const start = canonicalSchema.indexOf(startMarker);
    const endMarker = "\n$$;";
    const end = canonicalSchema.indexOf(endMarker, start);
    if (start < 0 || end < 0) {
      throw new Error("Canonical schema is missing session_apply_terminal_transition");
    }
    await h.sql.unsafe(canonicalSchema.slice(start, end + endMarker.length));
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  });

  it("applies a node terminal event to a session interrupted by a disconnect", async () => {
    await h.sql`INSERT INTO sessions(
      session_id, node_id, status, termination_reason, termination_detail
    ) VALUES ('disconnect-ended', 'node-ended', 'interrupted', 'killed', 'node_disconnect')`;

    const [application] = await h.sql<TransitionRow[]>`
      SELECT * FROM session_apply_terminal_transition(
        'disconnect-ended', 'completed', 'completed_ok', NULL,
        'acknowledged', '마지막 응답', 41, NOW()
      )
    `;
    expect(application).toMatchObject({
      applied: true,
      status: "completed",
      termination_reason: "completed_ok",
      termination_event_id: 41,
    });

    const [row] = await h.sql<Array<{
      status: string;
      termination_event_id: number | null;
      termination_detail: string | null;
    }>>`SELECT status, termination_event_id, termination_detail
      FROM sessions WHERE session_id = 'disconnect-ended'`;
    expect(row).toMatchObject({
      status: "completed",
      termination_event_id: 41,
      termination_detail: null,
    });
  });

  it("keeps a terminal row that already records a node terminal event", async () => {
    await h.sql`INSERT INTO sessions(
      session_id, node_id, status, termination_reason, termination_event_id
    ) VALUES ('already-ended', 'node-ended', 'completed', 'completed_ok', 41)`;

    const [application] = await h.sql<TransitionRow[]>`
      SELECT * FROM session_apply_terminal_transition(
        'already-ended', 'error', 'unknown', 'late', 'needs_review', NULL, 57, NOW()
      )
    `;
    expect(application).toMatchObject({
      applied: false,
      status: "completed",
      termination_reason: "completed_ok",
      termination_event_id: 41,
    });
  });

  it("interrupts an initializing-only node after the startup lease window", async () => {
    await h.sql`INSERT INTO sessions(session_id, node_id, status)
      VALUES ('starting-only', 'node-starting', 'initializing')`;

    const repository = new SessionMutationRepository(h.liveSql as never);
    await expect(repository.listRunningNodeIds()).resolves.toContain("node-starting");

    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: () => undefined,
      isLeaseAwareNode: () => true,
      restoreLeaseGraceOnStartup: true,
      disconnectGraceMs: 20,
    });
    await sink.start();
    try {
      await vi.waitFor(async () => {
        const [row] = await h.sql<Array<{ status: string }>>`
          SELECT status FROM sessions WHERE session_id = 'starting-only'
        `;
        expect(row?.status).toBe("interrupted");
      }, { timeout: 3_000, interval: 20 });
    } finally {
      await sink.close();
    }

    const [row] = await h.sql<Array<{
      status: string;
      termination_reason: string | null;
      termination_detail: string | null;
      termination_event_id: number | null;
    }>>`SELECT status, termination_reason, termination_detail, termination_event_id
      FROM sessions WHERE session_id = 'starting-only'`;
    expect(row).toMatchObject({
      status: "interrupted",
      termination_reason: "killed",
      termination_detail: "node_disconnect_timeout",
      termination_event_id: null,
    });
  }, 15_000);
});
