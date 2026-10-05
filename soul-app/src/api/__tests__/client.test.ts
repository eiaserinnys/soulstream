import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

// 업로드 조각은 expo-file-system File에서 바이트를 읽는다. 직렬화 계약은
// nativeUpload.contract.test.ts가 기기 조건으로 검증하고, 여기서는 요청 모양만 본다.
jest.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get name(): string {
      return this.uri.split('/').pop() ?? '';
    }
    readonly type = '';
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array([1, 2, 3]);
    }
  },
}));

const BASE = 'http://test.example';
const NODE = 'node-x';

function makeFetchMock(
  body: unknown,
  status = 200,
  contentType: string = 'application/json',
  statusText?: string,
) {
  // body가 문자열이면 그 자체를 text로, 객체면 JSON 직렬화. readJson의
  // !res.ok 분기와 비-JSON 분기 모두에서 res.text() 경로가 호출되므로
  // text 메소드도 함께 mock한다.
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText ?? (status >= 200 && status < 300 ? 'OK' : 'Error'),
    json: async () => body,
    text: async () => text,
    headers: new Headers({ 'Content-Type': contentType }),
  } as Partial<Response>);
  (global as any).fetch = fn;
  return fn;
}

beforeEach(() => {
  useAuthStore.setState({ jwt: 'test-jwt', authRejected: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('client request core', () => {
  it('normalizes a trailing slash base URL and injects auth for getConfig', async () => {
    const fetchMock = makeFetchMock({ mode: 'orchestrator', nodeId: 'node-a' });
    const api = createApiClient(`${BASE}/`);

    const config = await api.getConfig();

    expect(config).toEqual({ mode: 'orchestrator', nodeId: 'node-a' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/config`);
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });

  it('clears auth state on 401 before readJson throws', async () => {
    makeFetchMock(
      { detail: 'unauthorized' },
      401,
      'application/json',
      'Unauthorized',
    );
    const api = createApiClient(BASE);

    await expect(api.getConfig()).rejects.toThrow(
      /\[getConfig\] HTTP 401 Unauthorized/,
    );
    expect(useAuthStore.getState().jwt).toBeNull();
  });
});

describe('client.getAuthConfig', () => {
  it('uses unauthenticated fetch before OAuth login is available', async () => {
    const fetchMock = makeFetchMock({ authEnabled: true });
    const api = createApiClient(BASE);

    await expect(api.getAuthConfig()).resolves.toEqual({ authEnabled: true });

    expect(fetchMock.mock.calls[0]).toEqual([`${BASE}/api/auth/config`]);
  });
});

describe('client.getCatalog', () => {
  it('forwards one AbortSignal to both folders and sessions fetches', async () => {
    const fetchMock = makeFetchMock({ folders: [], sessions: [], total: 0 });
    const signal = new AbortController().signal;
    const api = createApiClient(BASE);
    const getCatalog = api.getCatalog as unknown as (
      params: { feed_only: boolean },
      request: { signal: AbortSignal },
    ) => Promise<unknown>;

    await getCatalog({ feed_only: true }, { signal });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(signal);
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBe(signal);
  });
});

describe('client admin review policy endpoints', () => {
  it('reads native admin status with the bearer JWT', async () => {
    const fetchMock = makeFetchMock({
      authenticated: true,
      user: { email: 'admin@example.com', isAdmin: true },
    });

    await expect(createApiClient(BASE).getAuthStatus()).resolves.toMatchObject({
      authenticated: true,
      user: { isAdmin: true },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/auth/status`);
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });

  it('reads and updates the versioned PostgreSQL review policy', async () => {
    const policy = {
      policy: {
        key: 'session_review_policy',
        sourceAllowlist: ['slack'],
        version: 7,
        updatedAt: '2026-09-14T00:00:00Z',
        updatedBy: 'admin@example.com',
      },
      conditionalRules: [],
      sourceCatalog: [],
    };
    const fetchMock = makeFetchMock(policy);
    const api = createApiClient(BASE);

    await expect(api.getSessionReviewPolicy()).resolves.toEqual(policy);
    const updatedPolicy = {
      ...policy,
      policy: { ...policy.policy, sourceAllowlist: ['clipper'], version: 8 },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => updatedPolicy,
      text: async () => JSON.stringify(updatedPolicy),
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    await api.updateSessionReviewPolicy({
      sourceAllowlist: ['clipper'],
      expectedVersion: 7,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/admin/settings/session-review-policy`,
    );
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/api/admin/settings/session-review-policy`);
    expect(init).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ sourceAllowlist: ['clipper'], expectedVersion: 7 }),
    });
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer test-jwt');
  });
});

describe('client folder board endpoints', () => {
  it('reads the folder board and markdown/custom-view documents through server routes', async () => {
    const fetchMock = makeFetchMock({ boardItems: [] });
    const api = createApiClient(BASE);

    await expect(api.getFolderBoardItems('folder/0')).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/board-items?folderId=folder%2F0`,
    );

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ boardItems: [{
        id: 'folder:1', folderId: 'folder/1', membershipKind: 'primary',
        cardId: 'item/1', itemType: 'subfolder', itemId: 'child/1',
        x: 10, y: 20, metadata: { title: '하위 폴더' },
        createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
      }] }),
      text: async () => '',
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    await expect(api.getFolderBoardItems('folder/1')).resolves.toEqual([expect.objectContaining({
      id: 'folder:1', folderId: 'folder/1', cardId: 'item/1',
      itemType: 'subfolder', itemId: 'child/1', metadata: { title: '하위 폴더' },
      createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    })]);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/board-items?folderId=folder%2F1`);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ boardItems: [{ id: 'session:1', itemType: 'session' }] }),
      text: async () => '',
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    await expect(api.getSessionBoardItems('session/1')).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE}/api/board-items?sessionId=session%2F1`);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'doc/1', title: '문서', body: '# 본문', version: 1 }),
      text: async () => '',
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    await api.getMarkdownDocument('doc/1');
    expect(fetchMock.mock.calls[3][0]).toBe(`${BASE}/api/markdown-documents/doc%2F1`);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'view/1', html: '<p>Flux</p>', revision: 1 }),
      text: async () => '',
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    await api.getCustomView('view/1');
    expect(fetchMock.mock.calls[4][0]).toBe(`${BASE}/api/custom-views/view%2F1`);
  });

  it('moves a board item to a folder with the strict server body', async () => {
    const fetchMock = makeFetchMock({ ok: true, boardItem: { id: 'board/1', folderId: 'folder/1' } });
    await createApiClient(BASE).moveBoardItemToFolder('board/1', 'folder/1', 'move-key');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/board-items/board%2F1/folder`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ folderId: 'folder/1', idempotencyKey: 'move-key' });
  });
});

