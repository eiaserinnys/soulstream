import type { ApiRequestContext } from './clientCore';

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
export type OwnedAgentsApi = ReturnType<typeof createOwnedAgentsEndpoints>;

export function createOwnedAgentsEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  const root = `${base}/api/owned-agents`;
  const write = (path: string, method: string, body?: object) => authFetch(root + path, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return {
    listOwnedAgents: (): Promise<OwnedAgentsResponse> => authFetch(root).then(res => readJson(res, 'listOwnedAgents')),
    createOwnedAgent: (input: { name: string }): Promise<{ agent: Omit<OwnedAgent, 'keys'> }> => write('', 'POST', input).then(res => readJson(res, 'createOwnedAgent')),
    updateOwnedAgent: (id: string, patch: { name?: string; enabled?: boolean }): Promise<{ agent: Omit<OwnedAgent, 'keys'> }> => write(`/${encodeURIComponent(id)}`, 'PATCH', patch).then(res => readJson(res, 'updateOwnedAgent')),
    registerExistingOwnedAgent: (): Promise<{ agent: Omit<OwnedAgent, 'keys'>; credential: OwnedAgentKey }> => write('/register-existing', 'POST', {}).then(res => readJson(res, 'registerExistingOwnedAgent')),
    issueOwnedAgentKey: (id: string): Promise<{ credential: OwnedAgentKey; token: string }> => write(`/${encodeURIComponent(id)}/keys`, 'POST').then(res => readJson(res, 'issueOwnedAgentKey')),
    revokeOwnedAgentKey: async (id: string, keyId: string): Promise<void> => {
      const res = await write(`/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}`, 'DELETE');
      if (!res.ok) await readJson(res, 'revokeOwnedAgentKey');
    },
  };
}
