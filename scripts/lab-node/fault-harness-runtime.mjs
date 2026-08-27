import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  countMatchingTimelineEvents,
  redactEvidenceLine,
} from "./fault-harness-contract.mjs";
import {
  installObservedAdoptionWindow,
  removeObservedAdoptionWindow,
  waitForObservedAdoptionWindow,
} from "./fault-harness-adoption-window.mjs";
import { EvidenceRecorder } from "./fault-harness-evidence.mjs";
import { LabDeliveryRuntime } from "./fault-harness-runtime-delivery.mjs";

const execFileAsync = promisify(execFile);
const TERMINAL_SESSION_STATES = new Set([
  "completed",
  "failed",
  "error",
  "interrupted",
  "cancelled",
  "killed",
]);

export class LabRuntime {
  constructor(env = process.env) {
    this.root = requireEnv(env, "LAB_ROOT");
    this.repo = requireEnv(env, "LAB_REPO");
    this.orchPort = requirePort(env, "LAB_ORCH_PORT", [5200]);
    this.nodePort = requirePort(env, "LAB_NODE_PORT", [3105]);
    this.container = requireEnv(env, "LAB_POSTGRES_CONTAINER");
    this.database = requireEnv(env, "LAB_POSTGRES_DB");
    this.databaseUser = requireEnv(env, "LAB_POSTGRES_USER");
    this.bearerToken = requireEnv(env, "LAB_AUTH_BEARER_TOKEN");
    this.interventionAcceptanceTimeoutMs = requirePositiveInteger(
      env,
      "LAB_INTERVENTION_ACCEPTANCE_TIMEOUT_MS",
    );
    this.labSecrets = [
      this.bearerToken,
      env.LAB_POSTGRES_PASSWORD,
      env.LAB_JWT_SECRET,
    ].filter(Boolean);
    if (this.root !== "/home/eias/services/soulstream-lab") {
      throw new Error(`unsafe LAB_ROOT: ${this.root}`);
    }
    if (this.repo !== join(this.root, "repo")) {
      throw new Error(`unsafe LAB_REPO: ${this.repo}`);
    }
    if (!this.container.startsWith("soulstream-lab-")) {
      throw new Error(`unsafe lab postgres container: ${this.container}`);
    }
    this.apiBase = `http://127.0.0.1:${this.orchPort}`;
    this.stateDirectory = join(this.root, "state", "fault-harness");
    this.runnerStateDirectory = join(this.root, "runner-state");
    this.nodeLog = join(this.root, "logs", "node.log");
    this.orchLog = join(this.root, "logs", "orch.log");
    this.deliveries = new LabDeliveryRuntime(this);
  }

  async createRun(command, provenance) {
    const runId = `${command}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    const directory = join(this.stateDirectory, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new EvidenceRecorder(this, runId, directory, provenance);
  }

  /**
   * Requires a *new* node connection after we deliberately stopped one.
   *
   * `/api/nodes` only lists connected nodes and `status` is the same boolean,
   * so asking for either proves nothing across a restart: the previous
   * connection is still listed for as long as orch has not noticed it go.
   * Three runs were lost to `503 NO_AVAILABLE_NODE` that way. The connection
   * id is what actually changes, so a restart waits for a different one.
   */
  expectFreshNodeConnection() {
    this.staleConnectionId = this.lastConnectionId;
  }

  async assertReady() {
    await this.waitForHttp(`${this.apiBase}/api/health`, 30_000);
    await this.waitForHttp(`http://127.0.0.1:${this.nodePort}/health`, 30_000);
    await this.waitForNodeRegistration(30_000);
  }

  async assertProvenance() {
    const manifest = await this.currentManifest();
    const gitOptions = { timeout: 10_000, maxBuffer: 1024 * 1024 };
    const [checkout, originMain, fetchRefspecs] = await Promise.all([
      execFileAsync("git", ["-C", this.repo, "rev-parse", "HEAD"], gitOptions),
      execFileAsync(
        "git",
        ["-C", this.repo, "rev-parse", "refs/remotes/origin/main"],
        gitOptions,
      ),
      execFileAsync(
        "git",
        ["-C", this.repo, "config", "--get-all", "remote.origin.fetch"],
        gitOptions,
      ),
    ]);
    const checkoutCommit = checkout.stdout.trim();
    const refspecs = fetchRefspecs.stdout.trim().split("\n").filter(Boolean);
    assertMatchingProvenance(manifest.sourceCommit, checkoutCommit);
    assertFetchRefspecCoversMain(refspecs);
    return {
      checkoutCommit,
      bundleSourceCommit: manifest.sourceCommit,
      originMainCommit: originMain.stdout.trim(),
      fetchRefspecs: refspecs,
      releaseManifestId: manifest.manifestId,
      releaseCohortId: manifest.releaseCohortId,
    };
  }

  async fixtureResidue() {
    const central = await this.psqlOne(`
      SELECT json_build_object(
        'nonterminalSessions', (
          SELECT COALESCE(json_agg(json_build_object(
            'session_id', session_id,
            'status', status
          ) ORDER BY session_id), '[]'::json)
          FROM sessions
          WHERE status NOT IN (
            'completed', 'failed', 'error', 'interrupted', 'cancelled', 'killed'
          )
        ),
        'openOwnerships', (
          SELECT COALESCE(json_agg(json_build_object(
            'session_id', session_id,
            'ownership_generation', ownership_generation,
            'phase', phase
          ) ORDER BY session_id, ownership_generation), '[]'::json)
          FROM session_execution_ownerships
          WHERE phase IN ('reserved', 'identity_proven', 'active')
        )
      )
    `);
    return {
      nonterminalSessions: central?.nonterminalSessions ?? [],
      openOwnerships: central?.openOwnerships ?? [],
      runnerProcesses: await ownedRunnerProcesses(this.root),
    };
  }

  async createSession(prompt, extra = {}) {
    const body = await this.postJson("/api/sessions", {
      profile: "lab-claude",
      model_preset: "claude-sonnet",
      prompt,
      caller_info: {
        source: "agent",
        agent_node: "eias-lab",
        agent_id: "lab-fault-harness",
        agent_name: "Lab fault harness",
        display_name: "Lab fault harness",
      },
      ...extra,
    });
    if (!isUuid(body.agentSessionId)) throw new Error("create session returned no UUID");
    return body.agentSessionId;
  }

  async intervene(sessionId, body) {
    assertIdentifier(sessionId, "session id");
    return await this.postJson(
      `/api/sessions/${sessionId}/intervene`,
      body,
      this.interventionAcceptanceTimeoutMs,
    );
  }

