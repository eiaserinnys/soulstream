import {
  captureAuthScope,
  clearAuthForScope,
  type AuthScopeSnapshot,
} from '../lib/auth-scope';

export interface ApiRequestContext {
  base: string;
  authFetch: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  readJson: <T>(res: Response, op: string) => Promise<T>;
  buildQuery: (params?: Record<string, unknown>) => string;
}

export interface ApiRequestContextOptions {
  /** undefined면 기존처럼 매 요청 시 authStore를 읽는다. */
  authToken?: string | null;
  /** resolver·mutation처럼 한 작업 전체가 같은 인증 수명을 써야 할 때 고정한다. */
  authScope?: AuthScopeSnapshot;
}

export class ApiHttpError extends Error {
  readonly name = 'ApiHttpError';

  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export function createApiRequestContext(
  baseUrl: string,
  options: ApiRequestContextOptions = {},
): ApiRequestContext {
  const base = baseUrl.replace(/\/$/, '');
  const pinnedScope = options.authScope;
  const authPinned = Boolean(pinnedScope)
    || Object.prototype.hasOwnProperty.call(options, 'authToken');
  const pinnedAuthToken = pinnedScope?.jwt ?? options.authToken ?? null;

  async function authFetch(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const requestScope = pinnedScope ?? (authPinned ? null : captureAuthScope());
    const jwt = authPinned ? pinnedAuthToken : requestScope?.jwt ?? null;
    const headers = new Headers(init.headers);
    if (jwt) headers.set('Authorization', `Bearer ${jwt}`);
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401 && requestScope) {
      // API 401은 인증 거부로 취급한다. 요청 시작 때 고정한 opaque generation이
      // 여전히 현재일 때만 거부 상태를 기록해 이전 계정 응답이 새 로그인을 취소하지 않게 한다.
      clearAuthForScope(requestScope);
    }
    return res;
  }

  async function readJson<T>(res: Response, op: string): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      throw new ApiHttpError(
        `[${op}] HTTP ${res.status} ${res.statusText}` +
          (snippet ? ` — ${snippet}` : ''),
        res.status,
        text,
      );
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('application/json')) {
      const text = await res.text().catch(() => '');
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      throw new Error(
        `[${op}] 서버 응답이 JSON이 아닙니다 (Content-Type: ${ct || 'unknown'})` +
          (snippet ? ` — ${snippet}` : ''),
      );
    }
    return res.json() as Promise<T>;
  }

  return { base, authFetch, readJson, buildQuery };
}

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}