describe('client session→task resolver reads', () => {
  it('uses repeated session_id query keys for targeted cold-start hydration', async () => {
    const fetchMock = makeFetchMock({
      sessions: [{
        agentSessionId: 'session/a',
        displayName: 'A',
        status: 'complete',
        createdAt: '2026-07-18T00:00:00Z',
        updatedAt: '2026-07-18T00:00:00Z',
      }],
    });

    const controller = new AbortController();
    await expect(createApiClient(BASE).getSessionsByIds(
      ['session/a', 'session b'],
      controller.signal,
    ))
      .resolves.toMatchObject([{ agentSessionId: 'session/a' }]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/sessions?limit=2&session_id=session%2Fa&session_id=session+b`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });

  it('deduplicates and batches targeted session hydration at the server 200-id limit', async () => {
    const fetchMock = makeFetchMock({ sessions: [] });
    const ids = Array.from({ length: 201 }, (_, index) => `session-${index}`);

    await expect(createApiClient(BASE).getSessionsByIds([...ids, ids[0]])).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(fetchMock.mock.calls[0][0]);
    const second = new URL(fetchMock.mock.calls[1][0]);
    expect(first.searchParams.get('limit')).toBe('200');
    expect(first.searchParams.getAll('session_id')).toHaveLength(200);
    expect(second.searchParams.get('limit')).toBe('1');
    expect(second.searchParams.getAll('session_id')).toEqual(['session-200']);
  });
});

describe('client.getClaudeUsage', () => {
  it('GETs /api/nodes/{nodeId}/claude-auth/usage with Bearer header', async () => {
    const fetchMock = makeFetchMock({
      five_hour: { utilization: 30, resets_at: '2026-05-05T10:00:00Z' },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      seven_day_oauth_apps: null,
      seven_day_cowork: null,
      iguana_necktie: null,
      extra_usage: null,
    });
    const api = createApiClient(BASE);
    const usage = await api.getClaudeUsage(NODE);

    expect(usage.five_hour?.utilization).toBe(30);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/nodes/${NODE}/claude-auth/usage`);
    // method 미지정 — 기본 GET. headers에는 Bearer 주입 확인
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });
});

