import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { NodeCredentialRepository } from "./credential_repository.js";
import type {
  NodeCredentialActiveRow,
  NodeCredentialRecord,
  NodeCredentialResolver,
  NodeCredentialRow,
  NodePairingRevocation,
  NodePrincipal,
} from "./types.js";

export type NodeCredentialStoreOptions = {
  repository: NodeCredentialRepository;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
};

export type NodeCredentialStoreInitResult =
  | { ok: true }
  | { ok: false; error: unknown };

export type NodeCredentialCreation = {
  credential: NodeCredentialRecord;
  token: string;
};

export type NodeCredentialRevocation =
  | { outcome: "revoked"; credential: NodeCredentialRecord }
  | { outcome: "already_revoked"; credential: NodeCredentialRecord }
  | { outcome: "not_found"; credential: null };

/** The database rejected a second active credential for the same node. */
export class NodeCredentialConflictError extends Error {
  constructor() {
    super("node already has an active credential (node_credentials)");
    this.name = "NodeCredentialConflictError";
  }
}

/**
 * Holds the active credential map in memory. `resolve` never awaits, so bearer
 * inspection stays synchronous; the map is refreshed at startup and after each
 * committed approve/revoke. A failed startup read leaves the resolver closed
 * (null for every token) until the next process start.
 */
export class NodeCredentialStore implements NodeCredentialResolver {
  private readonly repository: NodeCredentialRepository;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly randomUUID: () => string;
  private readonly byTokenHash = new Map<string, NodePrincipal>();
  private readonly byCredentialId = new Map<string, string>();
  private readonly revokedListeners = new Set<(principal: NodePrincipal) => void>();
  private available = false;

  constructor(options: NodeCredentialStoreOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? randomBytes;
    this.randomUUID = options.randomUUID ?? randomUUID;
  }

  async initialize(): Promise<NodeCredentialStoreInitResult> {
    try {
      const rows = await this.repository.loadActive();
      this.replaceMap(rows);
      this.available = true;
      return { ok: true };
    } catch (error) {
      this.byTokenHash.clear();
      this.byCredentialId.clear();
      this.available = false;
      return { ok: false, error };
    }
  }

  resolve(token: string): NodePrincipal | null {
    if (!this.available || token.length === 0) return null;
    const principal = this.byTokenHash.get(hashToken(token));
    return principal === undefined ? null : { ...principal };
  }

  onRevoked(listener: (principal: NodePrincipal) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }

  hasActiveNode(nodeId: string): boolean {
    for (const principal of this.byTokenHash.values()) {
      if (principal.node_id === nodeId) return true;
    }
    return false;
  }

  async createCredential(input: {
    node_id: string;
    company_pc: boolean;
  }): Promise<NodeCredentialCreation> {
    const token = this.randomBytes(32).toString("base64url");
    const tokenSha256 = hashToken(token);
    const credentialId = this.randomUUID();
    let row: NodeCredentialRow;
    try {
      row = await this.repository.insert({
        credential_id: credentialId,
        node_id: input.node_id,
        company_pc: input.company_pc,
        token_sha256: tokenSha256,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new NodeCredentialConflictError();
      throw error;
    }
    this.byTokenHash.set(tokenSha256, principalFromRow(row));
    this.byCredentialId.set(row.credential_id, tokenSha256);
    return { credential: recordFromRow(row), token };
  }

  async revokeCredential(credentialId: string): Promise<NodeCredentialRevocation> {
    const existing = await this.repository.findById(credentialId);
    if (existing === null) return { outcome: "not_found", credential: null };
    if (existing.revoked_at !== null) {
      this.forget(existing);
      return { outcome: "already_revoked", credential: recordFromRow(existing) };
    }

    const revoked = await this.repository.markRevoked(credentialId, this.now());
    if (revoked === null) {
      const current = await this.repository.findById(credentialId);
      if (current === null) return { outcome: "not_found", credential: null };
      this.forget(current);
      return { outcome: "already_revoked", credential: recordFromRow(current) };
    }

    this.forget(revoked);
    const principal = principalFromRow(revoked);
    for (const listener of [...this.revokedListeners]) {
      try {
        listener({ ...principal });
      } catch {
        // A listener failure must not undo a committed revocation.
      }
    }
    return { outcome: "revoked", credential: recordFromRow(revoked) };
  }

  async listCredentials(includeRevoked: boolean): Promise<NodeCredentialRecord[]> {
    const rows = await this.repository.list(includeRevoked);
    return rows.map(recordFromRow);
  }

  async revokeAndReport(credentialId: string): Promise<NodePairingRevocation | null> {
    const revocation = await this.revokeCredential(credentialId);
    if (revocation.outcome === "not_found") return null;
    return {
      credential_id: revocation.credential.credential_id,
      node_id: revocation.credential.node_id,
      revoked_at: revocation.credential.revoked_at ?? this.now().toISOString(),
    };
  }

  private replaceMap(rows: readonly NodeCredentialActiveRow[]): void {
    this.byTokenHash.clear();
    this.byCredentialId.clear();
    for (const row of rows) {
      this.byTokenHash.set(row.token_sha256, principalFromRow(row));
      this.byCredentialId.set(row.credential_id, row.token_sha256);
    }
  }

  private forget(row: NodeCredentialRow): void {
    const tokenHash = this.byCredentialId.get(row.credential_id) ?? row.token_sha256;
    this.byCredentialId.delete(row.credential_id);
    this.byTokenHash.delete(tokenHash);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function principalFromRow(row: NodeCredentialActiveRow): NodePrincipal {
  return {
    credential_id: row.credential_id,
    node_id: row.node_id,
    company_pc: row.company_pc,
  };
}

function recordFromRow(row: NodeCredentialRow): NodeCredentialRecord {
  return {
    credential_id: row.credential_id,
    node_id: row.node_id,
    company_pc: row.company_pc,
    created_at: isoString(row.created_at),
    revoked_at: row.revoked_at === null ? null : isoString(row.revoked_at),
  };
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "23505";
}
