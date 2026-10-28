import type { ApiRequestContext } from './clientCore';
import type {
  ClaudeAccountDeleteResult,
  ClaudeAccountList,
  ClaudeAuthLoginFlow,
} from '../../../packages/soul-ui/src/lib/usage-summary';
import type {
  UsageData,
  AccountProfile,
  ProfileResponse,
  ProviderUsageSnapshot,
} from './claudeAuthTypes';

export function createAuthEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    getConfig: (): Promise<{ mode: 'single' | 'orchestrator'; nodeId?: string }> =>
      authFetch(`${base}/api/config`).then((r) => readJson(r, 'getConfig')),

    // OAuth 활성화 여부 자체를 확인하는 엔드포인트이므로 인증 전에 호출된다.
    // 서버 설정(create_auth_router)상 /api/auth/*는 verify_auth에서 면제.
    getAuthConfig: (): Promise<{ authEnabled: boolean }> =>
      fetch(`${base}/api/auth/config`).then((r) => readJson(r, 'getAuthConfig')),

    getAuthStatus: (): Promise<{
      authenticated: boolean;
      user: null | {
        email: string;
        name: string;
        picture: string;
        isAdmin?: boolean;
      };
    }> => authFetch(`${base}/api/auth/status`).then((r) =>
      readJson(r, 'getAuthStatus'),
    ),

    getClaudeAuthStatus: (nodeId: string): Promise<{ has_token: boolean }> =>
      authFetch(`${base}/api/nodes/${nodeId}/claude-auth/status`).then((r) =>
        readJson(r, 'getClaudeAuthStatus'),
      ),

    getClaudeAuthAccounts: (nodeId: string): Promise<ClaudeAccountList> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/accounts`).then((r) =>
        readJson(r, 'getClaudeAuthAccounts'),
      ),

    patchClaudeAuthAccount: (
      nodeId: string,
      accountId: string,
      patch: { enabled?: boolean; priority?: number | null },
    ): Promise<ClaudeAccountList> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((r) => readJson(r, 'patchClaudeAuthAccount')),

    deleteClaudeAuthAccount: (nodeId: string, accountId: string): Promise<ClaudeAccountDeleteResult> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      }).then((r) => readJson(r, 'deleteClaudeAuthAccount')),

    startClaudeAuthLogin: (nodeId: string, accountId?: string): Promise<ClaudeAuthLoginFlow> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/logins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountId ? { account_id: accountId } : {}),
      }).then((r) => readJson(r, 'startClaudeAuthLogin')),

    getClaudeAuthLogin: (nodeId: string, loginId: string): Promise<ClaudeAuthLoginFlow> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/logins/${encodeURIComponent(loginId)}`)
        .then((r) => readJson(r, 'getClaudeAuthLogin')),

    submitClaudeAuthLoginCode: (nodeId: string, loginId: string, code: string): Promise<ClaudeAuthLoginFlow> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/logins/${encodeURIComponent(loginId)}/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }).then((r) => readJson(r, 'submitClaudeAuthLoginCode')),

    cancelClaudeAuthLogin: (nodeId: string, loginId: string): Promise<ClaudeAuthLoginFlow> =>
      authFetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/logins/${encodeURIComponent(loginId)}`, {
        method: 'DELETE',
      }).then((r) => readJson(r, 'cancelClaudeAuthLogin')),

    startClaudeAuth: (nodeId: string): Promise<{ authUrl: string }> =>
      authFetch(`${base}/api/nodes/${nodeId}/claude-auth/headless/start`).then((r) =>
        readJson(r, 'startClaudeAuth'),
      ),

    submitClaudeCode: (nodeId: string, code: string): Promise<Response> =>
      authFetch(`${base}/api/nodes/${nodeId}/claude-auth/headless/submit-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),

    deleteClaudeToken: (nodeId: string): Promise<Response> =>
      authFetch(`${base}/api/nodes/${nodeId}/claude-auth/token`, { method: 'DELETE' }),

    getClaudeUsage: (nodeId: string): Promise<UsageData> =>
      authFetch(`${base}/api/nodes/${nodeId}/claude-auth/usage`).then((r) =>
        readJson(r, 'getClaudeUsage'),
      ),

    getProviderUsage: (nodeId: string): Promise<ProviderUsageSnapshot> =>
      authFetch(`${base}/api/nodes/${nodeId}/provider-usage`).then((r) =>
        readJson(r, 'getProviderUsage'),
      ),

    // account unwrap을 client.ts 계열에서 처리하여 호출자가 raw 응답 형태를 알 필요 없게 한다.
    getClaudeProfile: (nodeId: string): Promise<AccountProfile | null> =>
      authFetch(`${base}/api/nodes/${nodeId}/claude-auth/profile`)
        .then((r) => readJson<ProfileResponse>(r, 'getClaudeProfile'))
        .then((d) => d.account ?? null),
  };
}