describe('client Claude auth endpoints', () => {
  it('preserves status/start/submit/delete paths, methods, bodies, and auth', async () => {
    const fetchMock = makeFetchMock({
      has_token: true,
      authUrl: 'https://auth.example',
    });
    const api = createApiClient(BASE);

    await api.getClaudeAuthStatus(NODE);
    await api.startClaudeAuth(NODE);
    await api.submitClaudeCode(NODE, 'code-123');
    await api.deleteClaudeToken(NODE);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/nodes/${NODE}/claude-auth/status`,
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/api/nodes/${NODE}/claude-auth/headless/start`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${BASE}/api/nodes/${NODE}/claude-auth/headless/submit-code`,
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      `${BASE}/api/nodes/${NODE}/claude-auth/token`,
    );

    const submitInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(submitInit.method).toBe('POST');
    expect(JSON.parse(submitInit.body as string)).toEqual({ code: 'code-123' });
    expect((submitInit.headers as Headers).get('Content-Type')).toBe(
      'application/json',
    );

    const deleteInit = fetchMock.mock.calls[3][1] as RequestInit;
    expect(deleteInit.method).toBe('DELETE');
    expect((deleteInit.headers as Headers).get('Authorization')).toBe(
      'Bearer test-jwt',
    );
  });
});

describe('client.getProviderUsage', () => {
  it('GETs /api/nodes/{nodeId}/provider-usage with Bearer header', async () => {
    const fetchMock = makeFetchMock({
      generatedAt: '2026-05-23T00:00:00.000Z',
      providers: {
        claude: { status: 'not_configured', source: '', planType: null, quotas: [] },
        codex: {
          status: 'auto',
          source: 'codex-api',
          planType: 'pro',
          quotas: [
            {
              id: 'codex:5h',
              label: '5시간',
              window: '5h',
              unit: 'percent',
              used: null,
              remaining: null,
              limit: null,
              usedPercent: 30,
              remainingPercent: 70,
              resetAt: 1779550026,
              model: null,
              source: 'codex-api',
            },
          ],
        },
        gemini: { status: 'not_configured', source: '', planType: null, quotas: [] },
      },
    });
    const api = createApiClient(BASE);
    const usage = await api.getProviderUsage(NODE);

    expect(usage.providers.codex.quotas[0]?.usedPercent).toBe(30);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/nodes/${NODE}/provider-usage`);
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });
});

