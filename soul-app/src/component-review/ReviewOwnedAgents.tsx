import React, { useMemo, useState } from 'react';
import type { OwnedAgent, OwnedAgentKey, OwnedAgentsApi } from '../api/ownedAgentsEndpoints';
import { OwnedAgentsSettingsSection } from '../components/settings/OwnedAgentsSettingsSection';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';

/** Same native panel with public, in-memory responses. Clipboard uses a fake key. */
export function ReviewOwnedAgents() {
  const [scenario, setScenario] = useState<'normal' | 'unavailable' | 'error'>('normal');
  const api = useMemo(() => createOwnedAgentsReviewApi(scenario), [scenario]);
  return <>
    <SettingsSegmentedControl<'normal' | 'unavailable' | 'error'> id="owned-agents-review" value={scenario} onChange={setScenario} options={[
      { value: 'normal', label: '정상' },
      { value: 'unavailable', label: '등록 불가' },
      { value: 'error', label: '요청 실패' },
    ]}/>
    <OwnedAgentsSettingsSection key={scenario} flattened={false} api={api}/>
  </>;
}

export function createOwnedAgentsReviewApi(scenario: 'normal' | 'unavailable' | 'error'): OwnedAgentsApi {
  const now = '2026-10-04T12:00:00Z';
  let agents: OwnedAgent[] = [];
  let registered = false;
  let failed = false;
  const key = (isExistingConnection = false): OwnedAgentKey => ({ id: `sample-key-${Math.random()}`, createdAt: now, lastUsedAt: null, revokedAt: null, isExistingConnection });
  const create = (name: string) => {
    const agent: OwnedAgent = { id: `sample-agent-${agents.length}`, name, enabled: true, ownerEmail: 'sample@example.invalid', createdAt: now, updatedAt: now, keys: [] };
    agents.push(agent); return agent;
  };
  const find = (id: string) => {
    const agent = agents.find(a => a.id === id);
    if (!agent) throw new Error('예시 에이전트를 찾을 수 없습니다.');
    return agent;
  };
  return {
    listOwnedAgents: async () => {
      if (scenario === 'error' && !failed) { failed = true; throw new Error('공개 예시: 요청을 처리하지 못했습니다. 다시 시도해 주세요.'); }
      return structuredClone({ agents, existingConnection: { configured: true, registered, canRegister: scenario !== 'unavailable' && !registered } });
    },
    createOwnedAgent: async ({ name }) => ({ agent: create(name) }),
    updateOwnedAgent: async (id, patch) => { const agent = find(id); Object.assign(agent, patch); return { agent }; },
    registerExistingOwnedAgent: async () => { registered = true; const agent = create('기존 연결 도우미'); const credential = key(true); agent.keys.push(credential); return { agent, credential }; },
    issueOwnedAgentKey: async id => { const credential = key(); find(id).keys.push(credential); return { credential, token: 'FAKE-REVIEW-KEY-DO-NOT-USE' }; },
    revokeOwnedAgentKey: async (id, keyId) => { const credential = find(id).keys.find(k => k.id === keyId); if (credential) credential.revokedAt = now; },
  };
}
