export type OwnedAgent = { id: string; ownerEmail: string; name: string; enabled: boolean; createdAt: string; updatedAt: string };
export type AgentCredential = { id: string; agentId: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type CredentialRecord = AgentCredential & { agent: OwnedAgent };
export interface OwnedAgentRepository {
  list(ownerEmail: string): Promise<OwnedAgent[]>;
  find(id: string): Promise<OwnedAgent | null>;
  create(ownerEmail: string, name: string): Promise<OwnedAgent>;
  update(id: string, ownerEmail: string, update: { name?: string; enabled?: boolean }): Promise<OwnedAgent | null>;
  keys(agentId: string): Promise<AgentCredential[]>;
  credential(hash: string): Promise<CredentialRecord | null>;
  issue(agentId: string, createdBy: string, hash: string): Promise<AgentCredential>;
  revoke(agentId: string, keyId: string): Promise<boolean>;
  touch(keyId: string): Promise<void>;
  registerExisting(ownerEmail: string, name: string, hash: string): Promise<CredentialRecord>;
}
export class OwnedAgentError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
