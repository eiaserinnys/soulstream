export type NodePrincipal = {
  credential_id: string;
  node_id: string;
  company_pc: boolean;
};

/**
 * Request-time surface of the node credential map. `resolve` stays synchronous
 * and memory-only so bearer checking never reads the database per request.
 */
export interface NodeCredentialResolver {
  resolve(token: string): NodePrincipal | null;
  onRevoked(listener: (principal: NodePrincipal) => void): () => void;
}

export type NodeCredentialActiveRow = {
  credential_id: string;
  node_id: string;
  company_pc: boolean;
  token_sha256: string;
};

export type NodeCredentialRow = NodeCredentialActiveRow & {
  created_at: Date | string;
  revoked_at: Date | string | null;
};

export type NodeCredentialInsert = NodeCredentialActiveRow;

/** Serialized row shape used by list/revoke results: the hash never leaves the store. */
export type NodeCredentialRecord = {
  credential_id: string;
  node_id: string;
  company_pc: boolean;
  created_at: string;
  revoked_at: string | null;
};

export type NodePairingApproval = {
  credential_id: string;
  node_id: string;
  company_pc: boolean;
};

export type NodePairingRevocation = {
  credential_id: string;
  node_id: string;
  revoked_at: string;
};

/** Dependency surface the MCP handlers use; implemented by NodePairingService. */
export type NodePairingHostOptions = {
  approve(userCode: string): Promise<NodePairingApproval>;
  list(includeRevoked: boolean): Promise<NodeCredentialRecord[]>;
  revoke(credentialId: string): Promise<NodePairingRevocation>;
};
