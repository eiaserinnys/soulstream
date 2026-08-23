import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ABSENT_PID = 2_147_483_647;

export function createStrandedDeliveryMutation() {
  return {
    invariant: "stranded_delivery",
    what: "an old delivered row whose open owner has stopped advancing",
    identity: (planted) => planted.deliveryId,
    control: {
      what: "an old delivered row remains legitimate while its owner emits fresh progress",
      identity: (planted) => planted.deliveryId,
      async inject(context) {
        return await plantOwnedDelivery(context, {
          kind: "progressing-target",
          pid: process.pid,
          progressAt: new Date().toISOString(),
        });
      },
      revert: revertOwnedDelivery,
    },
    async inject(context) {
      return await plantOwnedDelivery(context, {
        kind: "orphaned-target",
        pid: ABSENT_PID,
        progressAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
    },
    revert: revertOwnedDelivery,
  };
}

async function plantOwnedDelivery(context, { kind, pid, progressAt }) {
  const sessionId = context.id(kind);
  const deliveryId = context.id(`${kind}-delivered`);
  const directory = join(context.runtime.runnerStateDirectory, sessionId);
  await context.sql(`
    INSERT INTO sessions (session_id, status, node_id, session_type, created_at, updated_at)
    VALUES ('${sessionId}', 'running', 'eias-lab', 'claude', NOW(), NOW())
  `);
  await context.sql(`
    INSERT INTO session_execution_ownerships (
      session_id, ownership_generation, owner_kind, manifest_id,
      registration_id, pid, start_identity, execution_command_id,
      phase, identity_proven_at, activated_at
    ) VALUES (
      '${sessionId}', 1, 'runner_process', 'lab-mutation-manifest',
      '${sessionId}-registration', ${pid}, '${sessionId}-identity',
      '${sessionId}-command', 'active', NOW(), NOW()
    )
  `);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "runner-lifecycle.json"),
    JSON.stringify({ session_id: sessionId, execution_state: "running", progress_at: progressAt }),
    { mode: 0o600 },
  );
  await context.insertDelivery(deliveryId, {
    state: "delivered",
    aggregateState: "delivered",
    targetSessionId: sessionId,
    extraColumns: ", delivered_at",
    extraValues: ", NOW() - INTERVAL '10 minutes'",
  });
  return { sessionId, deliveryId, directory, pid, progressAt };
}

async function revertOwnedDelivery(context, planted) {
  await context.sql(`DELETE FROM session_deliveries WHERE delivery_id = '${planted.deliveryId}'`);
  await context.sql(`DELETE FROM sessions WHERE session_id = '${planted.sessionId}'`);
  await rm(planted.directory, { recursive: true, force: true });
}
