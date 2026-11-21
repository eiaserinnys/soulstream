export interface OwnedAgentKey {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  isExistingConnection: boolean;
}
export interface OwnedAgent {
  id: string;
  name: string;
  ownerEmail: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  keys: OwnedAgentKey[];
}
export interface OwnedAgentsResponse {
  agents: OwnedAgent[];
  existingConnection: { configured: boolean; registered: boolean; canRegister: boolean };
}
