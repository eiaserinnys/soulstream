import { useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { ApiClient } from '../api/client';
import type { CardComment } from '../api/cardTypes';
import { captureAuthScope } from '../lib/auth-scope';
import { useCardStore } from '../store/cardStore';
import { cardOperationId } from './useCardActions';

export function useCardComments(api: ApiClient | null, cardId: string) {
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const send = async (body: string) => {
    if (!api || lock.current) return false;
    const scope = captureAuthScope().generation;
    const id = cardOperationId();
    const comment: CardComment = { id, cardId, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', body, createdAt: new Date().toISOString() };
    const replace = (saved?: CardComment) => {
      if (scope !== captureAuthScope().generation) return;
      const current = useCardStore.getState().details[cardId];
      if (current) useCardStore.getState().putDetail({ ...current, comments: [...(current.comments ?? []).filter((item) => item.id !== id && item.id !== saved?.id), ...(saved ? [saved] : [])] });
    };
    lock.current = true; setPending(true); replace(comment);
    try { replace(await api.addCardComment(cardId, { body, idempotencyKey: id })); return true; }
    catch (cause) { replace(); Alert.alert('커멘트 저장 실패', cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { lock.current = false; setPending(false); }
  };
  return { send, pending };
}
