import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
import { createSessionReconciliationSink } from
  "../../../orch-server-ts/src/node/session_reconciliation_sink.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from
  "./full_schema_postgres_harness.js";

// Promoted from diagnostic c850932e: real COMMIT ordering, canonical schema/FKs.
describe("server-request startup inventory snapshot", () => {
  let harness: FullSchemaPostgresHarness;
  beforeAll(async () => { harness = await createFullSchemaPostgresHarness(); }, 45_000);
  afterAll(async () => { await harness.cleanup(); }, 15_000);

  it("preserves post-snapshot creation in reconciliation-first and registration-first order", async () => {
    for (const order of ["reconciliation-first", "registration-first"] as const) {
      const nodeId = `node-${order}`;
      const sessionId = `session-${order}`;
      const repository = new SessionMutationRepository(harness.sql);
      const reconcile = vi.spyOn(repository, "reconcileNodeStartup");
      let deliver!: (value: { requestId: string; runningSessionIds: string[] }) => void;
      const response = new Promise<{ requestId: string; runningSessionIds: string[] }>((resolve) => { deliver = resolve; });
      const request = vi.fn(() => response);
      const errors: unknown[] = [];
      const sink = createSessionReconciliationSink({
        repositoryProvider: async () => repository,
        requestSessionInventory: request,
        getConnectedNode: () => ({ connectionId: "generation-1" }),
        now: () => new Date("2026-10-01T21:26:29.817Z"),
        logError: (error) => { errors.push(error); },
      });
      sink([{ type: "node_registered", nodeId, connectionId: "generation-1" }]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce()); // snapshot COMMIT/read finished before SEND
      expect(request).toHaveBeenCalledWith(nodeId, "generation-1");
      await repository.registerSession({
        idempotencyKey: `create-${sessionId}`, sessionId, nodeId, agentId: "worker",
        claudeSessionId: null, sessionType: "claude", prompt: "ordering regression",
        clientId: null, status: "initializing", modelPreset: null,
        createdAt: new Date("2026-10-01T21:26:29.755Z"),
        updatedAt: new Date("2026-10-01T21:26:29.755Z"),
        callerSessionId: null, predecessorSessionId: null,
      });
      const peer = harness.createPeer();
      const register = () => peer.begin(async (sql) => await sql`
        SELECT * FROM session_record_execution_registration(
          ${sessionId}, ${`registration-${order}`}, ${`command-${order}`},
          'not_required', NULL, FALSE, ${new Date("2026-10-01T21:26:30.770Z")}
        )
      `);
      let application;
      if (order === "registration-first") application = await register();
      deliver({ requestId: "requested-inventory", runningSessionIds: [] });
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
      const reconciliation = await reconcile.mock.results[0]!.value; // real reconciliation COMMIT
      if (order === "reconciliation-first") application = await register();
      await sink.close();
      expect(errors).toEqual([]);
      expect(reconciliation).toMatchObject({ interrupted: 0, restored: 0 });
      expect(application![0]).toMatchObject({ applied: true, status: "running" });
      expect(await harness.sql`SELECT status, termination_detail FROM sessions WHERE session_id = ${sessionId}`)
        .toEqual([{ status: "running", termination_detail: null }]);
    }
  }, 60_000);

  it("cleans unchanged absences, but excludes later creation, revision changes and new registrations", async () => {
    const nodeId = "node-revisions";
    await harness.sql`
      INSERT INTO sessions(session_id, node_id, session_type, status, updated_at,
                           execution_registration_id, execution_command_id)
      VALUES
        ('unchanged', ${nodeId}, 'claude', 'initializing', '2026-10-01 00:00:00.123456+00', NULL, NULL),
        ('changed', ${nodeId}, 'claude', 'running', '2026-10-01 00:00:00.123456+00', NULL, NULL),
        ('registered', ${nodeId}, 'claude', 'running', '2026-10-01 00:00:00.123+00', 'old-reg', 'old-command')
    `;
    const repository = new SessionMutationRepository(harness.sql);
    const targets = await repository.captureNodeStartupTargets(nodeId);
    expect(targets.find((target) => target.sessionId === "unchanged")?.updatedAt).toContain(".123456");
    await harness.sql`UPDATE sessions SET updated_at = '2026-10-01 00:00:00.123457+00' WHERE session_id = 'changed'`;
    await harness.sql`
      INSERT INTO sessions(session_id, node_id, session_type, status)
      VALUES ('later-created', ${nodeId}, 'claude', 'initializing')
    `;
    // Same status and exact timestamp: registration identity must independently fence the snapshot.
    const registration = await harness.sql`
      SELECT * FROM session_record_execution_registration(
        'registered', 'new-reg', 'new-command', 'not_required', NULL, FALSE,
        '2026-10-01 00:00:00.123+00'
      )
    `;
    expect(registration[0]?.applied).toBe(true);
    expect(await repository.reconcileNodeStartup(nodeId, [], new Date("2026-10-02T00:00:00Z"), targets))
      .toMatchObject({ interrupted: 1, updates: [expect.objectContaining({ sessionId: "unchanged" })] });
    expect(await harness.sql`SELECT session_id, status FROM sessions WHERE node_id = ${nodeId} ORDER BY session_id`)
      .toEqual([
        { session_id: "changed", status: "running" },
        { session_id: "later-created", status: "initializing" },
        { session_id: "registered", status: "running" },
        { session_id: "unchanged", status: "interrupted" },
      ]);
  }, 60_000);

  it("uses unsolicited inventory only for the existing receipt-free active restoration", async () => {
    const nodeId = "node-unsolicited";
    await harness.sql`
      INSERT INTO sessions(session_id, node_id, session_type, status, termination_reason, termination_detail, updated_at)
      VALUES
        ('absent-unrequested', ${nodeId}, 'claude', 'initializing', NULL, NULL, '2026-10-01'),
        ('live-unrequested', ${nodeId}, 'claude', 'interrupted', 'killed', 'node_disconnect', '2026-10-01')
    `;
    const repository = new SessionMutationRepository(harness.sql);
    const result = await repository.reconcileNodeStartup(nodeId, ['live-unrequested'], new Date("2026-10-02"));
    expect(result).toMatchObject({ interrupted: 0, restored: 1 });
    expect(await harness.sql`SELECT status FROM sessions WHERE session_id = 'absent-unrequested'`)
      .toEqual([{ status: "initializing" }]);
  }, 60_000);
});