  async interrupt(sessionId) {
    assertIdentifier(sessionId, "session id");
    return await this.postJson(`/api/sessions/${sessionId}/interrupt`, {});
  }

  async postJson(path, body, timeoutMs = 30_000) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`lab request failed: HTTP ${response.status}: ${redactEvidenceLine(text, this.labSecrets)}`);
    }
    return text.length === 0 ? {} : JSON.parse(text);
  }

  async getJson(path, timeoutMs = 30_000) {
    const response = await fetch(`${this.apiBase}${path}`, {
      headers: { authorization: `Bearer ${this.bearerToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`lab query failed: HTTP ${response.status}`);
    return JSON.parse(text);
  }

  /**
   * Waits for the marker, and says what it actually saw if it never arrives.
   *
   * This used to swallow every read error, so a timeline call that failed for
   * the whole window was indistinguishable from an assistant that never
   * answered. Four F9 runs were recorded as lost turns whose markers were in
   * the database three seconds after the prompt -- the run was red, and the
   * red said nothing about which side had failed.
   */
  async waitForMarker(sessionId, marker, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    let reads = 0;
    let lastError;
    while (Date.now() < deadline) {
      polls += 1;
      try {
        const timeline = await this.timeline(sessionId);
        reads += 1;
        if (countMatchingTimelineEvents(timeline, "assistant_message", marker) > 0) {
          return timeline;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(1_000);
    }
    throw new Error(
      `assistant marker not observed: ${marker}`
      + ` (polls=${polls}, timeline reads=${reads}`
      + `${lastError ? `, last read error: ${lastError.message}` : ""})`,
    );
  }

  async countTimelineText(sessionId, text) {
    const timeline = await this.timeline(sessionId);
    return (timeline.messages ?? []).filter(
      (message) => JSON.stringify(message.payload ?? {}).includes(text),
    ).length;
  }

  async countTimelineEvents(sessionId, eventType, text) {
    const timeline = await this.timeline(sessionId);
    return countMatchingTimelineEvents(timeline, eventType, text);
  }

  async timeline(sessionId) {
    assertIdentifier(sessionId, "session id");
    return await this.getJson(`/api/sessions/${sessionId}/timeline?limit=200`);
  }

  async waitForTerminal(sessionId, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.sessionStatus(sessionId);
      if (TERMINAL_SESSION_STATES.has(status)) return status;
      await delay(1_000);
    }
    throw new Error(`session did not reach terminal state: ${sessionId}`);
  }

  async sessionStatus(sessionId) {
    const row = await this.psqlOne(`
      SELECT json_build_object('status', status)
      FROM sessions WHERE session_id = ${sqlLiteral(sessionId)}
    `);
    return typeof row?.status === "string" ? row.status : "";
  }

  async waitForRunner(sessionId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const config = await this.runnerConfig(sessionId);
        const pid = await this.runnerPid(sessionId);
        await assertProcess(pid, "runner_entry.js");
        return { pid, config };
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    throw new Error(`runner did not appear for ${sessionId}`, { cause: lastError });
  }

  async runnerPid(sessionId) {
    const value = Number((await readFile(join(this.runnerDirectory(sessionId), "runner.pid"), "utf8")).trim());
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid runner pid");
    return value;
  }

  async runnerConfig(sessionId) {
    const value = JSON.parse(await readFile(
      join(this.runnerDirectory(sessionId), "runner-config.json"),
      "utf8",
    ));
    return {
      sessionId: value.sessionId,
      releaseManifestId: value.releaseManifestId,
      runtimeEnvIdentity: value.runtimeEnvIdentity,
      codeSha: value.codeSha,
    };
  }

  runnerDirectory(sessionId) {
    assertIdentifier(sessionId, "session id");
    const slug = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    return join(this.runnerStateDirectory, slug);
  }

  async killRunner(sessionId) {
    const pid = await this.runnerPid(sessionId);
    await this.killRunnerPid(pid, "SIGKILL");
    return pid;
  }

  async killRunnerPid(pid, signal = "SIGTERM") {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      throw new Error(`unsafe runner pid: ${pid}`);
    }
    await assertProcess(pid, "runner_entry.js");
    process.kill(pid, signal);
    await waitForExit(pid, signal === "SIGKILL" ? 5_000 : 30_000);
    return pid;
  }

  async writeRunnerPidEvidence(sessionId, pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid injected pid evidence");
    await writeFile(
      join(this.runnerDirectory(sessionId), "runner.pid"),
      `${pid}\n`,
      { mode: 0o600 },
    );
  }

  forceRunnerLifecycleTerminal(sessionId, state = "completed") {
    if (!new Set(["completed", "failed", "closed"]).has(state)) {
      throw new Error(`invalid injected runner terminal state: ${state}`);
    }
    const database = new DatabaseSync(
      join(this.runnerDirectory(sessionId), "runner.sqlite"),
    );
    try {
      const at = new Date().toISOString();
      const terminalError = state === "failed"
        ? JSON.stringify({
            code: "lab_injected_runner_failure",
            message: "lab injected terminal runner recovery",
          })
        : null;
      const result = database.prepare(`
        UPDATE runner_event_outbox
           SET execution_state = ?, progress_seq = progress_seq + 1,
               progress_at = ?, liveness_at = ?, in_flight_tools_json = '[]',
               terminal_error_json = ?
         WHERE record_kind = 'bootstrap'
      `).run(state, at, at, terminalError);
      if (result.changes !== 1) {
        throw new Error(`runner lifecycle injection changed ${result.changes} rows`);
      }
      return { state, at };
    } finally {
      database.close();
    }
  }

  async waitForNodeLog(sessionId, message, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await readFile(this.nodeLog, "utf8");
      if (log.split("\n").some(
        (line) => line.includes(sessionId) && line.includes(message),
      )) return;
      await delay(500);
    }
    throw new Error(`node log did not report ${message} for ${sessionId}`);
  }

  async nodeLogOffset() {
    return (await stat(this.nodeLog)).size;
  }

  async waitForRunnerOperationStateSince(
    sessionId,
    offset,
    expectedActive,
    timeoutMs = 75_000,
  ) {
    assertIdentifier(sessionId, "session id");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`invalid node log offset: ${offset}`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await readFile(this.nodeLog);
      const from = offset <= log.length ? offset : 0;
      const snapshots = runnerOperationSnapshots(log.subarray(from).toString("utf8"));
      const match = snapshots.find((snapshot) => (
        snapshot.activeRunnerOperations.some(
          (operation) => operation?.sessionId === sessionId,
        ) === expectedActive
      ));
      if (match) return match;
      await delay(500);
    }
    const state = expectedActive ? "active" : "absent";
    throw new Error(
      `node operation snapshot did not show ${sessionId} as ${state} after log offset ${offset}`,
    );
  }

  async waitForExecutionOwnershipTransitionSince(
    sessionId,
    offset,
    operation,
    timeoutMs = 75_000,
  ) {
    assertIdentifier(sessionId, "session id");
    if (!["acquire", "release"].includes(operation)) {
      throw new Error(`invalid execution ownership operation: ${operation}`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`invalid node log offset: ${offset}`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await readFile(this.nodeLog);
      const from = offset <= log.length ? offset : 0;
      const transitions = executionOwnershipTransitions(
        log.subarray(from).toString("utf8"),
      );
      const match = transitions.find((transition) => (
        transition.sessionId === sessionId
        && transition.operation === operation
        && transition.applied === true
      ));
      if (match) return match;
      await delay(500);
    }
    throw new Error(
      `node log did not show applied execution ${operation} for ${sessionId} after offset ${offset}`,
    );
  }

  async waitForEventIngressDeadLetterSince(
    sessionId,
    sourceSeq,
    offset,
    timeoutMs = 75_000,
  ) {
    assertIdentifier(sessionId, "session id");
    if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) {
      throw new Error(`invalid event ingress source sequence: ${sourceSeq}`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`invalid node log offset: ${offset}`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await readFile(this.nodeLog);
      const from = offset <= log.length ? offset : 0;
      const deadLetter = eventIngressDeadLetters(
        log.subarray(from).toString("utf8"),
      ).find((candidate) => (
        candidate.sessionId === sessionId && candidate.sourceSeq === sourceSeq
      ));
      if (deadLetter) return deadLetter;
      await delay(500);
    }
    throw new Error(
      `node log did not show event ingress dead-letter for ${sessionId}:${sourceSeq} `
      + `after offset ${offset}`,
    );
  }

  async waitForTerminalRunnerRetirementSince(
    sessionId,
    offset,
    expectedRegistrationId,
    expectedPid,
    timeoutMs = 75_000,
  ) {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(expectedRegistrationId, "registration id");
    if (!Number.isSafeInteger(expectedPid) || expectedPid < 1) {
      throw new Error(`invalid runner pid: ${expectedPid}`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`invalid node log offset: ${offset}`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await readFile(this.nodeLog);
      const from = offset <= log.length ? offset : 0;
      const retirement = terminalRunnerRetirements(
        log.subarray(from).toString("utf8"),
      ).find((candidate) => candidate.sessionId === sessionId);
      const registration = await this.runnerExecutionRegistration(sessionId);
      const baselineRetired = !registration.present
        && registration.registrationId === expectedRegistrationId
        && registration.identityPid === null
        && registration.pidFilePid === null
        && !this.runnerAlive(expectedPid);
      if (retirement && baselineRetired) return { retirement, registration };
      await delay(500);
    }
    throw new Error(
      `terminal runner did not retire baseline registration ${expectedRegistrationId} for ${sessionId}`,
    );
  }

  async removeFaultRunnerDirectory(directory) {
    const prefix = join(this.runnerStateDirectory, "_fault-");
    if (!directory.startsWith(prefix)) {
      throw new Error(`unsafe fault runner directory: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  }

  async installActivationFailureFault(delaySeconds = 8, mutation = null) {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 30) {
      throw new Error(`invalid activation fault delay: ${delaySeconds}`);
    }
    if (![null, "raise_removed", "predicate_misplaced", "cleanup_removed"].includes(mutation)) {
      throw new Error(`invalid activation fault mutation: ${mutation}`);
    }
    const predicate = mutation === "predicate_misplaced"
      ? `OLD.execution_manifest_id IS NULL
           AND OLD.execution_runtime_env_identity IS NULL
           AND OLD.execution_registration_id IS NULL
           AND OLD.execution_pid IS NULL
           AND OLD.execution_start_identity IS NULL
           AND OLD.execution_command_id IS NULL
           AND OLD.execution_lease_expires_at IS NULL
           AND NEW.execution_manifest_id IS NOT NULL
           AND NEW.execution_runtime_env_identity IS NOT NULL
           AND NEW.execution_registration_id IS NOT NULL
           AND NEW.execution_pid IS NOT NULL
           AND NEW.execution_start_identity IS NOT NULL
           AND NEW.execution_command_id IS NOT NULL
           AND NEW.execution_lease_expires_at IS NOT NULL
           AND NEW.execution_generation = OLD.execution_generation + 2`
      : `OLD.execution_manifest_id IS NULL
           AND OLD.execution_runtime_env_identity IS NULL
           AND OLD.execution_registration_id IS NULL
           AND OLD.execution_pid IS NULL
           AND OLD.execution_start_identity IS NULL
           AND OLD.execution_command_id IS NULL
           AND OLD.execution_lease_expires_at IS NULL
           AND NEW.execution_manifest_id IS NOT NULL
           AND NEW.execution_runtime_env_identity IS NOT NULL
           AND NEW.execution_registration_id IS NOT NULL
           AND NEW.execution_pid IS NOT NULL
           AND NEW.execution_start_identity IS NOT NULL
           AND NEW.execution_command_id IS NOT NULL
           AND NEW.execution_lease_expires_at IS NOT NULL
           AND NEW.execution_generation = OLD.execution_generation + 1`;
    const rejectTransition = mutation === "raise_removed"
      ? ""
      : "RAISE EXCEPTION 'lab injected sessions-row execution acquire failure';";
    return await this.psqlOne(`
      DROP TRIGGER IF EXISTS lab_fault_fail_execution_activation ON session_execution_ownerships;
      DROP FUNCTION IF EXISTS lab_fault_fail_execution_activation();
      DROP TRIGGER IF EXISTS lab_fault_fail_execution_acquire ON sessions;
      DROP FUNCTION IF EXISTS lab_fault_fail_execution_acquire();
      DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_reach_seq;
      DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_generation_seq;
      DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_command_seq;
      CREATE SEQUENCE lab_fault_execution_acquire_reach_seq
        START WITH 1 INCREMENT BY 1 MINVALUE 1;
      CREATE SEQUENCE lab_fault_execution_acquire_generation_seq
        START WITH 1 INCREMENT BY 1 MINVALUE 0;
      CREATE SEQUENCE lab_fault_execution_acquire_command_seq
        START WITH 1 INCREMENT BY 1 MINVALUE -2147483648 MAXVALUE 2147483647;
      CREATE OR REPLACE FUNCTION lab_fault_fail_execution_acquire()
      RETURNS trigger LANGUAGE plpgsql AS $lab$
      BEGIN
        IF ${predicate} THEN
          PERFORM nextval('lab_fault_execution_acquire_reach_seq');
          PERFORM setval(
            'lab_fault_execution_acquire_generation_seq',
            NEW.execution_generation,
            true
          );
          PERFORM setval(
            'lab_fault_execution_acquire_command_seq',
            hashtext(NEW.execution_command_id),
            true
          );
          PERFORM pg_advisory_xact_lock(741925, 2);
          PERFORM pg_sleep(${delaySeconds});
          ${rejectTransition}
        END IF;
        RETURN NEW;
      END;
      $lab$;
      CREATE TRIGGER lab_fault_fail_execution_acquire
        BEFORE UPDATE OF execution_generation, execution_manifest_id,
          execution_runtime_env_identity, execution_registration_id,
          execution_pid, execution_start_identity, execution_command_id,
          execution_lease_expires_at ON sessions
        FOR EACH ROW EXECUTE FUNCTION lab_fault_fail_execution_acquire();
      SELECT json_build_object('installed', true);
    `);
  }

  async waitForActivationFailureFault(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const observation = await this.activationFailureFaultCount();
      if (observation.semanticReachCount > 0) return observation;
      await delay(100);
    }
    return await this.activationFailureFaultCount();
  }

  async activationFailureFaultCount() {
    return await this.psqlOne(`
      SELECT json_build_object(
        'semanticReachCount', CASE
          WHEN reach.is_called THEN reach.last_value ELSE 0
        END,
        'attemptedGeneration', CASE
          WHEN generation.is_called THEN generation.last_value ELSE NULL
        END,
        'attemptedCommandFingerprint', CASE
          WHEN command.is_called THEN command.last_value::text ELSE NULL
        END
      )
      FROM lab_fault_execution_acquire_reach_seq AS reach,
        lab_fault_execution_acquire_generation_seq AS generation,
        lab_fault_execution_acquire_command_seq AS command
    `);
  }

  async activationFailureFaultCountAfterHorizon(horizonMs) {
    if (!Number.isSafeInteger(horizonMs) || horizonMs < 1) {
      throw new Error(`invalid activation fault retry horizon: ${horizonMs}`);
    }
    const before = await this.activationFailureFaultCount();
    await delay(horizonMs);
    const after = await this.activationFailureFaultCount();
    return {
      semanticReachCount: after.semanticReachCount,
      semanticReachCountBeforeHorizon: before.semanticReachCount,
      attemptedGeneration: after.attemptedGeneration,
      attemptedCommandFingerprint: after.attemptedCommandFingerprint,
      retryHorizonMs: horizonMs,
      stable: before.semanticReachCount === after.semanticReachCount,
    };
  }

  async activationFailureFaultResidue() {
    return await this.psqlOne(`
      SELECT json_build_object(
        'triggerCount', (
          SELECT COUNT(*)::integer FROM pg_trigger
          WHERE tgname = 'lab_fault_fail_execution_acquire' AND NOT tgisinternal
        ),
        'functionCount', (
          SELECT COUNT(*)::integer
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = current_schema()
            AND procedure.proname = 'lab_fault_fail_execution_acquire'
        ),
        'counterCount', (
          SELECT COUNT(*)::integer
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relkind = 'S'
            AND relation.relname IN (
              'lab_fault_execution_acquire_reach_seq',
              'lab_fault_execution_acquire_generation_seq',
              'lab_fault_execution_acquire_command_seq'
            )
        )
      )
    `);
  }

  async removeActivationFailureFault() {
    return await this.psqlOne(`
      DROP TRIGGER IF EXISTS lab_fault_fail_execution_acquire ON sessions;
      DROP FUNCTION IF EXISTS lab_fault_fail_execution_acquire();
      DROP TRIGGER IF EXISTS lab_fault_fail_execution_activation ON session_execution_ownerships;
      DROP FUNCTION IF EXISTS lab_fault_fail_execution_activation();
      DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_reach_seq;
      DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_generation_seq;
      DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_command_seq;
      SELECT json_build_object('removed', true);
    `);
  }

  async runnerExecutionRegistration(sessionId) {
    const directory = this.runnerDirectory(sessionId);
    let identity = null;
    let pidFilePid = null;
    try {
      identity = JSON.parse(await readFile(join(directory, "runner-identity.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const value = Number((await readFile(join(directory, "runner.pid"), "utf8")).trim());
      if (Number.isSafeInteger(value) && value > 0) pidFilePid = value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      present: Number.isSafeInteger(identity?.pid)
        && identity.pid > 0
        && typeof identity.startIdentity === "string"
        && identity.startIdentity.length > 0,
      identityPid: Number.isSafeInteger(identity?.pid) ? identity.pid : null,
      pidFilePid,
      registrationId: typeof identity?.registrationId === "string"
        ? identity.registrationId
        : null,
    };
  }

  async waitForDistinctRunnerRegistration(
    sessionId,
    baselineRegistrationId,
    timeoutMs = 30_000,
  ) {
    return await waitFor(
      async () => {
        const registration = await this.runnerExecutionRegistration(sessionId);
        return registration.present
          && registration.registrationId !== baselineRegistrationId
          && this.runnerAlive(registration.identityPid)
          ? registration
          : undefined;
      },
      timeoutMs,
      `follow-up runner registration did not replace baseline: ${sessionId}`,
      100,
    );
  }

  async observeDistinctRunnerRegistrationInventoryUntil(
    sessionId,
    baselineRegistrationId,
    completionPromise,
    seed = [],
  ) {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(baselineRegistrationId, "registration id");
    const samples = [];
    const record = (registration) => {
      if (
        registration?.present
        && registration.registrationId !== baselineRegistrationId
      ) {
        samples.push({
          registrationId: registration.registrationId,
          identityPid: registration.identityPid,
        });
      }
    };
    for (const registration of seed) record(registration);
    let complete = false;
    const completion = Promise.resolve(completionPromise).then(
      () => { complete = true; },
      () => { complete = true; },
    );
    while (!complete) {
      record(await this.runnerExecutionRegistration(sessionId));
      await Promise.race([delay(100), completion]);
    }
    record(await this.runnerExecutionRegistration(sessionId));
    return distinctRunnerRegistrationInventory(samples, baselineRegistrationId);
  }

  async executionAcquireEnvelopeSourceSeq(sessionId, registrationId, pid) {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(registrationId, "registration id");
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid runner pid: ${pid}`);
    const text = await readFile(join(this.root, "outbox", "events.jsonl"), "utf8");
    const matches = executionAcquireEnvelopes(text).filter((envelope) => (
      envelope.sessionId === sessionId
      && envelope.registrationId === registrationId
      && envelope.pid === pid
    ));
    if (matches.length !== 1) {
      throw new Error(
        `expected one execution acquire envelope for ${sessionId}:${registrationId}:${pid}, `
        + `found ${matches.length}`,
      );
    }
    return matches[0].sourceSeq;
  }

  async executionAcquireApplicationEvidence({
    sessionId,
    expectedGeneration,
    registrationId,
    pid,
  }) {
    assertIdentifier(sessionId, "session id");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new Error(`invalid expected execution generation: ${expectedGeneration}`);
    }
    assertIdentifier(registrationId, "registration id");
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid runner pid: ${pid}`);
    const snapshot = await this.psqlOne(`
      WITH acquire_events AS (
        SELECT
          event.id AS event_id,
          event.session_id,
          event.payload #>> '{value,phase}' AS phase,
          event.payload #>> '{value,transition_id}' AS transition_id,
          event.dedupe_key,
          receipt.node_id,
          receipt.stream_id,
          receipt.source_seq,
          receipt.payload_hash,
          receipt.effect_application,
          receipt.created_at
        FROM events AS event
        LEFT JOIN event_ingress_receipts AS receipt
          ON receipt.session_id = event.session_id
          AND receipt.event_id = event.id
        WHERE event.session_id = ${sqlLiteral(sessionId)}
          AND event.event_type = 'metadata'
          AND event.payload->>'metadata_type' = 'execution_ownership_transition'
          AND event.payload #>> '{value,phase}' = 'execution_acquire'
      )
      SELECT json_build_object(
        'rows', COALESCE((
          SELECT json_agg(json_build_object(
            'eventId', acquire.event_id,
            'sessionId', acquire.session_id,
            'phase', acquire.phase,
            'transitionId', acquire.transition_id,
            'dedupeKey', acquire.dedupe_key,
            'nodeId', acquire.node_id,
            'streamId', acquire.stream_id,
            'sourceSeq', acquire.source_seq,
            'payloadHash', acquire.payload_hash,
            'effectApplication', acquire.effect_application
          ) ORDER BY acquire.event_id, acquire.created_at, acquire.source_seq)
          FROM acquire_events AS acquire
        ), '[]'::json),
        'finalOwnership', (
          SELECT json_build_object(
            'executionGeneration', session.execution_generation,
            'owner', CASE
              WHEN session.execution_manifest_id IS NULL THEN NULL
              ELSE json_build_object(
                'registrationId', session.execution_registration_id,
                'pid', session.execution_pid,
                'executionCommandId', session.execution_command_id
              )
            END
          )
          FROM sessions AS session
          WHERE session.session_id = ${sqlLiteral(sessionId)}
        )
      )
    `);
    return classifyExecutionAcquireApplicationEvidence(snapshot, {
      sessionId,
      expectedGeneration,
      registrationId,
      pid,
    });
  }

  async executionCommandFingerprint(executionCommandId) {
    assertIdentifier(executionCommandId, "execution command id");
    const value = await this.psqlOne(`
      SELECT json_build_object(
        'fingerprint', hashtext(${sqlLiteral(executionCommandId)})::text
      )
    `);
    return value?.fingerprint ?? null;
  }

  async removeLabRunnerRegistration(sessionId, expectedPid) {
    const registration = await this.runnerExecutionRegistration(sessionId);
    if (
      registration.identityPid !== expectedPid
      || registration.pidFilePid !== expectedPid
      || this.runnerAlive(expectedPid)
    ) {
      throw new Error(`unsafe lab runner registration cleanup: ${sessionId}`);
    }
    await rm(this.runnerDirectory(sessionId), { recursive: true, force: true });
  }

  async terminateObservedLabRunnerRegistration(sessionId, expectedPid) {
    const registration = await this.runnerExecutionRegistration(sessionId);
    if (
      !registration.present
      || registration.identityPid !== expectedPid
      || registration.pidFilePid !== expectedPid
      || !this.runnerAlive(expectedPid)
    ) {
      throw new Error(`lab runner identity changed before cleanup: ${sessionId}`);
    }
    await this.killRunnerPid(expectedPid, "SIGKILL");
    await this.removeLabRunnerRegistration(sessionId, expectedPid);
    const residue = await this.runnerExecutionRegistration(sessionId);
    if (residue.present) {
      throw new Error(`lab runner registration survived cleanup: ${sessionId}`);
    }
    return residue;
  }

  async installAdoptionWindow(sessionId, delaySeconds = 20) {
    return await installObservedAdoptionWindow(this, sessionId, delaySeconds);
  }

  async waitForAdoptionWindow(sessionId, timeoutMs = 60_000) {
    return await waitForObservedAdoptionWindow(this, sessionId, timeoutMs);
  }

  async removeAdoptionWindow() {
    return await removeObservedAdoptionWindow(this);
  }

  runnerAlive(pid) {
    return processAlive(pid);
  }

  async restartService(service, signal = "SIGTERM") {
    const definition = service === "node"
      ? {
          pidPath: join(this.root, "state", "node.pid"),
          entry: join(this.repo, "soul-server-ts", "dist", "main.js"),
        }
      : {
          pidPath: join(this.root, "state", "orch.pid"),
          entry: join(this.repo, "orch-server-ts", "dist", "production_main.js"),
        };
    const pid = Number((await readFile(definition.pidPath, "utf8")).trim());
    await assertProcess(pid, definition.entry, this.repo);
    process.kill(pid, signal);
    await waitForExit(pid, signal === "SIGKILL" ? 5_000 : 30_000);
    await unlink(definition.pidPath).catch(ignoreMissing);
    if (service === "node") this.expectFreshNodeConnection();
    await this.startStack();
    return pid;
  }

  async stopNodeForReleaseSwap() {
    const pidPath = join(this.root, "state", "node.pid");
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    await assertProcess(pid, join(this.repo, "soul-server-ts", "dist", "main.js"), this.repo);
    process.kill(pid, "SIGTERM");
    await waitForExit(pid, 30_000);
    await unlink(pidPath).catch(ignoreMissing);
    this.expectFreshNodeConnection();
    return pid;
  }

  async startStack() {
    await execFileAsync(join(this.repo, "scripts", "lab-node", "start.sh"), [], {
      cwd: this.repo,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    await this.assertReady();
  }

  async rebuildReleaseWithEnv(envText) {
    await ensureMemory();
    const envPath = join(this.repo, ".env.soul-server-ts");
    await writeFile(envPath, envText, { mode: 0o600 });
    const buildArguments = [
      "timeout",
      "300s",
      process.execPath,
      join(this.repo, "soul-server-ts", "scripts", "build_with_release_env.mjs"),
      "--env-file",
      envPath,
    ];
    const [command, ...args] = process.env.SOULSTREAM_HEAVY_LOCK_HELD === "1"
      ? buildArguments
      : ["flock", "-w", "300", "/tmp/soulstream-heavy-verify.lock", ...buildArguments];
    await execFileAsync(command, args, {
      cwd: this.repo,
      env: { ...process.env, NODE_ENV: "development" },
      timeout: 330_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return await this.currentManifest();
  }

  async currentManifest() {
    const value = JSON.parse(await readFile(
      join(this.repo, "soul-server-ts", "dist", "release-manifest.json"),
      "utf8",
    ));
    return {
      manifestId: value.manifest_id,
      releaseCohortId: value.release_cohort_id,
      sourceCommit: value.source_commit,
    };
  }

  async readNodeEnvironment() {
    return await readFile(join(this.repo, ".env.soul-server-ts"), "utf8");
  }

  async psqlOne(query) {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      this.container,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      this.databaseUser,
      "-d",
      this.database,
      "-c",
      query,
    ], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    const text = stdout.trim();
    return text ? JSON.parse(text) : null;
  }

  async updateSessionNode(sessionId, nodeId) {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(nodeId, "node id");
    return await this.psqlOne(`
      WITH updated AS (
        UPDATE sessions SET node_id = ${sqlLiteral(nodeId)}, updated_at = NOW()
        WHERE session_id = ${sqlLiteral(sessionId)} RETURNING session_id, node_id
      ) SELECT row_to_json(updated) FROM updated
    `);
  }

  async forceDeliveryDue(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    return await this.psqlOne(`
      WITH updated AS (
        UPDATE session_deliveries SET next_attempt_at = NOW() - INTERVAL '1 second'
        WHERE delivery_id = ${sqlLiteral(deliveryId)}
          AND aggregate_state = 'pending'
        RETURNING delivery_id, attempt_count, state, aggregate_state
      ) SELECT row_to_json(updated) FROM updated
    `);
  }

  async deliveryForSource(sourceSessionId) {
    return await this.psqlOne(`
      SELECT row_to_json(delivery) FROM (
        SELECT delivery_id, relation_key, completion_id, source_session_id, target_session_id,
          state, aggregate_state, attempt_count, last_error,
          dead_letter_reason, consumed_reason
        FROM session_deliveries
        WHERE source_session_id = ${sqlLiteral(sourceSessionId)}
          AND intent = 'completion_notification'
        ORDER BY created_at DESC LIMIT 1
      ) AS delivery
    `);
  }

  async deliveryById(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    return await this.psqlOne(`
      SELECT row_to_json(delivery) FROM (
        SELECT delivery_id, relation_key, source_session_id, target_session_id,
          state, aggregate_state, attempt_count, last_error,
          dead_letter_reason, consumed_reason, target_receipt_id, caller_turn_id,
          intent, source
        FROM session_deliveries
        WHERE delivery_id = ${sqlLiteral(deliveryId)}
      ) AS delivery
    `);
  }

  async deliveryCountById(deliveryId) {
    assertIdentifier(deliveryId, "delivery id");
    const value = await this.psqlOne(`
      SELECT json_build_object('count', COUNT(*)::integer)
      FROM session_deliveries
      WHERE delivery_id = ${sqlLiteral(deliveryId)}
    `);
    return value?.count ?? 0;
  }

  async ownerships(sessionId) {
    return await this.psqlOne(`
      SELECT COALESCE(json_agg(row_to_json(ownership)), '[]'::json) FROM (
        SELECT ownership_generation, owner_kind, phase, manifest_id, registration_id,
          pid, start_identity, execution_command_id, runner_fact, failure_reason
        FROM session_execution_ownerships
        WHERE session_id = ${sqlLiteral(sessionId)}
        ORDER BY ownership_generation
      ) AS ownership
    `) ?? [];
  }

  async sessionExecutionOwnership(sessionId) {
    assertIdentifier(sessionId, "session id");
    return await this.psqlOne(`
      SELECT json_build_object(
        'status', session.status,
        'executionGeneration', session.execution_generation,
        'owner', CASE
          WHEN session.execution_manifest_id IS NULL THEN NULL
          ELSE json_build_object(
            'manifestId', session.execution_manifest_id,
            'runtimeEnvIdentity', session.execution_runtime_env_identity,
            'registrationId', session.execution_registration_id,
            'pid', session.execution_pid,
            'startIdentity', session.execution_start_identity,
            'executionCommandId', session.execution_command_id,
            'leaseExpiresAt', session.execution_lease_expires_at
          )
        END,
        'terminalRevision', session.termination_event_id
      )
      FROM sessions AS session
      WHERE session.session_id = ${sqlLiteral(sessionId)}
    `);
  }

  async consumptionCount(relationKey) {
    const value = await this.psqlOne(`
      SELECT json_build_object('count', COUNT(*)::integer)
      FROM session_delivery_relation_consumptions
      WHERE relation_key = ${sqlLiteral(relationKey)}
    `);
    return value?.count ?? 0;
  }

  async turnResults(sessionId) {
    assertIdentifier(sessionId, "session id");
    return await this.psqlOne(`
      SELECT COALESCE(json_agg(json_build_object(
        'id', id,
        'event_type', event_type,
        'payload', payload,
        'created_at', created_at
      ) ORDER BY id), '[]'::json)
      FROM events
      WHERE session_id = ${sqlLiteral(sessionId)}
        AND event_type = 'result'
    `) ?? [];
  }

  async sessionEndedAt(sessionId) {
    assertIdentifier(sessionId, "session id");
    const event = await this.psqlOne(`
      SELECT json_build_object('created_at', created_at)
      FROM events
      WHERE session_id = ${sqlLiteral(sessionId)}
        AND event_type = 'session_ended'
      ORDER BY id DESC
      LIMIT 1
    `);
    return typeof event?.created_at === "string" ? event.created_at : null;
  }

  runnerInterventionInboxCount(sessionId) {
    const databasePath = join(this.runnerDirectory(sessionId), "runner.sqlite");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare(
        "SELECT COUNT(*) AS count FROM runner_intervention_inbox",
      ).get();
      return Number(row?.count ?? 0);
    } finally {
      database.close();
    }
  }

  /**
   * Waits until the lab node can actually take work, not merely until a row
   * exists for it.
   *
   * A registry row survives a restart, so requiring only its presence was
   * satisfied instantly while nothing was connected. Three scenario runs were
   * lost that way in one day -- each began seconds after a lab restart, each
   * died on `503 NO_AVAILABLE_NODE` at the first `create_session`, and each
   * cost a round before anyone noticed the verdict was void rather than red.
   */
  async waitForNodeRegistration(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen;
    while (Date.now() < deadline) {
      try {
        const nodes = await this.getJson("/api/nodes");
        const matches = Array.isArray(nodes.nodes)
          ? nodes.nodes.filter((node) => node?.nodeId === "eias-lab")
          : [];
        if (matches.length === 1) {
          lastSeen = matches[0];
          const connected = lastSeen.connected === true || lastSeen.status === "connected";
          const fresh = this.staleConnectionId === undefined
            || (lastSeen.connectionId !== undefined
              && lastSeen.connectionId !== this.staleConnectionId);
          if (connected && fresh) {
            this.lastConnectionId = lastSeen.connectionId;
            this.staleConnectionId = undefined;
            return;
          }
        }
      } catch {}
      await delay(250);
    }
    throw new Error(
      "eias-lab did not present a serving connection"
      + ` (status: ${lastSeen?.status ?? "absent"},`
      + ` connection: ${lastSeen?.connectionId ?? "none"},`
      + ` replacing: ${this.staleConnectionId ?? "none"})`,
    );
  }

  async waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch {}
      await delay(250);
    }
    throw new Error(`health check timed out: ${url}`);
  }
}

export async function waitFor(predicate, timeoutMs, message, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(intervalMs);
  }
  throw new Error(message, { cause: lastError });
}

export async function delay(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertMatchingProvenance(bundleCommit, checkoutCommit) {
  if (bundleCommit !== checkoutCommit) {
    throw new Error(
      `lab provenance mismatch: bundle ${bundleCommit} != checkout ${checkoutCommit}`,
    );
  }
}

export function assertFetchRefspecCoversMain(refspecs) {
  const coversMain = refspecs.some((refspec) => (
    refspec === "+refs/heads/*:refs/remotes/origin/*"
    || refspec === "+refs/heads/main:refs/remotes/origin/main"
  ));
  if (!coversMain) {
    throw new Error("lab fetch refspec does not fetch origin/main");
  }
}

export function runnerOperationSnapshots(logText) {
  const snapshots = [];
  for (const line of logText.split("\n")) {
    if (!line.includes("activeRunnerOperations")) continue;
    try {
      const record = JSON.parse(line);
      if (!Array.isArray(record.activeRunnerOperations)) continue;
      snapshots.push({
        time: record.time,
        message: record.msg,
        activeRunnerOperations: record.activeRunnerOperations,
      });
    } catch {}
  }
  return snapshots;
}

export function executionOwnershipTransitions(logText) {
  const transitions = [];
  for (const line of logText.split("\n")) {
    if (!line.includes("Execution ownership lifecycle transition applied")) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.sessionId !== "string") continue;
      if (typeof record.operation !== "string") continue;
      transitions.push({
        time: record.time,
        sessionId: record.sessionId,
        ownershipGeneration: record.ownershipGeneration,
        operation: record.operation,
        applied: record.applied,
        canonicalPhase: record.canonicalPhase,
      });
    } catch {}
  }
  return transitions;
}