describe('client.getClaudeProfile', () => {
  it('GETs /profile and unwraps account when present', async () => {
    const fetchMock = makeFetchMock({
      account: {
        email: 'user@example.com',
        display_name: 'User',
        has_claude_max: true,
      },
    });
    const api = createApiClient(BASE);
    const profile = await api.getClaudeProfile(NODE);

    expect(profile).toEqual({
      email: 'user@example.com',
      display_name: 'User',
      has_claude_max: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/nodes/${NODE}/claude-auth/profile`);
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });

  it('returns null when account is null', async () => {
    makeFetchMock({ account: null });
    const api = createApiClient(BASE);
    const profile = await api.getClaudeProfile(NODE);
    expect(profile).toBeNull();
  });
});

describe('client user preferences endpoints', () => {
  it('GETs and normalizes /api/user/preferences with auth', async () => {
    const fetchMock = makeFetchMock({
      email: 'user@example.com',
      appearance: 'dark',
      wallpaper: { mode: 'photo', customImage: '/api/user/background?v=1' },
      hasBackground: true,
      backgroundUrl: '/api/user/background?v=1',
      updatedAt: '2026-06-14T00:00:00Z',
    });
    const api = createApiClient(BASE);

    const preferences = await api.getUserPreferences();

    expect(preferences.appearance).toBe('dark');
    expect(preferences.wallpaper).toEqual({
      mode: 'photo',
      customImage: '/api/user/background?v=1',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/user/preferences`);
    expect((init as RequestInit).method).toBeUndefined();
    expect(((init as RequestInit).headers as Headers).get('Authorization')).toBe(
      'Bearer test-jwt',
    );
  });

  it('PUTs appearance and wallpaper with clearBackground', async () => {
    const fetchMock = makeFetchMock({
      email: 'user@example.com',
      appearance: 'light',
      wallpaper: { mode: 'plain' },
      hasBackground: false,
      backgroundUrl: null,
      updatedAt: '2026-06-14T00:00:00Z',
    });
    const api = createApiClient(BASE);

    await api.putUserPreferences(
      { appearance: 'light', wallpaper: { mode: 'plain' } },
      { clearBackground: true },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/user/preferences`);
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      appearance: 'light',
      wallpaper: { mode: 'plain' },
      clearBackground: true,
    });
  });

  it('POSTs background multipart to /api/user/background', async () => {
    const fetchMock = makeFetchMock({
      email: 'user@example.com',
      appearance: 'system',
      wallpaper: { mode: 'photo', customImage: '/api/user/background?v=2' },
      hasBackground: true,
      backgroundUrl: '/api/user/background?v=2',
      updatedAt: '2026-06-14T00:00:00Z',
    });
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    const api = createApiClient(BASE);

    await api.uploadUserBackground({
      uri: 'file:///tmp/bg.jpg',
      name: 'bg.jpg',
      type: 'image/jpeg',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/user/background`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect(((init as RequestInit).headers as Headers).get('Content-Type')).toBeNull();
    expect(appendSpy.mock.calls).toHaveLength(1);
    const [field, filePart] = appendSpy.mock.calls[0];
    expect(field).toBe('file');
    // Expo fetch는 RN식 { uri } 조각을 거부한다 — bytes()를 가진 조각이어야 한다.
    expect(filePart).not.toHaveProperty('uri');
    expect(filePart).toEqual({
      name: 'bg.jpg',
      type: 'image/jpeg',
      bytes: expect.any(Function),
    });
    await expect((filePart as any).bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});

// readJson helper 검증 — 4xx HTML, 비-JSON content-type, 정상 JSON 케이스.
// 결함 발현 시 사용자/개발자에게 의미있는 에러 메시지를 제공하는 정본 가드.
// 분석 캐시: .local/artifacts/analysis/20260507-0510-soul-app-attachment-json-parse-error.md
describe('readJson 응답 검증', () => {
  it('200 JSON은 그대로 통과 (기본 contentType=application/json)', async () => {
    makeFetchMock({ counts: { 'folder-1': 3 } });
    const api = createApiClient(BASE);
    const res = await api.getFolderCounts();
    expect(res.counts).toEqual({ 'folder-1': 3 });
  });

  it('413 HTML 응답은 op·status·snippet을 포함한 에러로 throw', async () => {
    makeFetchMock(
      '<html><body>413 Request Entity Too Large</body></html>',
      413,
      'text/html',
    );
    const api = createApiClient(BASE);
    await expect(
      api.uploadAttachment('s', 'n', { uri: 'x', name: 'y' }),
    ).rejects.toThrow(/\[uploadAttachment\].*HTTP 413/);
  });

  it('200 비-JSON content-type은 op·content-type을 포함한 에러로 throw', async () => {
    makeFetchMock('plain text response', 200, 'text/plain');
    const api = createApiClient(BASE);
    await expect(api.getFolderCounts()).rejects.toThrow(
      /\[getFolderCounts\].*JSON이 아닙니다.*text\/plain/,
    );
  });
});

describe('client.getCatalog', () => {
  it('serializes feed_only and explicit limit=0 for feed snapshots', async () => {
    const fetchMock = makeFetchMock({
      folders: [],
      sessions: {},
      sessionList: [],
    });
    const api = createApiClient(BASE);

    await api.getCatalog({ feed_only: true, limit: 0 });

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/folders`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/api/sessions?feed_only=true&limit=0`);
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });

  it('uses one server-limited page for a feed snapshot when limit=0', async () => {
    const rows = Array.from({ length: 200 }, (_, n) => ({ agentSessionId: `s-${n}` }));
    const response = (body: unknown) => ({
      ok: true, status: 200, json: async () => body,
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({ folders: [], sessions: {} }))
      .mockResolvedValueOnce(response({ sessions: rows, total: 9375, hasMore: true }))
      .mockResolvedValueOnce(response({ sessions: [], total: 9375, hasMore: true }));
    (global as any).fetch = fetchMock;

    const result = await createApiClient(BASE).getCatalog({ feed_only: true, limit: 0 });

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `${BASE}/api/folders`,
      `${BASE}/api/sessions?feed_only=true&limit=0`,
    ]);
    expect(result.sessionList).toHaveLength(200);
    expect(result.total).toBe(9375);
  });
});

describe('client folder endpoints', () => {
  it('preserves folder CRUD paths, methods, bodies, and auth', async () => {
    const fetchMock = makeFetchMock({
      id: 'folder-1',
      name: 'Folder',
      sortOrder: 1,
      parentFolderId: 'root',
    });
    const api = createApiClient(BASE);

    await api.createFolder({ name: 'Folder', sortOrder: 1, parentFolderId: 'root', idempotencyKey: 'create-1' });
    await api.updateFolder('folder-1', {
      name: 'Renamed',
      parentFolderId: null,
      settings: { atomNodeId: 'node-1' },
      expectedVersion: 2,
      idempotencyKey: 'rename-1',
    });
    await api.reorderFolders([
      { id: 'folder-2', sortOrder: 0, parentFolderId: null },
      { id: 'folder-1', sortOrder: 1, parentFolderId: 'folder-2' },
    ]);
    await api.updateSessionCatalog('sess/1', {
      folderId: 'folder-1',
      displayName: 'Moved',
    });
    await api.archiveFolder('folder-1', 3, 'archive-1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/folders`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/api/folders/folder-1`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${BASE}/api/folders/reorder`,
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      `${BASE}/api/sessions/sess%2F1`,
    );
    expect(fetchMock.mock.calls[4][0]).toBe(
      `${BASE}/api/folders/folder-1/archive`,
    );

    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(createInit.body as string)).toEqual({
      name: 'Folder',
      sortOrder: 1,
      parentFolderId: 'root',
      idempotencyKey: 'create-1',
    });

    const updateInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(updateInit.method).toBe('PUT');
    expect(JSON.parse(updateInit.body as string)).toEqual({
      name: 'Renamed',
      parentFolderId: null,
      settings: { atomNodeId: 'node-1' },
      expectedVersion: 2,
      idempotencyKey: 'rename-1',
    });

    const reorderInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(reorderInit.method).toBe('PATCH');
    expect(JSON.parse(reorderInit.body as string)).toEqual([
      { id: 'folder-2', sortOrder: 0, parentFolderId: null },
      { id: 'folder-1', sortOrder: 1, parentFolderId: 'folder-2' },
    ]);

    const sessionInit = fetchMock.mock.calls[3][1] as RequestInit;
    expect(sessionInit.method).toBe('PUT');
    expect(JSON.parse(sessionInit.body as string)).toEqual({
      folderId: 'folder-1',
      displayName: 'Moved',
    });

    const archiveInit = fetchMock.mock.calls[4][1] as RequestInit;
    expect(archiveInit.method).toBe('POST');
    expect(JSON.parse(archiveInit.body as string)).toEqual({ expectedVersion: 3, idempotencyKey: 'archive-1' });
    expect((archiveInit.headers as Headers).get('Authorization')).toBe(
      'Bearer test-jwt',
    );
  });
});

describe('client timeline history', () => {
  it('getSessionStory calls the lazy story endpoint with an encoded session id', async () => {
    const story = {
      highlight: '핵심 하이라이트',
      narrative: '[T1] 줄거리',
      unfolded_turn_summaries: [],
      narrative_through_event_id: 10,
      fold_count: 1,
      updated_at: '2026-07-31T00:00:00.000Z',
    };
    const fetchMock = makeFetchMock(story);
    const api = createApiClient(BASE);

    await expect(api.getSessionStory('sess/1')).resolves.toEqual(story);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess%2F1/story`);
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });

  it('getSessionStory treats an undeployed 404 endpoint as an empty story', async () => {
    makeFetchMock({ detail: 'not found' }, 404, 'application/json', 'Not Found');
    const api = createApiClient(BASE);

    await expect(api.getSessionStory('sess-1')).resolves.toBeNull();
  });

  it('getTimeline calls the semantic timeline endpoint with cursor and auth header', async () => {
    const fetchMock = makeFetchMock({ messages: [], next_cursor: null });
    const api = createApiClient(BASE);

    await api.getTimeline('sess-1', {
      limit: 100,
      before: 'cursor-1',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${BASE}/api/sessions/sess-1/timeline?limit=100&before=cursor-1`,
    );
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });

  it('getMessages keeps the raw compatibility endpoint', async () => {
    const fetchMock = makeFetchMock({ messages: [], next_cursor: null });
    const api = createApiClient(BASE);

    await api.getMessages('sess-raw', { limit: 50 });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess-raw/messages?limit=50`);
  });

  it('getTimelineTrace calls the lazy trace endpoint with encoded timeline id', async () => {
    const fetchMock = makeFetchMock({
      type: 'tool_trace',
      timeline_id: 'tool:toolu_1',
      tool_use_id: 'toolu_1',
    });
    const api = createApiClient(BASE);

    await api.getTimelineTrace('sess-1', 'tool:toolu_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${BASE}/api/sessions/sess-1/timeline/tool%3Atoolu_1/trace`,
    );
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });
});

