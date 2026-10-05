import { useCallback } from 'react';
import { Alert } from 'react-native';
import type { CardCheckItem } from '../api/cardTypes';
import type { ApiClient } from '../api/client';
import { captureAuthScope } from '../lib/auth-scope';
import { useCardStore } from '../store/cardStore';
import { cardOperationId } from './useCardActions';

const EMPTY_PENDING: Record<number, { confirmed: boolean; requestId: string }> = {};

export function useCardItems(api: ApiClient | null, cardId: string) {
  const card = useCardStore((state) => state.details[cardId]?.card ?? state.rows[cardId]);
  const pendingConfirmations = useCardStore((state) => state.pendingItemConfirmations[cardId] ?? EMPTY_PENDING);
  const items = card?.items ?? [];

  const confirm = useCallback(async (itemId: number, confirmed: boolean): Promise<boolean> => {
    if (!api) return false;
    const current = useCardStore.getState();
    const currentCard = current.details[cardId]?.card ?? current.rows[cardId];
    const item = currentCard?.items?.find((entry) => entry.id === itemId);
    if (!item || item.state === 'dropped') return false;

    const requestId = cardOperationId();
    if (!current.beginItemConfirmation(cardId, itemId, confirmed, requestId)) return false;
    const authGeneration = captureAuthScope().generation;
    try {
      const result = await api.confirmCardItem(cardId, itemId, confirmed);
      if (captureAuthScope().generation !== authGeneration) return false;
      if (result.card) useCardStore.getState().putMutationCard(result.card);
      return true;
    } catch (cause) {
      if (captureAuthScope().generation === authGeneration) {
        Alert.alert('항목 확인 실패', cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    } finally {
      useCardStore.getState().finishItemConfirmation(cardId, itemId, requestId);
    }
  }, [api, cardId]);

  const isConfirmed = useCallback((item: Pick<CardCheckItem, 'id' | 'confirmed'>) =>
    pendingConfirmations[item.id]?.confirmed ?? Boolean(item.confirmed), [pendingConfirmations]);

  return { items, pendingConfirmations, confirm, isConfirmed };
}