export function terminalRunnerRetirements(logText) {
  const retirements = [];
  for (const line of logText.split("\n")) {
    if (!line.includes("terminal runner with no live process replayed offline and retired")) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (typeof record.sessionId !== "string") continue;
      if (record.disposition !== "replay_terminal_dead") continue;
      retirements.push({
        time: record.time,
        sessionId: record.sessionId,
        disposition: record.disposition,
      });
    } catch {}
  }
  return retirements;
}

export function eventIngressDeadLetters(logText) {
  const deadLetters = [];
  for (const line of logText.split("\n")) {
    if (!line.includes("REPEATED_FAILURE")) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.sessionId !== "string") continue;
      if (record.err?.code !== "REPEATED_FAILURE") continue;
      deadLetters.push({
        time: record.time,
        sessionId: record.sessionId,
        sourceSeq: record.err.sourceSeq,
        code: record.err.code,
        rejectedAt: record.err.rejectedAt,
      });
    } catch {}
  }
  return deadLetters;
}

export function executionAcquireEnvelopes(logText) {
  const envelopes = [];
  for (const line of logText.split("\n")) {
    if (!line.includes('"kind":"execution_acquire"')) continue;
    try {
      const record = JSON.parse(line);
      const effect = record.session_effect;
      if (effect?.kind !== "execution_acquire") continue;
      if (!Number.isSafeInteger(record.source_seq) || record.source_seq < 1) continue;
      envelopes.push({
        sourceSeq: record.source_seq,
        sessionId: record.session_id,
        registrationId: effect.registration_id,
        pid: effect.pid,
      });
    } catch {}
  }
  return envelopes;
}

