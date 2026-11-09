import type { LivePostgresSql } from "../runtime/live_db_sql.js";

import type {
  NodeCredentialActiveRow,
  NodeCredentialInsert,
  NodeCredentialRow,
} from "./types.js";

type Row = Record<string, unknown>;

export interface NodeCredentialRepository {
  loadActive(): Promise<NodeCredentialActiveRow[]>;
  insert(input: NodeCredentialInsert): Promise<NodeCredentialRow>;
  findById(credentialId: string): Promise<NodeCredentialRow | null>;
  markRevoked(credentialId: string, revokedAt: Date): Promise<NodeCredentialRow | null>;
  list(includeRevoked: boolean): Promise<NodeCredentialRow[]>;
}

export class SqlNodeCredentialRepository implements NodeCredentialRepository {
  constructor(private readonly resolveSql: () => Promise<LivePostgresSql>) {}

  async loadActive(): Promise<NodeCredentialActiveRow[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT credential_id::text AS credential_id, node_id, company_pc, token_sha256
      FROM node_credentials
      WHERE revoked_at IS NULL
    `;
    return rows.map(row => ({
      credential_id: String(row.credential_id),
      node_id: String(row.node_id),
      company_pc: row.company_pc === true,
      token_sha256: String(row.token_sha256),
    }));
  }

  async insert(input: NodeCredentialInsert): Promise<NodeCredentialRow> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      INSERT INTO node_credentials (credential_id, node_id, company_pc, token_sha256)
      VALUES (${input.credential_id}, ${input.node_id}, ${input.company_pc}, ${input.token_sha256})
      RETURNING credential_id::text AS credential_id, node_id, company_pc, token_sha256,
        created_at, revoked_at
    `;
    return credentialRow(rows[0]);
  }

  async findById(credentialId: string): Promise<NodeCredentialRow | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT credential_id::text AS credential_id, node_id, company_pc, token_sha256,
        created_at, revoked_at
      FROM node_credentials
      WHERE credential_id = ${credentialId}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : credentialRow(rows[0]);
  }

  async markRevoked(credentialId: string, revokedAt: Date): Promise<NodeCredentialRow | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      UPDATE node_credentials
      SET revoked_at = ${revokedAt}
      WHERE credential_id = ${credentialId} AND revoked_at IS NULL
      RETURNING credential_id::text AS credential_id, node_id, company_pc, token_sha256,
        created_at, revoked_at
    `;
    return rows[0] === undefined ? null : credentialRow(rows[0]);
  }

  async list(includeRevoked: boolean): Promise<NodeCredentialRow[]> {
    const sql = await this.resolveSql();
    if (includeRevoked) {
      const rows = await sql<Row[]>`
        SELECT credential_id::text AS credential_id, node_id, company_pc, token_sha256,
          created_at, revoked_at
        FROM node_credentials
        ORDER BY created_at DESC, credential_id
      `;
      return rows.map(credentialRow);
    }
    const rows = await sql<Row[]>`
      SELECT credential_id::text AS credential_id, node_id, company_pc, token_sha256,
        created_at, revoked_at
      FROM node_credentials
      WHERE revoked_at IS NULL
      ORDER BY created_at DESC, credential_id
    `;
    return rows.map(credentialRow);
  }
}

function credentialRow(row: Row | undefined): NodeCredentialRow {
  if (row === undefined) throw new Error("node credential statement returned no row");
  return {
    credential_id: String(row.credential_id),
    node_id: String(row.node_id),
    company_pc: row.company_pc === true,
    token_sha256: String(row.token_sha256),
    created_at: row.created_at instanceof Date || typeof row.created_at === "string"
      ? row.created_at
      : String(row.created_at),
    revoked_at: row.revoked_at instanceof Date || typeof row.revoked_at === "string"
      ? row.revoked_at
      : null,
  };
}
