import type { PlannerFolder } from '../api/plannerTypes';
import {
  SessionFolderResolutionError,
  SessionFolderResolutionCancelledError,
  type SessionFolderResolver,
} from './session-folder-resolver';

export interface SessionFolderWorkspaceUI {
  showLoading(
    sessionId: string,
    focusEventId: number | null,
    storyOpenRequestId: number | null,
  ): void;
  showLinked(
    folder: PlannerFolder,
    sessionId: string,
    focusEventId: number | null,
    storyOpenRequestId: number | null,
  ): void;
  showUnlinked(
    sessionId: string,
    focusEventId: number | null,
    storyOpenRequestId: number | null,
  ): void;
  showError(
    sessionId: string,
    focusEventId: number | null,
    message: string,
    retryable: boolean,
    storyOpenRequestId: number | null,
  ): void;
  cancelLoading(sessionId: string): void;
}

export function createSessionFolderWorkspaceController(
  resolver: SessionFolderResolver,
  ui: SessionFolderWorkspaceUI,
) {
  let generation = 0;
  let activeSessionId: string | null = null;

  return {
    cancel(): void {
      const sessionId = activeSessionId;
      generation += 1;
      activeSessionId = null;
      if (sessionId) ui.cancelLoading(sessionId);
    },
    async open(
      sessionId: string,
      focusEventId?: number | null,
      storyOpenRequestId?: number | null,
    ): Promise<void> {
      const requestGeneration = ++generation;
      activeSessionId = sessionId;
      const focus = focusEventId ?? null;
      const story = storyOpenRequestId ?? null;
      let cached: PlannerFolder | undefined;
      try {
        resolver.cancelStale(sessionId);
        cached = resolver.peek(sessionId);
      } catch (error) {
        ui.showLoading(sessionId, focus, story);
        if (requestGeneration === generation) {
          const failure = resolutionFailure(error);
          activeSessionId = null;
          ui.showError(sessionId, focus, failure.message, failure.retryable, story);
        }
        return;
      }
      if (cached) {
        activeSessionId = null;
        ui.showLinked(cached, sessionId, focus, story);
        return;
      }

      ui.showLoading(sessionId, focus, story);
      try {
        const result = await resolver.resolve(sessionId);
        if (requestGeneration !== generation) return;
        activeSessionId = null;
        if (result.kind === 'linked') ui.showLinked(result.folder, sessionId, focus, story);
        else ui.showUnlinked(sessionId, focus, story);
      } catch (error) {
        if (requestGeneration !== generation) return;
        activeSessionId = null;
        const failure = error instanceof SessionFolderResolutionCancelledError
          ? {
              message: '폴더 연결 확인이 취소되었습니다. 다시 시도해 주세요.',
              retryable: true,
            }
          : resolutionFailure(error);
        ui.showError(sessionId, focus, failure.message, failure.retryable, story);
      }
    },
  };
}

function resolutionFailure(error: unknown): { message: string; retryable: boolean } {
  return {
    message: error instanceof Error
      ? error.message
      : '폴더 연결을 확인하지 못했습니다. 다시 시도해 주세요.',
    retryable: error instanceof SessionFolderResolutionError
      ? error.retryable
      : true,
  };
}