export function distinctRunnerRegistrationInventory(samples, baselineRegistrationId) {
  const registrationIds = new Set();
  const pids = new Set();
  const identities = new Map();
  for (const sample of samples) {
    if (
      !sample
      || sample.registrationId === baselineRegistrationId
      || typeof sample.registrationId !== "string"
      || !Number.isSafeInteger(sample.identityPid)
      || sample.identityPid < 1
    ) continue;
    registrationIds.add(sample.registrationId);
    pids.add(sample.identityPid);
    identities.set(`${sample.registrationId}:${sample.identityPid}`, {
      registrationId: sample.registrationId,
      identityPid: sample.identityPid,
    });
  }
  return {
    observations: [...identities.values()],
    registrationCount: registrationIds.size,
    pidCount: pids.size,
    identityCount: identities.size,
  };
}

function requireEnv(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requirePort(env, key, protectedPorts) {
  const value = Number(requireEnv(env, key));
  if (!Number.isInteger(value) || value <= 1024 || value >= 65536 || protectedPorts.includes(value)) {
    throw new Error(`unsafe ${key}`);
  }
  return value;
}

function requirePositiveInteger(env, key) {
  const value = Number(requireEnv(env, key));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function classifyExecutionAcquireApplicationEvidence(snapshot, expected) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const finalOwnership = snapshot?.finalOwnership;
  if (
    !Number.isSafeInteger(finalOwnership?.executionGeneration)
    || (finalOwnership.owner !== null && typeof finalOwnership.owner !== "object")
  ) {
    return executionAcquireEvidenceConflict("invalid_final_ownership", rows);
  }
  const groups = new Map();
  for (const row of rows) {
    const eventId = Number(row?.eventId);
    if (
      !Number.isSafeInteger(eventId)
      || eventId < 1
      || row?.sessionId !== expected.sessionId
      || row?.phase !== "execution_acquire"
      || typeof row?.transitionId !== "string"
      || !row.transitionId.startsWith("acquire:")
    ) {
      return executionAcquireEvidenceConflict("invalid_event", rows);
    }
    const group = groups.get(eventId) ?? {
      event: {
        eventId,
        sessionId: row.sessionId,
        phase: row.phase,
        transitionId: row.transitionId,
      },
      rows: [],
    };
    if (
      group.event.transitionId !== row.transitionId
      || group.event.sessionId !== row.sessionId
    ) {
      return executionAcquireEvidenceConflict("mixed_event_identity", rows);
    }
    group.rows.push(row);
    groups.set(eventId, group);
  }

  const logicalEvents = [];
  for (const group of groups.values()) {
    if (group.rows.some((row) => row.sourceSeq === null || row.effectApplication === null)) {
      return executionAcquireEvidenceConflict("partial_evidence", rows);
    }
    const applications = group.rows.map((row) => normalizeAcquireApplication(
      row.effectApplication,
      group.event,
      expected.sessionId,
    ));
    if (applications.some((application) => application === null)) {
      return executionAcquireEvidenceConflict("invalid_application", rows);
    }
    const signatures = new Set(group.rows.map((row) => JSON.stringify(row.effectApplication)));
    if (signatures.size !== 1) {
      return executionAcquireEvidenceConflict("mixed_application", rows);
    }
    const application = applications[0];
    const relevant = application.applied === false
      || application.ownershipGeneration === expected.expectedGeneration
      || application.registrationId === expected.registrationId
      || application.pid === expected.pid;
    if (relevant) {
      logicalEvents.push({
        event: group.event,
        application,
        transportReceiptCount: group.rows.length,
      });
    }
  }

  if (logicalEvents.length > 1) {
    return executionAcquireEvidenceConflict("logical_event_duplicate", rows, logicalEvents.length);
  }
  const logicalEvent = logicalEvents[0];
  if (!logicalEvent) {
    return finalOwnership.executionGeneration === expected.expectedGeneration - 1
        && finalOwnership.owner === null
      ? {
          classification: "no_transition",
          logicalAcquireEventCount: 0,
          transportReceiptCount: 0,
          event: null,
          application: null,
        }
      : executionAcquireEvidenceConflict("absent_event_final_state_mismatch", rows);
  }
  if (logicalEvent.application.applied === false) {
    return finalOwnership.executionGeneration === expected.expectedGeneration - 1
        && finalOwnership.owner === null
      ? {
          classification: "no_transition",
          logicalAcquireEventCount: 1,
          transportReceiptCount: logicalEvent.transportReceiptCount,
          event: logicalEvent.event,
          application: logicalEvent.application,
        }
      : executionAcquireEvidenceConflict("unapplied_event_final_state_mismatch", rows);
  }
  const commandId = logicalEvent.application.executionCommandId;
  const identityMatches = logicalEvent.application.sessionId === expected.sessionId
    && logicalEvent.application.ownershipGeneration === expected.expectedGeneration
    && logicalEvent.application.registrationId === expected.registrationId
    && logicalEvent.application.pid === expected.pid
    && typeof commandId === "string"
    && logicalEvent.event.transitionId === `acquire:${commandId}`;
  if (!identityMatches) {
    return executionAcquireEvidenceConflict("applied_identity_mismatch", rows);
  }
  if (
    finalOwnership.executionGeneration !== expected.expectedGeneration
    || finalOwnership.owner !== null
  ) {
    return executionAcquireEvidenceConflict("applied_event_final_state_mismatch", rows);
  }
  return {
    classification: "applied",
    logicalAcquireEventCount: 1,
    transportReceiptCount: logicalEvent.transportReceiptCount,
    event: logicalEvent.event,
    application: logicalEvent.application,
  };
}

function normalizeAcquireApplication(value, event, sessionId) {
  if (typeof value !== "object" || value === null || typeof value.applied !== "boolean") {
    return null;
  }
  const owner = value.canonical_execution_ownership;
  if (value.applied === true && (typeof owner !== "object" || owner === null)) return null;
  if (owner !== null && owner !== undefined && typeof owner !== "object") return null;
  const eventCommandId = event.transitionId.slice("acquire:".length);
  return {
    applied: value.applied,
    sessionId,
    ownershipGeneration: Number.isSafeInteger(owner?.ownership_generation)
      ? Number(owner.ownership_generation)
      : null,
    registrationId: typeof owner?.registration_id === "string"
      ? owner.registration_id
      : null,
    pid: Number.isSafeInteger(owner?.pid) ? Number(owner.pid) : null,
    executionCommandId: typeof owner?.execution_command_id === "string"
      ? owner.execution_command_id
      : eventCommandId,
  };
}

function executionAcquireEvidenceConflict(conflict, rows, logicalAcquireEventCount = 1) {
  return {
    classification: "conflict",
    logicalAcquireEventCount,
    transportReceiptCount: rows.filter((row) => row?.sourceSeq !== null).length,
    event: null,
    application: null,
    conflict,
  };
}

function assertIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
}

