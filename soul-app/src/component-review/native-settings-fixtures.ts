import type { ApiClient, PersistentSessionCreate, PersistentSessionCreateDefaults, PersistentSessionResource, PersistentSessionWrite, RecurringJobDto } from '../api/client';
import type { SessionReviewPolicyPayload } from '../api/settingsEndpoints';
import type { ProviderUsageSnapshot, ProviderQuota } from '../api/claudeAuthTypes';
import { ApiHttpError } from '../api/clientCore';
import { dialogueApi } from './dialogue-fixtures';

// Public in-memory DTO fixtures only. No production configuration or credentials.
const quota = (id: string, usedPercent: number | null): ProviderQuota => ({ id, label: `공개 예시 ${id}`, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, window: null, unit: null, model: null, source: 'public-fixture', used: null, remaining: null, limit: null, resetAt: 1800000000 });
const usage: ProviderUsageSnapshot = { generatedAt: '2026-10-04T00:00:00Z', providers: {
  claude: { status: 'auto', source: 'public-fixture', planType: '공개 예시', quotas: [quota('5h', 0), quota('weekly', 50.125), quota('amount-only', null)] },
  codex: { status: 'auto', source: 'public-fixture', planType: '공개 예시', quotas: [quota('primary', 120.125), quota('secondary', null)] },
  gemini: { status: 'not_configured', source: 'public-fixture', planType: null, quotas: [] },
} };
let policy: SessionReviewPolicyPayload = { policy: { key: 'session_review_policy', sourceAllowlist: ['slack'], version: 1, updatedBy: '공개 예시', updatedAt: '2026-10-04T00:00:00Z' }, conditionalRules: [], sourceCatalog: ['slack', 'soul-app', 'external-llm', 'clipper', 'llm', 'agent', 'system', 'cron', 'channel_observer'].map(source => ({ source, label: source, description: '공개 예시 출처', automatic: ['llm', 'agent', 'system', 'cron', 'channel_observer'].includes(source) })) };
let jobs: RecurringJobDto[] = Array.from({ length: 12 }, (_, index) => ({
  job_id: `review-job-${index}`, name: `공개 예시 반복 작업 ${index + 1}`, prompt: '공개 예시 작업 내용', timezone: 'Asia/Seoul', schedule_expressions: ['0 9 * * 1-5'], node_id: 'public-node', agent_id: 'public-agent', model_preset: null, folder_id: 'public-project', late_run_window_seconds: 1800, enabled: true, archived_at: null, version: 1, next_run_at: '2026-10-05T00:00:00Z', created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
}));
const state = () => new URLSearchParams(window.location.search).get('state');

