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
// The store keeps every session the way the server does: GET answers for released and plain sessions too, the list shows persistent ones only.
type PasInit = { id: string; name: string; agentId: string; preset: string; effort?: string | null; current?: string; currentEffort?: string | null; pending?: { preset: string; effort: string | null } | null; folderId?: string; persistent?: boolean };
const pasAgentNames: Record<string, string> = { 'public-agent': '공개 예시 에이전트', 'public-other-agent': '다른 예시 에이전트' };
const pasSettings = (preset: string, effort: string | null) => ({ default_model: { model_preset: preset, reasoning_effort: effort }, fallback_model: null, show_generation_separator: true, show_character: true, show_jev_candidates: true, animate_character: true, show_turn_usage: true });
const pasSession = (init: PasInit): PersistentSessionResource => ({
  session_id: init.id, display_name: init.name, node_id: 'public-node', folder_id: init.folderId ?? 'public-project', agent_id: init.agentId, agent_name: pasAgentNames[init.agentId] ?? init.agentId,
  persistent: init.persistent ?? true, settings: pasSettings(init.preset, init.effort ?? null),
  runtime: { current_model: { model_preset: init.current ?? init.preset, reasoning_effort: init.currentEffort === undefined ? init.effort ?? null : init.currentEffort, model: `${init.current ?? init.preset}-내부 모델` },
    pending: init.pending ? { target_model_preset: init.pending.preset, target_reasoning_effort: init.pending.effort } : null },
});
const pasStore = new Map<string, PersistentSessionResource>([
  pasSession({ id: 'review-pas-1', name: '공개 예시 관제 세션', agentId: 'public-agent', preset: 'public-model', current: 'public-exhausted-model', pending: { preset: 'public-model', effort: null } }),
  pasSession({ id: 'review-pas-2', name: '공개 예시 두 번째 영구 세션', agentId: 'public-other-agent', preset: 'public-model', current: 'public-exhausted-model', pending: { preset: 'public-model', effort: null } }),
  pasSession({ id: 'review-pas-3', name: '공개 예시 세 번째 영구 세션 이름이 길어지면 줄바꿈되거나 말줄임으로 끊깁니다', agentId: 'public-agent', preset: 'public-exhausted-model', current: 'public-model' }),
].map(item => [item.session_id, item]));
// A session whose stored row has neither a node nor a profile (`persistent-owner-missing`): the server reads it but cannot act on it.
const pasOwnerless: PersistentSessionResource = { ...pasSession({ id: 'review-pas-ownerless', name: '공개 예시 노드 없는 세션', agentId: 'unused', preset: 'public-model' }), node_id: null, agent_id: null, agent_name: null, folder_id: null };
const pasCreateDefaults: PersistentSessionCreateDefaults = {
  node_id: 'public-node', preferred_agent_id: 'public-agent', settings: pasSettings('public-model', null),
  initial_instruction: '새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.', unavailable_reason: null,
};
const pasFailure = (status: number, code: string, message: string, extra: object = {}) => new ApiHttpError(`공개 예시 ${status}`, status, JSON.stringify({ error: { code, message }, ...extra }));
const requirePas = (id: string) => { const found = id === pasOwnerless.session_id ? pasOwnerless : pasStore.get(id); if (!found) throw pasFailure(404, 'SESSION_NOT_FOUND', '영구 에이전트 세션을 찾을 수 없습니다.'); return found; };
const sameEffort = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);
const persistentSessionFixtures = {
  listPersistentSessions: async () => {
    if (state() === 'persistent-error') throw pasFailure(503, 'NODE_UNAVAILABLE', '영구 에이전트 세션을 불러오지 못했습니다.');
    const sessions = state() === 'empty' ? [] : [...pasStore.values(), ...(state() === 'persistent-owner-missing' ? [pasOwnerless] : [])].filter(item => item.persistent);
    return { sessions, total: sessions.length, create_defaults: pasCreateDefaults };
  },
  getPersistentSession: async (id: string) => {
    if (state() === 'persistent-load-error') throw pasFailure(503, 'NODE_UNAVAILABLE', '세션을 불러오지 못했습니다.');
    return { session: requirePas(id) };
  },
  updatePersistentSession: async (id: string, input: PersistentSessionWrite) => {
    if (state() === 'pas-save-loading') return new Promise<never>(() => {});
    if (state() === 'persistent-save-error') throw pasFailure(503, 'NODE_COMMAND_TIMEOUT', '노드가 응답하지 않았습니다.');
    const base = requirePas(id);
    const enabled = 'enabled' in input ? input.enabled : undefined;
    if (enabled === undefined && !base.persistent) throw pasFailure(409, 'NOT_PERSISTENT', '영구 에이전트 세션이 아닙니다.');
    if (enabled === false) { if (!base.node_id) throw pasFailure(404, 'SESSION_OWNER_MISSING', '세션의 소유 노드가 없습니다.'); pasStore.set(id, { ...base, persistent: false }); return { session: pasStore.get(id)!, model_change: 'none' as const }; }
    // The server accepts a name alone or settings alone; a missing default model is only an error when no model is stored either.
    const patch = 'settings' in input ? input.settings : undefined;
    const display_name = 'display_name' in input && input.display_name !== undefined ? input.display_name : base.display_name;
    if (!base.node_id) throw patch?.default_model ? pasFailure(422, 'INVALID_MODEL_PRESET', '노드 없이는 모델을 확인할 수 없습니다.') : pasFailure(404, 'SESSION_OWNER_MISSING', '세션의 소유 노드가 없습니다.');
    const target = patch?.default_model ?? base.settings.default_model;
    if (!target.model_preset) throw pasFailure(422, 'INVALID_REQUEST', '저장된 기본 모델이 없습니다.');
    // Same comparison as the worker: preset and applied effort, against the running model and against a pending target.
    const running = base.runtime.current_model;
    const pending = base.runtime.pending;
    const alreadyRunning = running.model_preset === target.model_preset && sameEffort(running.reasoning_effort, target.reasoning_effort);
    const alreadyPending = Boolean(pending) && pending!.target_model_preset === target.model_preset && sameEffort(pending!.target_reasoning_effort, target.reasoning_effort);
    const changed = !alreadyRunning && !alreadyPending;
    const saved: PersistentSessionResource = { ...base, display_name, persistent: true, settings: { ...base.settings, ...patch, default_model: target },
      runtime: { ...base.runtime, pending: changed ? { target_model_preset: target.model_preset, target_reasoning_effort: target.reasoning_effort } : pending } };
    pasStore.set(id, saved);
    return { session: saved, model_change: changed ? 'next_execution_start' as const : 'none' as const };
  },
  createPersistentSession: async (input: PersistentSessionCreate) => {
    const target = input.settings.default_model;
    const created = pasSession({ id: `review-pas-created-${pasStore.size}`, name: input.display_name, agentId: input.agent_id, folderId: input.folder_id, preset: target.model_preset, effort: target.reasoning_effort });
    const plain = { ...created, persistent: false };
    if (state() === 'persistent-registration-error') {
      pasStore.set(created.session_id, plain);
      throw pasFailure(503, 'PERSISTENT_REGISTRATION_FAILED', '이름과 설정을 기록하지 못했습니다.', { created_session: { session_id: created.session_id, display_name: input.display_name } });
    }
    if (state() === 'persistent-lost-response') { pasStore.set(created.session_id, created); throw new TypeError('Network request failed'); }
    pasStore.set(created.session_id, created);
    return { session: created, creation: 'started' as const, warnings: [] };
  },
};
export const nativeSettingsReviewApi = { ...dialogueApi, ...persistentSessionFixtures,
  listModelPresets: async (nodeId: string) => {
    if (state() === 'persistent-targets-error') throw new Error('공개 예시 오류');
    const result = await dialogueApi.listModelPresets(nodeId);
    return {
      ...result,
      model_presets: result.model_presets.map((preset) => ({
        ...preset,
        weekly_headroom: preset.id === 'public-unavailable-model' ? {
          status: 'unavailable' as const,
          headroom: null,
          remaining_percent: null,
          window_remaining_percent: null,
          resets_at: null,
          observed_at: '2026-10-06T01:00:00Z',
          quota_label: null,
        } : {
          status: 'ok' as const,
          headroom: 22.5,
          remaining_percent: 72.5,
          window_remaining_percent: 50,
          resets_at: '2026-10-09T01:00:00Z',
          observed_at: '2026-10-06T01:00:00Z',
          quota_label: '7일',
        },
      })),
    };
  },
  getTimeline: async (_sessionId: string, params?: { eventTypes?: string[]; before?: string }) => {
    if (state() === 'pas-monitor-loading') return new Promise<never>(() => {});
    if (state() === 'pas-monitor-error') throw new Error('공개 예시 기록 조회 실패');
    if (state() === 'pas-monitor-empty') return { messages: [], next_cursor: null };
    const latestGeneration = { id: 118, parent_event_id: null, event_type: 'generation_started', payload: { generation: 7 }, created_at: '2026-10-06T01:12:00Z' };
    if (params?.eventTypes?.length === 1 && params.eventTypes[0] === 'generation_started') return { messages: [latestGeneration], next_cursor: null };
    if (params?.before === 'public-older') return { messages: [
      { id: 117, parent_event_id: null, event_type: 'complete', payload: { usage: { input_tokens: 842, output_tokens: 126 }, turn_cost_usd: 0.02 }, created_at: '2026-10-05T22:46:00Z' },
      { id: 116, parent_event_id: null, event_type: 'context_usage', payload: { used_tokens: 842, max_tokens: 100000, percent: 0.8 }, created_at: '2026-10-05T22:45:00Z' },
      { id: 115, parent_event_id: null, event_type: 'generation_started', payload: { generation: 6 }, created_at: '2026-10-05T22:44:00Z' },
    ], next_cursor: null };
    return { messages: [
      { id: 120, parent_event_id: null, event_type: 'complete', payload: { usage: { input_tokens: 12540, output_tokens: 912 }, turn_cost_usd: 0.18 }, created_at: '2026-10-06T01:18:00Z' },
      { id: 119, parent_event_id: null, event_type: 'context_usage', payload: { used_tokens: 35200, max_tokens: 200000, percent: 17.6 }, created_at: '2026-10-06T01:17:00Z' },
      latestGeneration,
    ], next_cursor: 'public-older' };
  },
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
