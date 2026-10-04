import type { ApiClient, RecurringJobDto } from '../api/client';
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
export const nativeSettingsReviewApi = { ...dialogueApi,
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
