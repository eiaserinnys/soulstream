import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Read access to the lab database, separated from the runtime that drives the
 * lab.
 *
 * Re-judging stored evidence needs the database and nothing else -- no ports,
 * no bearer token, no release manifest. Requiring the full runtime to read a
 * table is what made the previous verdicts impossible to re-check outside a
 * live run, and a verdict nobody can re-check is a verdict nobody can audit.
 */
export class LabDatabase {
  constructor(env = process.env) {
    this.container = requireEnv(env, "LAB_POSTGRES_CONTAINER");
    this.database = requireEnv(env, "LAB_POSTGRES_DB");
    this.user = requireEnv(env, "LAB_POSTGRES_USER");
    if (!this.container.startsWith("soulstream-lab-")) {
      throw new Error(`unsafe lab postgres container: ${this.container}`);
    }
    if (!this.database.startsWith("soulstream_lab")) {
      throw new Error(`unsafe lab postgres database: ${this.database}`);
    }
  }

  async queryOne(query) {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      this.container,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      this.user,
      "-d",
      this.database,
      "-c",
      query,
    ], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const text = stdout.trim();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Every session created in the window with the events the pairing needs.
   *
   * Only the four event types the verdict reads are fetched. Pulling whole
   * timelines would move megabytes of tool output for a judgement that never
   * looks at it.
   */
  async pairingInputs(since, until = null) {
    return await this.queryOne(pairingInputsQuery(since, until));
  }
}

/**
 * The sessions and events the pairing verdict reads, as one SQL statement.
 *
 * The live sampler and the offline re-judge share it on purpose. When they
 * were separate the replay could disagree with the run it was replaying, and
 * then neither number means anything.
 *
 * Scoped by `sessions.created_at`, which is the window the harness runs in:
 * every scenario creates the sessions it uses. A session created *before* the
 * window that receives an input *during* it is therefore not judged. That is a
 * real limit, stated here rather than discovered later -- widening it to
 * "sessions with events in the window" would make each run answer for losses
 * left behind by the one before it.
 */
export function pairingInputsQuery(since, until = null) {
  const window = `sessions.created_at >= ${sqlTimestamp(since)}`
    + (until ? ` AND sessions.created_at <= ${sqlTimestamp(until)}` : "");
  return `
    SELECT json_build_object(
      'sessions', (
        SELECT COALESCE(json_agg(row_to_json(summary)), '[]'::json) FROM (
          SELECT sessions.session_id, sessions.status, sessions.created_at,
            (SELECT MAX(created_at) FROM events
              WHERE events.session_id = sessions.session_id) AS last_event_at
          FROM sessions WHERE ${window}
        ) AS summary
      ),
      'events', (
        SELECT COALESCE(json_agg(row_to_json(entry) ORDER BY entry.id), '[]'::json) FROM (
          SELECT events.session_id, events.id, events.event_type,
            events.payload->>'text' AS text,
            events.payload->>'status' AS ended_status,
            events.payload->>'termination_reason' AS termination_reason,
            events.created_at
          FROM events
          JOIN sessions USING (session_id)
          WHERE ${window}
            AND events.event_type IN (
              'user_message', 'intervention_sent', 'assistant_message', 'session_ended'
            )
        ) AS entry
      )
    )
  `;
}

/** Groups pairing events by session id. */
export function groupEventsBySession(events) {
  const grouped = new Map();
  for (const event of events ?? []) {
    const list = grouped.get(event.session_id);
    if (list) list.push(event); else grouped.set(event.session_id, [event]);
  }
  return grouped;
}

/** Quotes an ISO timestamp for inline SQL; rejects anything that is not one. */
export function sqlTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`invalid window timestamp: ${value}`);
  }
  return `TIMESTAMPTZ '${value}'`;
}

function requireEnv(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}
