import { createApiClient } from '../api/client';
import { useSessionStore } from '../store/sessionStore';
import { useUIStore } from '../store/uiStore';
import { captureAuthScope, isAuthScopeCurrent } from './auth-scope';
import { openPlannerSessionWorkspace } from './planner-folder-workspace';

let requestSequence = 0;

/** Resolve a feed session's card before using the existing folder or standalone opener. */
export async function openFeedSessionCardWorkspace(sessionId: string): Promise<boolean> {
  const sequence = ++requestSequence;
  const scope = captureAuthScope();
  if (!scope.serverUrl) {
    useUIStore.getState().openSessionResolutionError(
      sessionId,
      null,
      '서버 연결 설정이 없습니다.',
      false,
    );
    return false;
  }

  const client = createApiClient(scope.serverUrl, { authScope: scope });
  try {
    const sessions = await client.getSessionsByIds([sessionId]);
    if (sequence !== requestSequence || !isAuthScopeCurrent(scope)) return false;
    useSessionStore.getState().mergeSessions(sessions);
    const session = sessions.find((item) => item.agentSessionId === sessionId);
    let cardId = session?.cardId ?? null;
    if (!cardId) {
      const { cards } = await client.listCards(undefined, { includeCompleted: true });
      if (sequence !== requestSequence || !isAuthScopeCurrent(scope)) return false;
      cardId = cards.find((card) => card.assigneeSessionId === sessionId)?.id ?? null;
    }

    if (cardId) {
      useUIStore.getState().openCardOverlay(cardId, sessionId);
      return true;
    }

    useUIStore.getState().clearCardOverlay();
    return openPlannerSessionWorkspace(sessionId, undefined, undefined, 'feed');
  } catch (error) {
    if (sequence !== requestSequence || !isAuthScopeCurrent(scope)) return false;
    const detail = error instanceof Error ? error.message : String(error);
    useUIStore.getState().openSessionResolutionError(
      sessionId,
      null,
      `세션의 연결 카드를 확인하지 못했습니다. ${detail}`,
      false,
    );
    return false;
  }
}
