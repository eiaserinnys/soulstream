import { useCallback, useRef, useState } from 'react';
import { createApiClient } from '../api/client';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useAppNoticeStore } from '../store/appNoticeStore';
import {
  setPlannerProjectionForScope,
  usePlannerStore,
} from '../store/plannerStore';
import {
  acknowledgeFolderSessionProjection,
  capturePlannerProjection,
} from '../lib/planner-mutation-projection';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../lib/auth-scope';

export function useSessionReviewAcknowledge(sessionId: string) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const scopeGeneration = useAuthScopeGeneration();
  const showNotice = useAppNoticeStore((state) => state.showNotice);
  const inFlightRef = useRef(false);
  const [inFlight, setInFlight] = useState(false);

  const acknowledge = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!serverUrl) {
      showNotice({
        title: '네트워크 오류',
        message: '연결을 확인하고 다시 시도해주세요.',
        tone: 'error',
      });
      return;
    }

    inFlightRef.current = true;
    setInFlight(true);
    const scope = captureAuthScope();
    try {
      const api = createApiClient(serverUrl, { authScope: scope });
      const result = await api.acknowledgeSessionReview(sessionId);
      if (!isAuthScopeCurrent(scope)) return;
      if (result.kind === 'server_error') {
        showNotice({
          title: '검수 확인 실패',
          message: `${result.code}: ${result.message}`,
          tone: 'error',
        });
        return;
      }
      useSessionStore.getState().updateSession(sessionId, {
        reviewRequired: true,
        reviewState: 'acknowledged',
      });
      setPlannerProjectionForScope(scope.generation, acknowledgeFolderSessionProjection(
        capturePlannerProjection(usePlannerStore.getState()),
        sessionId,
      ));
      showNotice({
        title: '검수 확인',
        message:
          result.kind === 'acknowledged'
            ? '확인 처리했습니다.'
            : '이미 확인된 결과입니다.',
        tone: 'success',
      });
    } catch {
      showNotice({
        title: '네트워크 오류',
        message: '연결을 확인하고 다시 시도해주세요.',
        tone: 'error',
      });
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [scopeGeneration, serverUrl, sessionId, showNotice]);

  return { acknowledge, inFlight };
}
