import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import type postgres from "postgres";
import type { SqlClient } from "../control_plane/control_plane_types.js";

/** Provider storage; consume uses a conditional UPDATE so only one exchange wins. */
export function oauthAdapter(sql: SqlClient) {
  return (kind: string): Adapter => ({
    async upsert(id, payload, expiresIn) {
      const expiresAt = expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000);
      await sql`
        INSERT INTO oauth_entities (kind, id, payload, expires_at, grant_id)
        VALUES (${kind}, ${id}, ${sql.json(payload as postgres.JSONValue)}, ${expiresAt}, ${payload.grantId ?? null})
        ON CONFLICT (kind, id) DO UPDATE SET payload = EXCLUDED.payload,
          expires_at = EXCLUDED.expires_at, grant_id = EXCLUDED.grant_id
      `;
    },
    async find(id) {
      const rows = await sql<{ payload: AdapterPayload; consumed_at: Date | null }[]>`
        SELECT payload, consumed_at FROM oauth_entities
        WHERE kind = ${kind} AND id = ${id} AND (expires_at IS NULL OR expires_at > now())
      `;
      const row = rows[0];
      return row ? { ...row.payload, ...(row.consumed_at ? { consumed: Math.floor(row.consumed_at.getTime() / 1000) } : {}) } : undefined;
    },
    async findByUid(uid) {
      const rows = await sql<{ payload: AdapterPayload }[]>`
        SELECT payload FROM oauth_entities WHERE kind = ${kind} AND payload->>'uid' = ${uid}
          AND (expires_at IS NULL OR expires_at > now()) LIMIT 1
      `;
      return rows[0]?.payload;
    },
    async findByUserCode(userCode) {
      const rows = await sql<{ payload: AdapterPayload }[]>`
        SELECT payload FROM oauth_entities WHERE kind = ${kind} AND payload->>'userCode' = ${userCode}
          AND (expires_at IS NULL OR expires_at > now()) LIMIT 1
      `;
      return rows[0]?.payload;
    },
    async consume(id) {
      const rows = await sql<{ id: string }[]>`
        UPDATE oauth_entities SET consumed_at = now()
        WHERE kind = ${kind} AND id = ${id} AND consumed_at IS NULL
          AND (expires_at IS NULL OR expires_at > now()) RETURNING id
      `;
      if (!rows.length) throw new errors.InvalidGrant("authorization artifact already consumed");
    },
    async destroy(id) { await sql`DELETE FROM oauth_entities WHERE kind = ${kind} AND id = ${id}`; },
    async revokeByGrantId(grantId) { await sql`DELETE FROM oauth_entities WHERE grant_id = ${grantId}`; },
  });
}
