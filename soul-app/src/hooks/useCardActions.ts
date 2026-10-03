import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { ApiClient } from '../api/client';
import type { CardMutationResult } from '../api/cardTypes';
import { captureAuthScope } from '../lib/auth-scope';
import { refreshCard, useCardStore } from '../store/cardStore';
import { usePlannerStore } from '../store/plannerStore';

export const cardOperationId = () => `soul-app-card-${Crypto.randomUUID()}`;

export function useCardActions(api: ApiClient | null, onError?: (cause: unknown) => void) {
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [pending, setPending] = useState(false);
  const run = async (mutation: () => Promise<CardMutationResult>): Promise<boolean> => {
    if (!api || lock.current) return false;
    lock.current = true;
    setPending(true);
    const scope = captureAuthScope().generation;
    try {
      const result = await mutation();
      if (captureAuthScope().generation !== scope) return false;
      usePlannerStore.getState().invalidate('folder');
      if (result.card) {
        useCardStore.getState().putCard(result.card);
        try { await refreshCard(api, result.card.id); }
        catch (cause) { console.warn('카드 변경 저장 후 재조회 실패', cause); }
      }
      return true;
    } catch (cause) {
      if (mounted.current && captureAuthScope().generation === scope) {
        if (onError) onError(cause);
        else Alert.alert('카드 변경 실패', cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return { run, pending };
}
