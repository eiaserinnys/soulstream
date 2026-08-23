export class LabControlPlaneRuntime {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async sessionStatus(sessionId) {
    assertIdentifier(sessionId, "session id");
    const row = await this.runtime.psqlOne(`
      SELECT json_build_object('status', status)
      FROM sessions WHERE session_id = ${sqlLiteral(sessionId)}
    `);
    return typeof row?.status === "string" ? row.status : "";
  }

  async updateSessionNode(sessionId, nodeId) {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(nodeId, "node id");
    return await this.runtime.psqlOne(`
      WITH updated AS (
        UPDATE sessions SET node_id = ${sqlLiteral(nodeId)}, updated_at = NOW()
        WHERE session_id = ${sqlLiteral(sessionId)} RETURNING session_id, node_id
      ) SELECT row_to_json(updated) FROM updated
    `);
  }

  async ownerships(sessionId) {
    assertIdentifier(sessionId, "session id");
    return await this.runtime.psqlOne(`
      SELECT COALESCE(json_agg(row_to_json(ownership)), '[]'::json) FROM (
        SELECT ownership_generation, phase, manifest_id, registration_id,
          pid, start_identity, runner_fact, failure_reason
        FROM session_execution_ownerships
        WHERE session_id = ${sqlLiteral(sessionId)}
        ORDER BY ownership_generation
      ) AS ownership
    `) ?? [];
  }
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
