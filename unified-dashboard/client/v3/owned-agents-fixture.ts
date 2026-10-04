import type { OwnedAgent, OwnedAgentKey } from '../lib/owned-agents-api';

/** In-memory review transport. No real credentials or ownership changes. */
export function createOwnedAgentsFixture(scenario = 'normal') {
  const now = '2026-10-04T12:00:00Z';
  let agents: OwnedAgent[] = [];
  let registered = false;
  let failed = false;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'https://sample.invalid').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (scenario === 'error' && !failed) { failed = true; return Response.json({ detail: '공개 예시: 요청을 처리하지 못했습니다. 다시 시도해 주세요.' }, { status: 503 }); }
    if (path === '/api/owned-agents' && method === 'GET') return Response.json({ agents, existingConnection: { configured: true, registered, canRegister: scenario !== 'unavailable' && !registered } });
    if ((path === '/api/owned-agents' && method === 'POST') || path.endsWith('/register-existing')) {
      const credential: OwnedAgentKey = { id: `sample-existing-key-${agents.length}`, createdAt: now, lastUsedAt: null, revokedAt: null, isExistingConnection: path.endsWith('/register-existing') };
      const agent: OwnedAgent = { id: `sample-agent-${agents.length}`, name: body.name ?? '기존 연결 도우미', enabled: true, ownerEmail: 'sample@example.invalid', createdAt: now, updatedAt: now, keys: credential.isExistingConnection ? [credential] : [] };
      agents.push(agent); if (credential.isExistingConnection) registered = true;
      return Response.json({ agent, credential });
    }
    const parts = path.split('/');
    const agent = agents.find(a => a.id === parts[3]);
    if (!agent) return Response.json({ detail: '예시 에이전트를 찾을 수 없습니다.' }, { status: 404 });
    if (method === 'PATCH') Object.assign(agent, body);
    if (method === 'POST' && path.endsWith('/keys')) {
      const credential: OwnedAgentKey = { id: `sample-key-${agent.keys.length}`, createdAt: now, lastUsedAt: null, revokedAt: null, isExistingConnection: false };
      agent.keys.push(credential);
      return Response.json({ credential, token: 'FAKE-REVIEW-KEY-DO-NOT-USE' });
    }
    if (method === 'DELETE') { const key = agent.keys.find(k => k.id === parts[5]); if (key) key.revokedAt = now; return new Response(null, { status: 204 }); }
    return Response.json({ agent });
  };
}
