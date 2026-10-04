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

export function createOwnedAgentsApi(request: typeof fetch = fetch) {
  const root = '/api/owned-agents';
  async function call<T>(path: string, method?: string, body?: object): Promise<T> {
    const response = await request(root + path, {
      credentials: 'same-origin', method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.detail ?? `요청을 처리하지 못했습니다 (HTTP ${response.status})`);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
  return {
    list: () => call<OwnedAgentsResponse>(''),
    create: (name: string) => call<{ agent: Omit<OwnedAgent, 'keys'> }>('', 'POST', { name }),
    update: (id: string, patch: { name?: string; enabled?: boolean }) => call<{ agent: Omit<OwnedAgent, 'keys'> }>(`/${encodeURIComponent(id)}`, 'PATCH', patch),
    registerExisting: () => call<{ agent: Omit<OwnedAgent, 'keys'>; credential: OwnedAgentKey }>('/register-existing', 'POST', {}),
    issueKey: (id: string) => call<{ credential: OwnedAgentKey; token: string }>(`/${encodeURIComponent(id)}/keys`, 'POST'),
    revokeKey: (id: string, keyId: string) => call<void>(`/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}`, 'DELETE'),
  };
}
