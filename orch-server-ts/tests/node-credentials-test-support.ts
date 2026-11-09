import { createHash } from "node:crypto";

import {
  NodeCredentialStore,
  type NodeCredentialInsert,
  type NodeCredentialRepository,
  type NodeCredentialRow,
} from "../src/node_credentials/index.js";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class InMemoryNodeCredentialRepository implements NodeCredentialRepository {
  readonly rows: NodeCredentialRow[] = [];
  failLoad = false;
  failNextInsert = false;

  async loadActive() {
    if (this.failLoad) throw new Error("database unavailable");
    return this.rows
      .filter(row => row.revoked_at === null)
      .map(row => ({
        credential_id: row.credential_id,
        node_id: row.node_id,
        company_pc: row.company_pc,
        token_sha256: row.token_sha256,
      }));
  }

  async insert(input: NodeCredentialInsert): Promise<NodeCredentialRow> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("database unavailable");
    }
    // Mirror the real constraints: token_sha256 is globally UNIQUE and the
    // uq_node_credentials_active_node partial index allows one active row per
    // node_id.
    const duplicated =
      this.rows.some(row => row.token_sha256 === input.token_sha256) ||
      this.rows.some(row => row.node_id === input.node_id && row.revoked_at === null);
    if (duplicated) {
      throw Object.assign(
        new Error("duplicate key value violates unique constraint"),
        { code: "23505" },
      );
    }
    const row: NodeCredentialRow = {
      ...input,
      created_at: new Date("2026-11-09T00:00:00.000Z"),
      revoked_at: null,
    };
    this.rows.push(row);
    return row;
  }

  async findById(credentialId: string): Promise<NodeCredentialRow | null> {
    return this.rows.find(row => row.credential_id === credentialId) ?? null;
  }

  async markRevoked(credentialId: string, revokedAt: Date): Promise<NodeCredentialRow | null> {
    const row = this.rows.find(candidate => candidate.credential_id === credentialId);
    if (row === undefined || row.revoked_at !== null) return null;
    row.revoked_at = revokedAt;
    return row;
  }

  async list(includeRevoked: boolean): Promise<NodeCredentialRow[]> {
    return includeRevoked
      ? [...this.rows]
      : this.rows.filter(row => row.revoked_at === null);
  }
}

export function seededRow(
  credentialId: string,
  nodeId: string,
  companyPc: boolean,
  token: string,
): NodeCredentialRow {
  return {
    credential_id: credentialId,
    node_id: nodeId,
    company_pc: companyPc,
    token_sha256: sha256Hex(token),
    created_at: new Date("2026-11-09T00:00:00.000Z"),
    revoked_at: null,
  };
}

export async function createInitializedStore(): Promise<{
  repository: InMemoryNodeCredentialRepository;
  store: NodeCredentialStore;
}> {
  const repository = new InMemoryNodeCredentialRepository();
  const store = new NodeCredentialStore({ repository });
  await store.initialize();
  return { repository, store };
}