describe('client node and push endpoints', () => {
  it('preserves node list, node agent/model preset lists, and push token request contracts', async () => {
    const fetchMock = makeFetchMock({ nodes: [], agents: [], ok: true });
    const api = createApiClient(BASE);

    await api.listNodes();
    await api.listNodeAgents(NODE);
    await api.listModelPresets(NODE);
    await api.registerPushToken({ token: 'ExpoPushToken[x]', deviceId: 'device/1' });
    await api.deregisterPushToken('device/1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/nodes`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/nodes/${NODE}/agents`);
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE}/api/nodes/${NODE}/model-presets`);
    expect(fetchMock.mock.calls[3][0]).toBe(`${BASE}/api/push/register`);
    expect(fetchMock.mock.calls[4][0]).toBe(
      `${BASE}/api/push/register/device%2F1`,
    );

    const registerInit = fetchMock.mock.calls[3][1] as RequestInit;
    expect(registerInit.method).toBe('POST');
    expect(JSON.parse(registerInit.body as string)).toEqual({
      token: 'ExpoPushToken[x]',
      deviceId: 'device/1',
    });
    expect((registerInit.headers as Headers).get('Content-Type')).toBe(
      'application/json',
    );

    const deregisterInit = fetchMock.mock.calls[4][1] as RequestInit;
    expect(deregisterInit.method).toBe('DELETE');
  });
});

describe('client.createSession', () => {
  // 정상 JWT는 base64url-encoded payload를 포함해야 jwtDecode가 받아들인다.
  // 본 테스트는 client.ts 안의 decodeAuthJwt + buildSoulAppCallerInfo 통합 결과만
  // 검증하므로 sig는 placeholder.
  function base64url(value: string): string {
    return Buffer.from(value, 'utf-8')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }
  function makeJwt(payload: Record<string, unknown>): string {
    const h = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const b = base64url(JSON.stringify(payload));
    return `${h}.${b}.signature`;
  }

  it('Google 프로필이 있는 JWT는 caller_info에 통합 스키마 v1 신원 4필드를 채운다', async () => {
    const jwt = makeJwt({
      sub: 'user@example.com',
      email: 'user@example.com',
      name: '서소영',
      picture: 'https://lh3.googleusercontent.com/a/abc',
      exp: 9999999999,
    });
    useAuthStore.setState({ jwt });
    const fetchMock = makeFetchMock({ session_id: 'sess-1' });
    const api = createApiClient(BASE);
    await api.createSession({ prompt: 'hi', folderId: 'f1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions`);
    expect((init as RequestInit).method).toBe('POST');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      prompt: 'hi',
      folderId: 'f1',
      caller_info: {
        source: 'soul-app',
        display_name: '서소영',
        user_id: 'user@example.com', // 통합 스키마 v1: email = user_id
        avatar_url: 'https://lh3.googleusercontent.com/a/abc',
        email: 'user@example.com',
      },
    });

    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${jwt}`);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('jwt가 null이면 caller_info는 source만 가진 minimal 형태로 보낸다 (graceful)', async () => {
    useAuthStore.setState({ jwt: null });
    const fetchMock = makeFetchMock({ session_id: 'sess-2' });
    const api = createApiClient(BASE);
    await api.createSession({ prompt: 'hi' });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      prompt: 'hi',
      caller_info: { source: 'soul-app' },
    });
  });

  it('jwt 형식이 깨진 경우에도 source만 가진 minimal caller_info로 graceful 처리한다', async () => {
    useAuthStore.setState({ jwt: 'malformed.jwt' });
    const fetchMock = makeFetchMock({ session_id: 'sess-3' });
    const api = createApiClient(BASE);
    await api.createSession({ prompt: 'hi' });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.caller_info).toEqual({ source: 'soul-app' });
  });

  it('jwt에 email이 없으면 source만 가진 minimal caller_info로 fallback한다', async () => {
    const jwtNoEmail = makeJwt({ name: 'X', picture: 'https://...', exp: 1 });
    useAuthStore.setState({ jwt: jwtNoEmail });
    const fetchMock = makeFetchMock({ session_id: 'sess-4' });
    const api = createApiClient(BASE);
    await api.createSession({ prompt: 'hi' });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.caller_info).toEqual({ source: 'soul-app' });
  });

  it('첨부 경로를 createSession body에 포함한다', async () => {
    useAuthStore.setState({ jwt: null });
    const fetchMock = makeFetchMock({ agentSessionId: 'sess-5' });
    const api = createApiClient(BASE);
    await api.createSession({
      prompt: 'hi',
      nodeId: 'node-a',
      attachmentPaths: ['/tmp/a.txt'],
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      prompt: 'hi\n\n[첨부 파일 로컬 경로: /tmp/a.txt]',
      nodeId: 'node-a',
      attachmentPaths: ['/tmp/a.txt'],
      caller_info: { source: 'soul-app' },
    });
  });
});

describe('client session action endpoints', () => {
  it('intervene sends minimal soul-app caller info and optional attachments', async () => {
    useAuthStore.setState({ jwt: null });
    const response = {
      delivered: null,
      outcome: 'unknown',
      reason: 'verdict_unknown',
      consumeWhen: null,
    } as const;
    const fetchMock = makeFetchMock(response);
    const api = createApiClient(BASE);

    const verdict = await api.intervene('sess-1', 'hello', ['/tmp/a.txt']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess-1/intervene`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      text: 'hello\n\n[첨부 파일 로컬 경로: /tmp/a.txt]',
      user: 'soul-app',
      caller_info: { source: 'soul-app' },
      attachmentPaths: ['/tmp/a.txt'],
    });
    expect(verdict).toEqual(response);
  });

  it('respond and tool approval endpoints encode ids and preserve bodies', async () => {
    const fetchMock = makeFetchMock({ ok: true });
    const api = createApiClient(BASE);

    await api.respond('sess/1', 'req/1', { Question: 'Answer' });
    await api.approveTool('sess/1', 'approval/1', {
      message: 'yes',
      alwaysApprove: true,
    });
    await api.rejectTool('sess/1', 'approval/1', {
      message: 'no',
      alwaysReject: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/sessions/sess%2F1/respond`,
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/api/sessions/sess%2F1/tool-approvals/approval%2F1/approve`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${BASE}/api/sessions/sess%2F1/tool-approvals/approval%2F1/reject`,
    );
    expect(
      JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({
      request_id: 'req/1',
      answers: { Question: 'Answer' },
    });
    expect(
      JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string),
    ).toEqual({
      message: 'yes',
      alwaysApprove: true,
    });
    expect(
      JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string),
    ).toEqual({
      message: 'no',
      alwaysReject: true,
    });
  });
});

describe('client.interruptSession', () => {
  it('POSTs /api/sessions/{id}/interrupt with auth header', async () => {
    const fetchMock = makeFetchMock({ ok: true });
    const api = createApiClient(BASE);
    await api.interruptSession('sess/1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess%2F1/interrupt`);
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
  });
});