function sqlLiteral(value) {
  assertIdentifier(value, "SQL identifier value");
  return `'${value}'`;
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function assertProcess(pid, expectedEntry, expectedRoot) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process pid");
  const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  if (!command.includes(expectedEntry)) throw new Error(`process ${pid} identity mismatch`);
  if (expectedRoot) {
    const cwd = await readlink(`/proc/${pid}/cwd`);
    if (cwd !== expectedRoot && !command.includes(expectedRoot)) {
      throw new Error(`process ${pid} root mismatch`);
    }
  }
}

async function ownedRunnerProcesses(root) {
  const releasePrefix = join(root, "state", "runner-releases") + "/";
  const configPrefix = join(root, "runner-state") + "/";
  const processes = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const command = (await readFile(`/proc/${entry.name}/cmdline`, "utf8"))
        .replaceAll("\0", " ");
      if (!command.includes(releasePrefix) || !command.includes("/runner_entry.js")) continue;
      if (!command.includes(`--config ${configPrefix}`)) continue;
      processes.push({ pid: Number(entry.name) });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await delay(100);
  }
  if (processAlive(pid)) throw new Error(`process ${pid} did not exit`);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ensureMemory() {
  const available = Number((await readFile("/proc/meminfo", "utf8"))
    .match(/^MemAvailable:\s+(\d+) kB$/m)?.[1] ?? 0) / 1024;
  if (available >= 2_000) return;
  await delay(60_000);
  const retried = Number((await readFile("/proc/meminfo", "utf8"))
    .match(/^MemAvailable:\s+(\d+) kB$/m)?.[1] ?? 0) / 1024;
  if (retried < 2_000) throw new Error(`available memory remains below 2000MB: ${Math.floor(retried)}MB`);
}

function ignoreMissing(error) {
  if (error.code !== "ENOENT") throw error;
}
