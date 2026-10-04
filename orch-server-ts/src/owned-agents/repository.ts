import { BoardYjsSqlResolver, type BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { OwnedAgentError, type OwnedAgentRepository, type OwnedAgent, type AgentCredential, type CredentialRecord } from "./types.js";
type Row = Record<string, unknown>;
const date = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nullableDate = (value: unknown) => value == null ? null : date(value);
const agent = (r: Row): OwnedAgent => ({ id: String(r.id), ownerEmail: String(r.owner_email), name: String(r.name),
  enabled: Boolean(r.enabled), createdAt: date(r.created_at), updatedAt: date(r.updated_at) });
const key = (r: Row): AgentCredential => ({ id: String(r.id), agentId: String(r.agent_id), createdAt: date(r.created_at),
  lastUsedAt: nullableDate(r.last_used_at), revokedAt: nullableDate(r.revoked_at) });
async function credential(sql: BoardYjsQuerySql, hash: string): Promise<CredentialRecord | null> {
  const rows = await sql`SELECT c.id,c.agent_id,c.created_at,c.last_used_at,c.revoked_at,
    a.owner_email,a.name,a.enabled,a.created_at AS agent_created_at,a.updated_at AS agent_updated_at
    FROM external_agent_credentials c JOIN external_agents a ON a.id=c.agent_id WHERE c.token_hash=${hash}`;
  const r = rows[0];
  return r ? { ...key(r), agent: agent({ ...r, id: r.agent_id, created_at: r.agent_created_at, updated_at: r.agent_updated_at }) } : null;
}
export class SqlOwnedAgentRepository implements OwnedAgentRepository {
  private readonly resolver: BoardYjsSqlResolver;
  constructor(resolver: LiveDbSqlResolver) { this.resolver = new BoardYjsSqlResolver(resolver); }
  async list(email: string) { const sql = await this.resolver.resolveSql();
    return (await sql`SELECT * FROM external_agents WHERE owner_email=${email} ORDER BY created_at,id`).map(agent); }
  async find(id: string) { const sql = await this.resolver.resolveSql();
    const rows = await sql`SELECT * FROM external_agents WHERE id=${id}`; return rows[0] ? agent(rows[0]) : null; }
  async create(email: string, name: string) { const sql = await this.resolver.resolveSql();
    return agent((await sql`INSERT INTO external_agents(owner_email,name) VALUES(${email},${name}) RETURNING *`)[0]!); }
  async update(id: string, email: string, input: { name?: string; enabled?: boolean }) {
    const sql = await this.resolver.resolveSql();
    const rows = await sql`UPDATE external_agents SET name=COALESCE(${input.name ?? null},name),
      enabled=COALESCE(${input.enabled ?? null},enabled),updated_at=NOW() WHERE id=${id} AND owner_email=${email} RETURNING *`;
    return rows[0] ? agent(rows[0]) : null;
  }
  async keys(id: string) { const sql = await this.resolver.resolveSql();
    return (await sql`SELECT id,agent_id,created_at,last_used_at,revoked_at FROM external_agent_credentials WHERE agent_id=${id} ORDER BY created_at,id`).map(key); }
  async credential(hash: string) { return credential(await this.resolver.resolveSql(), hash); }
  async issue(id: string, email: string, hash: string) { const sql = await this.resolver.resolveSql();
    return key((await sql`INSERT INTO external_agent_credentials(agent_id,token_hash,created_by)
      VALUES(${id},${hash},${email}) RETURNING id,agent_id,created_at,last_used_at,revoked_at`)[0]!); }
  async revoke(id: string, keyId: string) { const sql = await this.resolver.resolveSql();
    return (await sql`UPDATE external_agent_credentials SET revoked_at=COALESCE(revoked_at,NOW())
      WHERE id=${keyId} AND agent_id=${id} RETURNING id`).length > 0; }
  async touch(id: string) { const sql = await this.resolver.resolveSql();
    await sql`UPDATE external_agent_credentials SET last_used_at=NOW() WHERE id=${id}`; }
  async registerExisting(email: string, name: string, hash: string) {
    const sql = await this.resolver.resolveSql();
    return sql.begin(async tx => {
      // Serialize the one configured connection so concurrent retries create no orphan agents.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${hash}))`;
      const existing = await credential(tx, hash);
      if (existing) {
        if (existing.agent.ownerEmail !== email || existing.revokedAt || !existing.agent.enabled)
          throw new OwnedAgentError(409, "Existing connection belongs to another owner or is disabled/revoked");
        return existing;
      }
      const a = agent((await tx`INSERT INTO external_agents(owner_email,name) VALUES(${email},${name}) RETURNING *`)[0]!);
      const c = key((await tx`INSERT INTO external_agent_credentials(agent_id,token_hash,created_by)
        VALUES(${a.id},${hash},${email}) RETURNING id,agent_id,created_at,last_used_at,revoked_at`)[0]!);
      return { ...c, agent: a };
    });
  }
}