describe('client.acknowledgeSessionReview', () => {
  it.each([
    [true, 'acknowledged'],
    [false, 'already_acknowledged'],
  ] as const)('POST 성공 changed=%s를 %s로 구분한다', async (changed, kind) => {
    const fetchMock = makeFetchMock({
      status: 'ok',
      agentSessionId: 'sess/1',
      reviewState: 'acknowledged',
      changed,
    });
    const api = createApiClient(BASE);

    await expect(api.acknowledgeSessionReview('sess/1')).resolves.toMatchObject({
      kind,
      reviewState: 'acknowledged',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess%2F1/review/acknowledge`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect((init as RequestInit).headers).toEqual(expect.any(Headers));
    expect(((init as RequestInit).headers as Headers).get('Authorization')).toBe(
      'Bearer test-jwt',
    );
  });

  it('HTTP 오류는 서버 오류 결과로 보존한다', async () => {
    makeFetchMock(
      { error: { code: 'REVIEW_NOT_PENDING', message: 'no pending review' } },
      409,
      'application/json',
      'Conflict',
    );
    const api = createApiClient(BASE);

    await expect(api.acknowledgeSessionReview('sess-1')).resolves.toEqual({
      kind: 'server_error',
      status: 409,
      code: 'REVIEW_NOT_PENDING',
      message: 'no pending review',
    });
  });

  it('네트워크 실패는 reject로 구분한다', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    const api = createApiClient(BASE);

    await expect(api.acknowledgeSessionReview('sess-1')).rejects.toThrow(
      'Network request failed',
    );
  });
});

describe('client.uploadAttachment', () => {
  it('builds multipart FormData without a manual Content-Type header', async () => {
    const fetchMock = makeFetchMock({ path: '/server/a.txt' });
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    const api = createApiClient(BASE);

    const res = await api.uploadAttachment('sess-1', 'node/1', {
      uri: 'file:///tmp/a.txt',
      name: 'a.txt',
    });

    expect(res.path).toBe('/server/a.txt');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/attachments/sessions?nodeId=node%2F1`);
    expect((init as RequestInit).method).toBe('POST');

    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
    expect(headers.get('Content-Type')).toBeNull();

    const form = (init as RequestInit).body as any;
    expect(form).toBeInstanceOf(FormData);
    expect(appendSpy.mock.calls).toHaveLength(2);
    expect(appendSpy.mock.calls[0]).toEqual(['session_id', 'sess-1']);
    const [field, filePart] = appendSpy.mock.calls[1];
    expect(field).toBe('file');
    // Expo fetch는 RN식 { uri } 조각을 거부한다 — bytes()를 가진 조각이어야 한다.
    expect(filePart).not.toHaveProperty('uri');
    // 호출자 MIME도, 파일 시스템 판정값도 없으면 octet-stream으로 보낸다.
    expect(filePart).toEqual({
      name: 'a.txt',
      type: 'application/octet-stream',
      bytes: expect.any(Function),
    });
    await expect((filePart as any).bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('client atom endpoints and stream urls', () => {
  it('preserves atom endpoint paths', async () => {
    const fetchMock = makeFetchMock({ children: [] });
    const api = createApiClient(BASE);

    await api.listAtomRootNodes();
    await api.listAtomNodeChildren('node-1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/atom/nodes`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/api/atom/nodes/node-1/children`,
    );
  });

  it('builds SSE URLs without performing network requests', () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    const api = createApiClient(BASE);

    expect(api.sessionEventsUrl('sess/1', 'last event')).toBe(
      `${BASE}/api/sessions/sess/1/events?snapshotCatchup=1&lastEventId=last+event`,
    );
    expect(api.sessionEventsUrl('sess/1')).toBe(
      `${BASE}/api/sessions/sess/1/events?snapshotCatchup=1`,
    );
    expect(api.catalogStreamUrl('last event', 'instance/1')).toBe(
      `${BASE}/api/sessions/stream?snapshotCatchup=1&lastEventId=last+event&instanceId=instance%2F1`,
    );
    expect(api.catalogStreamUrl('last event', 'instance/1', { feedOnly: true })).toBe(
      `${BASE}/api/sessions/stream?snapshotCatchup=1&feed_only=true&lastEventId=last+event&instanceId=instance%2F1`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('client realtime voice', () => {
  it('createRealtimeCall posts SDP offer to session realtime route', async () => {
    const fetchMock = makeFetchMock({ status: 'ok', callId: 'call_1', answerSdp: 'answer' });
    const api = createApiClient(BASE);
    const result = await api.createRealtimeCall('sess-1', {
      offerSdp: 'offer',
      voice: 'alloy',
    });

    expect(result.answerSdp).toBe('answer');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess-1/realtime/call`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      offerSdp: 'offer',
      voice: 'alloy',
    });
  });

  it('createRealtimeCall exposes 422 validation detail in the thrown error', async () => {
    makeFetchMock(
      {
        detail: [
          {
            type: 'missing',
            loc: ['body', 'offerSdp'],
            msg: 'Field required',
            input: { voice: 'alloy' },
          },
        ],
      },
      422,
      'application/json',
      'Unprocessable Entity',
    );
    const api = createApiClient(BASE);

    await expect(
      api.createRealtimeCall('sess-1', {
        offerSdp: '' as string,
        voice: 'alloy',
      }),
    ).rejects.toThrow(
      '[createRealtimeCall] HTTP 422 Unprocessable Entity — {"detail":[{"type":"missing","loc":["body","offerSdp"],"msg":"Field required","input":{"voice":"alloy"}}]}',
    );
  });

  it('sendRealtimeEvent posts data-channel event with callId', async () => {
    const fetchMock = makeFetchMock({ status: 'ok', normalizedType: 'realtime_transcript' });
    const api = createApiClient(BASE);
    await api.sendRealtimeEvent(
      'sess-1',
      { type: 'response.audio_transcript.done', transcript: 'hi' },
      'call_1',
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/sess-1/realtime/events`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      callId: 'call_1',
      event: { type: 'response.audio_transcript.done', transcript: 'hi' },
    });
  });

  it('resolveRealtimeToolApproval posts voice approval decision', async () => {
    const fetchMock = makeFetchMock({
      status: 'ok',
      approvalId: 'approval-1',
      decision: 'approved',
      dataChannelEvent: { type: 'tool_approval.response' },
    });
    const api = createApiClient(BASE);
    await api.resolveRealtimeToolApproval('sess-1', 'approval-1', {
      decision: 'approved',
      source: 'voice',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${BASE}/api/sessions/sess-1/realtime/tool-approvals/approval-1/resolve`,
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      decision: 'approved',
      source: 'voice',
    });
  });
});

describe('client recurring job endpoints', () => {
  it('uses the authenticated public contract for lifecycle, preview, and run history', async () => {
    const fetchMock = makeFetchMock({ jobs: [], job: {}, run: {}, nextRuns: [] });
    const api = createApiClient(BASE);
    const write = {
      name: 'music recommendation',
      prompt: 'use music-rec skill',
      timezone: 'Asia/Seoul',
      schedule_expressions: ['0 9,12 * * 1-5'],
      node_id: 'node-a',
      agent_id: 'seosoyoung',
      model_preset: null,
      container: { kind: 'folder' as const, id: 'folder-a' },
      folder_id: 'folder-a',
      late_run_window_seconds: 1800,
      enabled: false,
    };

    await api.listRecurringJobs(true);
    await api.previewRecurringSchedule({
      timezone: write.timezone,
      schedule_expressions: write.schedule_expressions,
    });
    await api.createRecurringJob({ ...write, idempotency_key: 'create-1' });
    await api.updateRecurringJob('job/1', { expected_version: 3, enabled: false });
    await api.runRecurringJob('job/1', 'run-1');
    await api.archiveRecurringJob('job/1', 4);
    await api.listRecurringJobRuns('job/1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/api/recurring-jobs?include_archived=true`,
      `${BASE}/api/recurring-jobs/preview`,
      `${BASE}/api/recurring-jobs`,
      `${BASE}/api/recurring-jobs/job%2F1`,
      `${BASE}/api/recurring-jobs/job%2F1/run`,
      `${BASE}/api/recurring-jobs/job%2F1/archive`,
      `${BASE}/api/recurring-jobs/job%2F1/runs?limit=50`,
    ]);
    expect(fetchMock.mock.calls.slice(1).map(([, init]) => (init as RequestInit).method)).toEqual([
      'POST', 'POST', 'PATCH', 'POST', 'POST', undefined,
    ]);
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      ...write,
      idempotency_key: 'create-1',
    });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers)
      .toBeDefined();
    const archiveBody = JSON.parse((fetchMock.mock.calls[5][1] as RequestInit).body as string);
    expect(archiveBody).toEqual({ expected_version: 4 });
  });
});
