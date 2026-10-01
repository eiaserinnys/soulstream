import type { PlannerFolder } from '../../api/plannerTypes';
import type { Session } from '../../api/types';
import { createSessionFolderResolver, SessionFolderResolutionCancelledError, type SessionFolderResolverPort } from '../session-folder-resolver';

const folder = { folderId: 'folder-1', page: { id: 'page-1' }, sessionIds: ['session-1'] } as PlannerFolder;
const session = { agentSessionId: 'session-1', folderId: 'folder-1' } as Session;
let scope = { generation: 'auth-1' };

function port(overrides: Partial<SessionFolderResolverPort> = {}): SessionFolderResolverPort {
  return {
    captureScope: () => scope,
    isScopeCurrent: (captured) => captured === scope,
    getSession: async () => session,
    hydrateFolder: async () => folder,
    ...overrides,
  };
}

afterEach(() => { scope = { generation: 'auth-1' }; });

test('세션의 folderId 하나로 통일 폴더를 연다', async () => {
  const hydrateFolder = jest.fn(async () => folder);
  const resolver = createSessionFolderResolver(port({ hydrateFolder }));
  await expect(resolver.resolve('session-1')).resolves.toEqual({ kind: 'linked', folder: folder });
  expect(hydrateFolder).toHaveBeenCalledWith('folder-1', session, scope);
  expect(resolver.peek('session-1')).toBe(folder);
});

test('루트 폴더의 세션도 같은 경로로 연다', async () => {
  const rootSession = { ...session, folderId: 'root-folder' } as Session;
  const hydrateFolder = jest.fn(async () => folder);
  const resolver = createSessionFolderResolver(port({ getSession: async () => rootSession, hydrateFolder }));
  await expect(resolver.resolve('session-1')).resolves.toEqual({ kind: 'linked', folder: folder });
  expect(hydrateFolder).toHaveBeenCalledWith('root-folder', rootSession, scope);
});

test('folderId가 없는 세션만 폴더 화면 밖에서 연다', async () => {
  const hydrateFolder = jest.fn(async () => folder);
  const resolver = createSessionFolderResolver(port({
    getSession: async () => ({ ...session, folderId: null }) as Session,
    hydrateFolder,
  }));
  await expect(resolver.resolve('session-1')).resolves.toEqual({ kind: 'unlinked' });
  expect(hydrateFolder).not.toHaveBeenCalled();
});

test('인증 범위가 바뀌면 이전 폴더 캐시를 쓰지 않는다', async () => {
  const hydrateFolder = jest.fn(async () => folder);
  const resolver = createSessionFolderResolver(port({ hydrateFolder }));
  await resolver.resolve('session-1');
  scope = { generation: 'auth-2' };
  expect(resolver.peek('session-1')).toBeUndefined();
  await resolver.resolve('session-1');
  expect(hydrateFolder).toHaveBeenCalledTimes(2);
});

test('새 세션을 열면 이전 비동기 조회 결과는 취소한다', async () => {
  let release!: (value: Session) => void;
  const waiting = new Promise<Session>((resolve) => { release = resolve; });
  const resolver = createSessionFolderResolver(port({ getSession: async () => waiting }));
  const oldRequest = resolver.resolve('session-1');
  resolver.cancelStale('session-2');
  release(session);
  await expect(oldRequest).rejects.toBeInstanceOf(SessionFolderResolutionCancelledError);
});
