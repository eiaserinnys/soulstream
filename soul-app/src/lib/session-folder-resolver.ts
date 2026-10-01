import type { PlannerFolder } from '../api/plannerTypes';
import type { Session } from '../api/types';

export { createSessionFolderWorkspaceController, type SessionFolderWorkspaceUI } from './session-folder-workspace-controller';

export type SessionFolderResolution = { kind: 'linked'; folder: PlannerFolder } | { kind: 'unlinked' };

export class SessionFolderResolutionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options);
    this.name = 'SessionFolderResolutionError';
    this.retryable = options?.retryable ?? true;
  }
}

export class SessionFolderResolutionCancelledError extends Error {}

export interface SessionFolderResolverScope { generation: string }

export interface SessionFolderResolverPort<TScope extends SessionFolderResolverScope = SessionFolderResolverScope> {
  captureScope(): TScope;
  isScopeCurrent(scope: TScope): boolean;
  getSession(sessionId: string, scope: TScope): Promise<Session | null>;
  hydrateFolder(folderId: string, session: Session, scope: TScope): Promise<PlannerFolder>;
}

export interface SessionFolderResolver {
  peek(sessionId: string): PlannerFolder | undefined;
  resolve(sessionId: string): Promise<SessionFolderResolution>;
  prime(folder: PlannerFolder): void;
  cancelStale(nextSessionId: string): void;
  reset(): void;
}

export function createSessionFolderResolver<TScope extends SessionFolderResolverScope>(
  port: SessionFolderResolverPort<TScope>,
): SessionFolderResolver {
  const cache = new Map<string, PlannerFolder>();
  const pending = new Map<string, Promise<SessionFolderResolution>>();
  let generation: string | null = null;
  let activeSessionId: string | null = null;

  function activate(scope: TScope) {
    if (generation === scope.generation) return;
    generation = scope.generation;
    cache.clear();
    pending.clear();
    activeSessionId = null;
  }

  function assertCurrent(scope: TScope, sessionId: string) {
    if (!port.isScopeCurrent(scope) || generation !== scope.generation
      || activeSessionId !== sessionId) {
      throw new SessionFolderResolutionCancelledError();
    }
  }

  return {
    peek(sessionId) {
      const scope = port.captureScope();
      activate(scope);
      return port.isScopeCurrent(scope) ? cache.get(sessionId) : undefined;
    },
    resolve(sessionId) {
      const scope = port.captureScope();
      activate(scope);
      activeSessionId = sessionId;
      const cached = cache.get(sessionId);
      if (cached) return Promise.resolve({ kind: 'linked', folder: cached });
      const existing = pending.get(sessionId);
      if (existing) return existing;
      const request = (async (): Promise<SessionFolderResolution> => {
        const session = await port.getSession(sessionId, scope);
        assertCurrent(scope, sessionId);
        if (!session) throw new SessionFolderResolutionError('세션 정보를 찾지 못했습니다.');
        if (!session.folderId) return { kind: 'unlinked' };
        const folder = await port.hydrateFolder(session.folderId, session, scope);
        assertCurrent(scope, sessionId);
        cache.set(sessionId, folder);
        return { kind: 'linked', folder: folder };
      })().finally(() => {
        if (pending.get(sessionId) === request) pending.delete(sessionId);
      });
      pending.set(sessionId, request);
      return request;
    },
    prime(folder) {
      const scope = port.captureScope();
      activate(scope);
      if (!port.isScopeCurrent(scope)) return;
      for (const sessionId of folder.sessionIds) cache.set(sessionId, folder);
    },
    cancelStale(nextSessionId) { activeSessionId = nextSessionId; },
    reset() {
      cache.clear();
      pending.clear();
      generation = null;
      activeSessionId = null;
    },
  };
}
