import { randomUUID } from "node:crypto";
import type {
  CandidateSnapshot,
  OrchestrationCandidate,
  OrchestrationDecision,
} from "@soulstream/wire-schema/card-orchestration";
import type { SqlClient, RepositorySql } from "./control_plane/card_types.js";
export type OrchestrationRun = {
  id: string;
  policy_version: number;
  input_hash: string;
  snapshot: CandidateSnapshot[];
  target: OrchestrationCandidate;
  session_id: string;
  execution_token: string;
  lease_token: string;
  state:
    "reserved" | "judging" | "decided" | "completed" | "blocked" | "cancelled";
  decision: OrchestrationDecision | null;
  execution_claimed: boolean;
  instructions_revision?: string | null;
  input_context?: Record<string, unknown>;
};
export type WorkerDispatch = {
  run_id: string;
  card_id: string;
  session_id: string;
  node_id: string;
  input: Record<string, unknown>;
  state: string;
  launch_token: string;
  launch_accepted: boolean;
  expired?: boolean;
};
export class CardOrchestrationRepository {
  constructor(private readonly resolveSql: () => Promise<SqlClient>) {}
  async enabled() {
    const sql = await this.resolveSql();
    return (
      (
        await sql<
          { enabled: boolean }[]
        >`SELECT (value->>'enabled')::boolean AS enabled FROM system_settings WHERE setting_key='card_orchestration'`
      )[0]?.enabled === true
    );
  }
  async status() {
    const sql = await this.resolveSql();
    const state = (
      await sql`SELECT state,reason,resolved_folder_id AS "resolvedFolderId" FROM card_orchestration_state WHERE id=TRUE`
    )[0];
    const runs =
      await sql`SELECT 'card_orchestration_decision' AS purpose,id AS "runId",session_id AS "sessionId",state,reason,target,instructions_revision AS "instructionsRevision",created_at AS "createdAt" FROM card_orchestration_runs ORDER BY created_at DESC LIMIT 20`;
    const pendingWorkers =
      await sql`SELECT run_id AS "runId",card_id AS "cardId",session_id AS "sessionId",node_id AS "nodeId",state,CASE WHEN launch_accepted AND launch_deadline<=NOW() THEN 'worker_launch_accepted_observation_pending' ELSE reason END AS reason,launch_accepted AS "accepted",launch_deadline AS "deadline" FROM card_orchestration_dispatches WHERE state IN ('admitted','launching') ORDER BY created_at`;
    return {
      ...state,
      ...(pendingWorkers.some(
        (w) => w.reason === "worker_launch_accepted_observation_pending",
      )
        ? {
            state: "blocked",
            reason: "worker_launch_accepted_observation_pending",
          }
        : {}),
      runs,
      pendingWorkers,
    };
  }
  async note(state: string, reason: string | null) {
    const sql = await this.resolveSql();
    await sql`UPDATE card_orchestration_state SET state=${state},reason=${reason},updated_at=NOW() WHERE id=TRUE`;
  }
  async ownsSession(id: string) {
    const sql = await this.resolveSql();
    return (
      (await sql`SELECT id FROM card_orchestration_runs WHERE session_id=${id}`)
        .length > 0
    );
  }
  async isDuplicate(inputHash: string) {
    const sql = await this.resolveSql();
    return (
      (
        await sql<
          { hash: string | null }[]
        >`SELECT last_decision_input_hash AS hash FROM card_orchestration_state WHERE id=TRUE`
      )[0]?.hash === inputHash
    );
  }
  async claim(input: {
    inputHash: string;
    policyVersion: number;
    snapshot: CandidateSnapshot[];
    target: OrchestrationCandidate;
    instructionsRevision?: string;
    context?: Record<string, unknown>;
  }): Promise<OrchestrationRun | null> {
    const sql = await this.resolveSql();
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM card_orchestration_state WHERE id=TRUE FOR UPDATE`;
      const duplicate = (
        await tx<
          { hash: string | null }[]
        >`SELECT last_decision_input_hash AS hash FROM card_orchestration_state WHERE id=TRUE`
      )[0];
      if (duplicate?.hash === input.inputHash) return null;
      const active = (
        await tx<
          (OrchestrationRun & { expired: boolean })[]
        >`SELECT *,lease_expires_at<=NOW() AS expired FROM card_orchestration_runs WHERE state IN ('reserved','judging','decided') FOR UPDATE`
      )[0];
      if (active) {
        if (!active.expired) return null;
        return (
          await tx<
            OrchestrationRun[]
          >`UPDATE card_orchestration_runs SET lease_token=${randomUUID()},lease_expires_at=NOW()+INTERVAL '45 seconds',updated_at=NOW() WHERE id=${active.id} RETURNING *`
        )[0]!;
      }
      const prior = (
        await tx<
          { ready: boolean; attempt: number }[]
        >`SELECT retry_after<=NOW() AS ready,attempt FROM card_orchestration_runs WHERE input_hash=${input.inputHash} AND target=${tx.json(input.target)} AND state='blocked' ORDER BY created_at DESC LIMIT 1`
      )[0];
      if (prior && (!prior.ready || prior.attempt >= 3)) return null;
      const id = randomUUID(),
        token = randomUUID();
      const rows = await tx<
        OrchestrationRun[]
      >`INSERT INTO card_orchestration_runs(id,policy_version,input_hash,snapshot,input_context,target,session_id,execution_token,lease_token,lease_expires_at,state,attempt,instructions_revision)
    VALUES(${id},${input.policyVersion},${input.inputHash},${tx.json(input.snapshot)},${tx.json(input.context ?? {})},${tx.json(input.target)},${randomUUID()},${token},${token},NOW()+INTERVAL '45 seconds','reserved',${(prior?.attempt ?? 0) + 1},${input.instructionsRevision ?? null}) RETURNING *`;
      await tx`UPDATE card_orchestration_state SET state='judging',reason=NULL,updated_at=NOW() WHERE id=TRUE`;
      return rows[0]!;
    });
  }
  async renew(run: OrchestrationRun) {
    const sql = await this.resolveSql();
    return (
      (
        await sql<
          OrchestrationRun[]
        >`UPDATE card_orchestration_runs SET lease_expires_at=NOW()+INTERVAL '45 seconds',updated_at=NOW() WHERE id=${run.id} AND lease_token=${run.lease_token} AND lease_expires_at>NOW() AND state IN ('reserved','judging','decided') RETURNING *`
      )[0] ?? null
    );
  }
  async unavailableTargets(inputHash: string) {
    const sql = await this.resolveSql();
    return (
      await sql<
        { target: OrchestrationCandidate }[]
      >`SELECT DISTINCT ON (target) target FROM card_orchestration_runs WHERE input_hash=${inputHash} AND state='blocked' AND (retry_after>NOW() OR attempt>=3)`
    ).map((r) => r.target);
  }
  async workExpired(run: OrchestrationRun, hasSession: boolean) {
    const sql = await this.resolveSql();
    return (
      (
        await sql<
          { expired: boolean }[]
        >`SELECT created_at+CASE WHEN ${hasSession} THEN INTERVAL '10 minutes' ELSE INTERVAL '2 minutes' END<NOW() AS expired FROM card_orchestration_runs WHERE id=${run.id}`
      )[0]?.expired === true
    );
  }
  async active() {
    const sql = await this.resolveSql();
    return (
      (
        await sql<
          OrchestrationRun[]
        >`SELECT * FROM card_orchestration_runs WHERE state IN ('reserved','judging','decided') ORDER BY created_at LIMIT 1`
      )[0] ?? null
    );
  }
  async prepareLaunch(run: OrchestrationRun) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`UPDATE card_orchestration_runs SET state='judging',updated_at=NOW() WHERE id=${run.id} AND state='reserved' AND lease_token=${run.lease_token} AND lease_expires_at>NOW() RETURNING id`
      ).length > 0
    );
  }
  async authorize(input: {
    runId: string;
    sessionId: string;
    executionToken: string;
    nodeId: string;
  }) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`UPDATE card_orchestration_runs r SET execution_claimed=TRUE,updated_at=NOW()
   FROM system_settings s WHERE r.id=${input.runId} AND r.session_id=${input.sessionId} AND r.execution_token=${input.executionToken}
    AND r.target->>'nodeId'=${input.nodeId} AND r.state='judging' AND NOT r.execution_claimed
    AND s.setting_key='card_orchestration' AND (s.value->>'enabled')::boolean AND s.version=r.policy_version RETURNING r.id`
      ).length > 0
    );
  }
  async session(run: OrchestrationRun) {
    const sql = await this.resolveSql();
    return (
      (
        await sql<
          {
            status: string;
            last_assistant_text: string | null;
            termination_event_id: number | null;
            metadata: unknown;
          }[]
        >`SELECT status,last_assistant_text,termination_event_id,metadata FROM sessions WHERE session_id=${run.session_id}`
      )[0] ?? null
    );
  }
  async decide(
    run: OrchestrationRun,
    decision: OrchestrationDecision,
    eventId: number,
    revision: string,
  ) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`UPDATE card_orchestration_runs SET state='decided',decision=${sql.json(decision)},decision_event_id=${eventId},instructions_revision=${revision},updated_at=NOW() WHERE id=${run.id} AND lease_token=${run.lease_token} AND lease_expires_at>NOW() AND state='judging' RETURNING id`
      ).length > 0
    );
  }
  async finish(
    run: OrchestrationRun,
    state: "completed" | "blocked" | "cancelled",
    reason: string | null,
  ) {
    const sql = await this.resolveSql();
    await sql.begin(async (tx) => {
      const changed =
        await tx`UPDATE card_orchestration_runs SET state=${state},reason=${reason},retry_after=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=${run.id} AND lease_token=${run.lease_token} AND lease_expires_at>NOW() RETURNING id`;
      if (!changed.length) return;
      await tx`UPDATE card_orchestration_state SET state=${state},reason=${reason},last_decision_input_hash=CASE WHEN ${state}='completed' THEN ${run.input_hash} ELSE last_decision_input_hash END,updated_at=NOW() WHERE id=TRUE`;
    });
  }
  async reserveFolder(parentId: string | null) {
    const sql = await this.resolveSql();
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM card_orchestration_state WHERE id=TRUE FOR UPDATE`;
      const s = (
        await tx<
          {
            provision_id: string | null;
            provision_request: { parentFolderId: string | null } | null;
            resolved_folder_id: string | null;
          }[]
        >`SELECT provision_id,provision_request,resolved_folder_id FROM card_orchestration_state WHERE id=TRUE`
      )[0]!;
      if (s.provision_id || s.resolved_folder_id) return s;
      const id = randomUUID(),
        request = { parentFolderId: parentId };
      await tx`UPDATE card_orchestration_state SET provision_id=${id},provision_request=${tx.json(request)},updated_at=NOW() WHERE id=TRUE`;
      return { ...s, provision_id: id, provision_request: request };
    });
  }
  async publishFolder(id: string) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`UPDATE card_orchestration_state SET resolved_folder_id=${id},updated_at=NOW() WHERE id=TRUE AND provision_id=${id} AND resolved_folder_id IS NULL RETURNING id`
      ).length > 0
    );
  }
  async pendingWorkers() {
    const sql = await this.resolveSql();
    return sql<
      WorkerDispatch[]
    >`SELECT *,launch_deadline<=NOW() AS expired FROM card_orchestration_dispatches WHERE state IN ('admitted','launching') ORDER BY created_at`;
  }
  async claimWorker(id: string) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`UPDATE card_orchestration_dispatches SET state='launching',updated_at=NOW() WHERE session_id=${id} AND state='admitted' RETURNING session_id`
      ).length > 0
    );
  }
  async workerState(
    id: string,
    state: "running" | "rejected",
    reason: string | null = null,
  ) {
    const sql = await this.resolveSql();
    await sql`UPDATE card_orchestration_dispatches SET state=${state},reason=${reason},updated_at=NOW() WHERE session_id=${id} AND state IN ('admitted','launching')`;
  }
  async authorizeWorker(input: {
    runId: string;
    sessionId: string;
    executionToken: string;
    nodeId: string;
    cardId: string;
  }) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`UPDATE card_orchestration_dispatches d SET launch_accepted=TRUE,updated_at=NOW() FROM cards c,system_settings p,card_orchestration_runs r WHERE p.setting_key='card_orchestration' AND (p.value->>'enabled')::boolean AND r.id=d.run_id AND r.policy_version=p.version AND d.run_id=${input.runId} AND d.session_id=${input.sessionId} AND d.card_id=${input.cardId} AND d.node_id=${input.nodeId} AND d.launch_token=${input.executionToken} AND d.state='launching' AND d.launch_deadline>NOW() AND NOT d.launch_accepted AND c.id=d.card_id AND c.status='running' RETURNING d.session_id`
      ).length > 0
    );
  }
  async workerObserved(id: string) {
    const sql = await this.resolveSql();
    return (
      (
        await sql`SELECT s.session_id FROM sessions s JOIN card_orchestration_dispatches d ON d.session_id=s.session_id AND d.state IN ('admitted','launching') WHERE s.session_id=${id} AND (COALESCE((d.input->>'resume')::boolean,FALSE)=FALSE OR s.status NOT IN ('completed','error','interrupted') OR s.termination_event_id IS DISTINCT FROM (d.input->>'priorTerminationEventId')::bigint)`
      ).length > 0
    );
  }
}
/** Card lock, run fencing and node capacity admission are in the same mutation transaction. */
export async function assertPolicyAdmission(
  sql: RepositorySql,
  input: {
    runId: string;
    leaseToken: string;
    sessionId: string;
    nodeId: string;
    cardId: string;
    cardVersion: number;
    workerInput: Record<string, unknown>;
  },
) {
  const policy = (
    await sql<
      { version: number; enabled: boolean }[]
    >`SELECT version,(value->>'enabled')::boolean AS enabled FROM system_settings WHERE setting_key='card_orchestration' FOR SHARE`
  )[0];
  if (!policy?.enabled) throw new Error("Orchestration policy is disabled");
  const run = (
    await sql<
      OrchestrationRun[]
    >`SELECT * FROM card_orchestration_runs WHERE id=${input.runId} AND state='decided' AND lease_token=${input.leaseToken} AND lease_expires_at>NOW() FOR UPDATE`
  )[0];
  if (
    !run ||
    run.policy_version !== policy.version ||
    !run.decision?.decisions.some(
      (d) =>
        d.cardId === input.cardId &&
        d.cardVersion === input.cardVersion &&
        d.action === "run",
    )
  )
    throw new Error("Stale orchestration admission");
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"card_capacity:" + input.nodeId},0))`;
  const capacity = (
    await sql<
      { limit: number }[]
    >`SELECT COALESCE((value->'nodeConcurrency'->>${input.nodeId})::int,(value->'nodeConcurrency'->>'default')::int) AS limit FROM system_settings WHERE setting_key='card_dispatch' FOR SHARE`
  )[0]?.limit;
  if (capacity === undefined) throw new Error("Missing node capacity");
  const used =
    (
      await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM folder_operations op JOIN cards c ON c.id=op.target_id LEFT JOIN sessions s ON s.session_id=op.payload_json->>'session_id' AND s.card_id=c.id WHERE op.operation_type='dispatch_card' AND op.payload_json->>'node_id'=${input.nodeId} AND (s.status NOT IN ('completed','error','interrupted') OR s.session_id IS NULL AND c.status='running' AND op.id=(SELECT latest.id FROM folder_operations latest WHERE latest.target_id=c.id AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id AND r.operation_type='resume_card' AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))`
    )[0]?.count ?? 0;
  if (used >= capacity) throw new Error("Node capacity is full");
  const valid =
    await sql`SELECT c.id FROM cards c JOIN folders f ON f.id=c.folder_id WHERE c.id=${input.cardId} AND NOT c.archived AND NOT f.archived AND c.assignee_kind<>'human' AND c.assignee_agent_id=${String(input.workerInput.agentId)} AND COALESCE(c.node_id,'eiaserinnys')=${input.nodeId} AND c.model_preset IS NOT DISTINCT FROM ${input.workerInput.configuredModelPreset ?? null} AND NOT EXISTS(SELECT 1 FROM card_questions q WHERE q.card_id=c.id AND q.answer IS NULL)`;
  if (!valid.length) throw new Error("Card is no longer eligible");
  await sql`INSERT INTO card_orchestration_dispatches(run_id,card_id,session_id,node_id,input,launch_token,state) VALUES(${input.runId},${input.cardId},${input.sessionId},${input.nodeId},${sql.json(input.workerInput)},${randomUUID()},'admitted')`;
}
