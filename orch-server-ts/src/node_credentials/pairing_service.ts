import { randomBytes } from "node:crypto";

import {
  NodeCredentialConflictError,
  type NodeCredentialCreation,
} from "./credential_store.js";
import type {
  NodeCredentialRecord,
  NodePairingApproval,
  NodePairingHostOptions,
  NodePairingRevocation,
} from "./types.js";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
// 0/O, 1/I/L and U are excluded so a code read aloud cannot be mistaken.
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const USER_CODE_LENGTH = 8;
export const NODE_PAIRING_TTL_MS = 10 * 60 * 1000;
export const NODE_PAIRING_MAX_PENDING = 20;
export const NODE_PAIRING_INTERVAL_SECS = 3;

export type NodePairingErrorCode = "invalid_input" | "not_found" | "limit" | "conflict";
export type NodePairingConflictReason = "active_credential" | "connected" | "stored_node";

export class NodePairingError extends Error {
  readonly code: NodePairingErrorCode;
  readonly conflictReason?: NodePairingConflictReason;

  constructor(
    code: NodePairingErrorCode,
    message: string,
    conflictReason?: NodePairingConflictReason,
  ) {
    super(message);
    this.name = "NodePairingError";
    this.code = code;
    this.conflictReason = conflictReason;
  }
}

export type NodePairingStarted = {
  device_code: string;
  user_code: string;
  expires_at: string;
  interval_secs: number;
};

export type NodePairingPollResult =
  | { status: "pending" }
  | { status: "approved"; node_id: string; company_pc: boolean; token: string };

export type NodePairingStore = {
  hasActiveNode(nodeId: string): boolean;
  createCredential(input: { node_id: string; company_pc: boolean }): Promise<NodeCredentialCreation>;
  listCredentials(includeRevoked: boolean): Promise<NodeCredentialRecord[]>;
  revokeAndReport(credentialId: string): Promise<NodePairingRevocation | null>;
};