// Persistent agent sessions. Ids, agents and presets match the public node fixtures served by dialogueApi.
const pasSettings = (preset: string) => ({ default_model: { model_preset: preset, reasoning_effort: null }, fallback_model: null, show_generation_separator: true, show_character: true });
const pasSession = (id: string, name: string, agentId: string, agentName: string, preset: string, current: string, pending: string | null): PersistentSessionResource => ({
  session_id: id, display_name: name, node_id: 'public-node', folder_id: 'public-project', agent_id: agentId, agent_name: agentName, persistent: true, settings: pasSettings(preset),
  runtime: { current_model: { model_preset: current, reasoning_effort: null, model: `${current}-내부 모델` }, pending: pending ? { target_model_preset: pending, target_reasoning_effort: null } : null },
});
let persistentSessions: PersistentSessionResource[] = [
  pasSession('review-pas-1', '공개 예시 관제 세션', 'public-agent', '공개 예시 에이전트', 'public-model', 'public-model', null),
  pasSession('review-pas-2', '공개 예시 두 번째 영구 세션', 'public-other-agent', '다른 예시 에이전트', 'public-model', 'public-exhausted-model', 'public-model'),
  pasSession('review-pas-3', '공개 예시 세 번째 영구 세션 이름이 길어지면 줄바꿈되거나 말줄임으로 끊깁니다', 'public-agent', '공개 예시 에이전트', 'public-exhausted-model', 'public-model', null),
];
const plainSessions = new Map<string, PersistentSessionResource>();
const createDefaults: PersistentSessionCreateDefaults = {
  node_id: 'public-node', preferred_agent_id: 'public-agent', settings: pasSettings('public-model'),
  initial_instruction: '새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.', unavailable_reason: null,
};
const pasFailure = (status: number, code: string, message: string, extra: object = {}) => new ApiHttpError(`공개 예시 ${status}`, status, JSON.stringify({ error: { code, message }, ...extra }));
const requirePas = (id: string) => { const found = persistentSessions.find(item => item.session_id === id); if (!found) throw pasFailure(404, 'SESSION_NOT_FOUND', '영구 에이전트 세션을 찾을 수 없습니다.'); return found; };
const persistentSessionFixtures = {
  listPersistentSessions: async () => {
    if (state() === 'persistent-error') throw pasFailure(503, 'NODE_UNAVAILABLE', '영구 에이전트 세션을 불러오지 못했습니다.');
    const sessions = state() === 'empty' ? [] : persistentSessions;
    return { sessions, total: sessions.length, create_defaults: createDefaults };
  },
  getPersistentSession: async (id: string) => ({ session: requirePas(id) }),
  updatePersistentSession: async (id: string, input: PersistentSessionWrite) => {
    if (state() === 'persistent-save-error') throw pasFailure(503, 'NODE_COMMAND_TIMEOUT', '노드가 응답하지 않았습니다.');
    if ('enabled' in input && input.enabled === false) { const released = requirePas(id); persistentSessions = persistentSessions.filter(item => item.session_id !== id); return { session: { ...released, persistent: false }, model_change: 'none' as const }; }
    const registering = plainSessions.get(id);
    const base = registering ?? requirePas(id);
    const model = input.settings.default_model;
    const changed = model.model_preset !== base.runtime.current_model.model_preset && base.runtime.pending?.target_model_preset !== model.model_preset;
    const saved: PersistentSessionResource = { ...base, display_name: input.display_name, persistent: true, settings: { ...base.settings, default_model: model },
      runtime: { ...base.runtime, pending: changed ? { target_model_preset: model.model_preset, target_reasoning_effort: model.reasoning_effort } : base.runtime.pending } };
    if (registering) { plainSessions.delete(id); persistentSessions = [...persistentSessions, saved]; }
    else persistentSessions = persistentSessions.map(item => item.session_id === id ? saved : item);
    return { session: saved, model_change: changed ? 'next_execution_start' as const : 'none' as const };
  },
  createPersistentSession: async (input: PersistentSessionCreate) => {
    const created = pasSession(`review-pas-created-${persistentSessions.length + plainSessions.size}`, input.display_name, input.agent_id, input.agent_id, input.settings.default_model.model_preset, input.settings.default_model.model_preset, null);
    if (state() === 'persistent-registration-error') {
      plainSessions.set(created.session_id, created);
      throw pasFailure(503, 'PERSISTENT_REGISTRATION_FAILED', '이름과 설정을 기록하지 못했습니다.', { created_session: { session_id: created.session_id, display_name: input.display_name } });
    }
    persistentSessions = [...persistentSessions, created];
    return { session: created, creation: 'started' as const, warnings: [] };
  },
};
export const nativeSettingsReviewApi = { ...dialogueApi, ...persistentSessionFixtures,
  getAuthStatus: async () => ({ authenticated: true, user: { isAdmin: true } }),
  listNodes: async () => { if (state() === 'nodes-error') throw new Error('공개 예시 오류'); return { nodes: Array.from({ length: 8 }, (_, index) => ({ nodeId: index === 0 ? 'public-node' : `public-node-${index}` })) }; },
  getProviderUsage: async () => { if (state() === 'usage-error') throw new Error('공개 예시 오류'); return usage; },
  listRecurringJobs: async () => ({ jobs: state() === 'empty' ? [] : jobs }),
  createRecurringJob: async (input: any) => { const job = { ...jobs[0], ...input, job_id: 'review-created', version: 1 }; jobs = [...jobs, job]; return { job }; },
  updateRecurringJob: async (id: string, input: any) => { const job = jobs.find(item => item.job_id === id)!; if (input.expected_version !== job.version) throw new ApiHttpError('conflict', 409, '{}'); const saved = { ...job, ...input, version: job.version + 1 }; jobs = jobs.map(item => item.job_id === id ? saved : item); return { job: saved }; },
  archiveRecurringJob: async (id: string) => { const job = jobs.find(item => item.job_id === id)!; const saved = { ...job, archived_at: new Date().toISOString(), enabled: false, version: job.version + 1 }; jobs = jobs.map(item => item.job_id === id ? saved : item); return { job: saved }; },
  runRecurringJob: async () => ({ run_id: 'public-run', session_id: 'public-session' }),
  previewRecurringSchedule: async () => ({ nextRuns: ['2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'] }),
  listRecurringJobRuns: async () => ({ runs: [] }),
  getSessionReviewPolicy: async () => policy,
  updateSessionReviewPolicy: async (input: any) => { if (input.expectedVersion !== policy.policy.version) throw new ApiHttpError('conflict', 409, '{}'); policy = { ...policy, policy: { ...policy.policy, sourceAllowlist: input.sourceAllowlist, version: policy.policy.version + 1 } }; return policy; },
} as unknown as ApiClient;
