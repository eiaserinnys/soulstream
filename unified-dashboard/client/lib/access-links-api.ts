export type AccessLinkPermission = 'send' | 'read_own' | 'read_history' | 'control';
export interface AccessLink {
  id: string;
  label: string;
  target_session_id: string;
  permissions: AccessLinkPermission[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
export type AccessLinkIssue = Pick<AccessLink, 'target_session_id' | 'label' | 'permissions'> & { expires_in_seconds: number };
export type IssuedAccessLink = Pick<AccessLink, 'id' | 'label' | 'target_session_id' | 'permissions' | 'expires_at'> & { url: string };
export class AccessLinksError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); this.name = 'AccessLinksError'; }
}
export function accessLinkStatus(link: AccessLink, now = Date.now()): 'active' | 'expired' | 'revoked' {
  if (link.revoked_at) return 'revoked';
  return Date.parse(link.expires_at) <= now ? 'expired' : 'active';
}
export function createAccessLinksApi(request: typeof fetch = fetch) {
  const root = '/api/access-links';
  async function call<T>(path: string, method: string, body?: object): Promise<T> {
    const response = await request(root + path, {
      credentials: 'same-origin', method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new AccessLinksError(response.status);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  return {
    list: () => call<AccessLink[]>('', 'GET'),
    issue: (input: AccessLinkIssue) => call<IssuedAccessLink>('', 'POST', input),
    revoke: (id: string) => call<AccessLink | undefined>(`/${encodeURIComponent(id)}`, 'DELETE'),
  };
}