export type NodePairingServiceOptions = {
  store: NodePairingStore;
  isNodeConnected: (nodeId: string) => boolean | Promise<boolean>;
  hasStoredNode: (nodeId: string) => boolean | Promise<boolean>;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

type PairingEntry = {
  device_code: string;
  user_code: string;
  display_user_code: string;
  node_id: string;
  company_pc: boolean;
  expires_at_ms: number;
  approval?: NodePairingApproval;
  token?: string;
};

/**
 * Pending pairings live only in process memory; losing them on restart is the
 * intended behavior because the device simply starts a new request.
 */
export class NodePairingService implements NodePairingHostOptions {
  private readonly store: NodePairingStore;
  private readonly isNodeConnected: (nodeId: string) => boolean | Promise<boolean>;
  private readonly hasStoredNode: (nodeId: string) => boolean | Promise<boolean>;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly byDeviceCode = new Map<string, PairingEntry>();
  private readonly byUserCode = new Map<string, PairingEntry>();

  constructor(options: NodePairingServiceOptions) {
    this.store = options.store;
    this.isNodeConnected = options.isNodeConnected;
    this.hasStoredNode = options.hasStoredNode;
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? randomBytes;
  }

  async start(input: unknown): Promise<NodePairingStarted> {
    this.cleanupExpired();
    const body = isRecord(input) ? input : {};
    const nodeId = body.node_id;
    const companyPc = body.company_pc;
    if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
      throw new NodePairingError(
        "invalid_input",
        "node_id must match ^[a-z0-9][a-z0-9-]{1,62}$",
      );
    }
    if (typeof companyPc !== "boolean") {
      throw new NodePairingError("invalid_input", "company_pc must be a boolean");
    }
    if (this.pendingCount() >= NODE_PAIRING_MAX_PENDING) {
      throw new NodePairingError("limit", "too many pending node pairing requests");
    }

    const deviceCode = this.randomBytes(32).toString("base64url");
    const userCode = this.generateUserCode();
    const expiresAtMs = this.now() + NODE_PAIRING_TTL_MS;
    const entry: PairingEntry = {
      device_code: deviceCode,
      user_code: userCode,
      display_user_code: formatUserCode(userCode),
      node_id: nodeId,
      company_pc: companyPc,
      expires_at_ms: expiresAtMs,
    };
    this.byDeviceCode.set(deviceCode, entry);
    this.byUserCode.set(userCode, entry);
    return {
      device_code: deviceCode,
      user_code: entry.display_user_code,
      expires_at: new Date(expiresAtMs).toISOString(),
      interval_secs: NODE_PAIRING_INTERVAL_SECS,
    };
  }

  async poll(deviceCode: unknown): Promise<NodePairingPollResult> {
    this.cleanupExpired();
    if (typeof deviceCode !== "string" || deviceCode.length === 0) {
      throw notFound();
    }
    const entry = this.byDeviceCode.get(deviceCode);
    if (entry === undefined) throw notFound();
    if (entry.approval === undefined) return { status: "pending" };
    const token = entry.token;
    if (token === undefined) throw notFound();
    entry.token = undefined;
    return {
      status: "approved",
      node_id: entry.node_id,
      company_pc: entry.company_pc,
      token,
    };
  }

  async approve(userCode: unknown): Promise<NodePairingApproval> {
    this.cleanupExpired();
    if (typeof userCode !== "string") throw notFound();
    const entry = this.byUserCode.get(normalizeUserCode(userCode));
    if (entry === undefined) throw notFound();
    if (entry.approval !== undefined) return { ...entry.approval };

    if (this.store.hasActiveNode(entry.node_id)) {
      throw new NodePairingError(
        "conflict",
        "node already has an active credential (node_credentials)",
        "active_credential",
      );
    }
    if (await this.isNodeConnected(entry.node_id)) {
      throw new NodePairingError(
        "conflict",
        "node is currently connected to the orchestrator",
        "connected",
      );
    }
    if (await this.hasStoredNode(entry.node_id)) {
      throw new NodePairingError(
        "conflict",
        "node appears in the orchestrator node inventory (soulstream_node_heartbeats)",
        "stored_node",
      );
    }

    let created: NodeCredentialCreation;
    try {
      created = await this.store.createCredential({
        node_id: entry.node_id,
        company_pc: entry.company_pc,
      });
    } catch (error) {
      if (error instanceof NodeCredentialConflictError) {
        throw new NodePairingError("conflict", error.message, "active_credential");
      }
      throw error;
    }

    const approval: NodePairingApproval = {
      credential_id: created.credential.credential_id,
      node_id: created.credential.node_id,
      company_pc: created.credential.company_pc,
    };
    entry.approval = approval;
    entry.token = created.token;
    return { ...approval };
  }

  async list(includeRevoked: boolean): Promise<NodeCredentialRecord[]> {
    return await this.store.listCredentials(includeRevoked);
  }

  async revoke(credentialId: string): Promise<NodePairingRevocation> {
    const revoked = await this.store.revokeAndReport(credentialId);
    if (revoked === null) {
      throw new NodePairingError("not_found", "node credential not found");
    }
    return revoked;
  }

  private pendingCount(): number {
    let count = 0;
    for (const entry of this.byDeviceCode.values()) {
      if (entry.approval === undefined) count += 1;
    }
    return count;
  }

  private generateUserCode(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const bytes = this.randomBytes(USER_CODE_LENGTH);
      let code = "";
      for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
        code += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length];
      }
      if (!this.byUserCode.has(code)) return code;
    }
    throw new NodePairingError("limit", "could not allocate a user code");
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const entry of [...this.byDeviceCode.values()]) {
      if (entry.expires_at_ms <= now) {
        this.byDeviceCode.delete(entry.device_code);
        this.byUserCode.delete(entry.user_code);
      }
    }
  }
}

function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, "");
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function notFound(): NodePairingError {
  return new NodePairingError("not_found", "node pairing request not found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
