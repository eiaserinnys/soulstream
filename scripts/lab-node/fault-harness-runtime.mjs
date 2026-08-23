import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
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

  async createRun(command) {
    const runId = `${command}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    const directory = join(this.stateDirectory, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new EvidenceRecorder(this, runId, directory);
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
    const { stdout } = await execFileAsync("git", ["-C", this.repo, "rev-parse", "HEAD"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assertMatchingProvenance(manifest.sourceCommit, stdout.trim());
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
    return await this.postJson(`/api/sessions/${sessionId}/intervene`, body);
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

  async removeFaultRunnerDirectory(directory) {
    const prefix = join(this.runnerStateDirectory, "_fault-");
    if (!directory.startsWith(prefix)) {
      throw new Error(`unsafe fault runner directory: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  }

  async installActivationFailureFault(delaySeconds = 8) {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 30) {
      throw new Error(`invalid activation fault delay: ${delaySeconds}`);
    }
    return await this.psqlOne(`
      DROP TRIGGER IF EXISTS lab_fault_fail_execution_activation
        ON session_execution_ownerships;
      CREATE OR REPLACE FUNCTION lab_fault_fail_execution_activation()
      RETURNS trigger LANGUAGE plpgsql AS $lab$
      BEGIN
        IF OLD.phase = 'identity_proven' AND NEW.phase = 'active' THEN
          PERFORM pg_sleep(${delaySeconds});
          RAISE EXCEPTION 'lab injected execution activation failure';
        END IF;
        RETURN NEW;
      END;
      $lab$;
      CREATE TRIGGER lab_fault_fail_execution_activation
        BEFORE UPDATE OF phase ON session_execution_ownerships
        FOR EACH ROW EXECUTE FUNCTION lab_fault_fail_execution_activation();
      SELECT json_build_object('installed', true);
    `);
  }

  async removeActivationFailureFault() {
    return await this.psqlOne(`
      DROP TRIGGER IF EXISTS lab_fault_fail_execution_activation
        ON session_execution_ownerships;
      DROP FUNCTION IF EXISTS lab_fault_fail_execution_activation();
      SELECT json_build_object('removed', true);
    `);
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
          dead_letter_reason, consumed_reason
        FROM session_deliveries
        WHERE delivery_id = ${sqlLiteral(deliveryId)}
      ) AS delivery
    `);
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
        'event_type', event_type,
        'payload', payload
      ) ORDER BY id), '[]'::json)
      FROM events
      WHERE session_id = ${sqlLiteral(sessionId)}
        AND event_type = 'result'
    `) ?? [];
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
