import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ApiClient } from '../api/client';
import type { FolderSnapshot } from '../api/cardTypes';
import { useMemo } from 'react';
import { mergeCardRows, useCardStore } from '../store/cardStore';
import { usePlannerStore } from '../store/plannerStore';
import { captureAuthScope, useAuthScopeGeneration } from '../lib/auth-scope';

export function usePlannerFolder(
  api: ApiClient | null,
  folderId: string | null,
  enabled = true,
) {
  const scopeGeneration = useAuthScopeGeneration();
  const ownerKey = `${scopeGeneration}\u0000${folderId ?? ''}`;
  const [local, setLocal] = useState(() => emptyState(ownerKey));
  const current = local.ownerKey === ownerKey ? local : emptyState(ownerKey);
  const refreshKey = usePlannerStore((state) => (
    state.invalidation.folder + state.invalidation.replay
  ));
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!api || !folderId || !enabled) {
      setLocal(emptyState(ownerKey));
      return;
    }
    setLocal((previous) => ({
      ownerKey,
      data: previous.ownerKey === ownerKey ? previous.data : undefined,
      loading: true,
      error: null,
    }));
    try {
      const result = await api.getFolderSnapshot(folderId);
      if (isCurrent(generationRef, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, data: result }
          : previous);
      }
    } catch (cause) {
      if (isCurrent(generationRef, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, error: errorText(cause) }
          : previous);
      }
    } finally {
      if (isCurrent(generationRef, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, loading: false }
          : previous);
      }
    }
  }, [api, enabled, ownerKey, folderId, scopeGeneration]);

  useEffect(() => {
    generationRef.current += 1;
    setLocal(emptyState(ownerKey));
  }, [ownerKey]);
  useEffect(() => {
    void refresh();
    return () => { generationRef.current += 1; };
  }, [refresh, refreshKey]);

  const rows = useCardStore((state) => state.rows);
  const data = useMemo(() => current.data ? { ...current.data,
    cards: mergeCardRows(current.data.cards, rows).filter((card) => card.folderId === folderId)
      .sort((a, b) => a.positionKey < b.positionKey ? -1 : a.positionKey > b.positionKey ? 1 : 0),
  } : undefined, [current.data, rows, folderId]);
  return {
    data,
    loading: current.loading,
    error: current.error,
    refresh,
  };
}

function emptyState(ownerKey: string): {
  ownerKey: string;
  data: FolderSnapshot | undefined;
  loading: boolean;
  error: string | null;
} {
  return { ownerKey, data: undefined, loading: false, error: null };
}

function isCurrent(
  ref: MutableRefObject<number>,
  generation: number,
  scopeGeneration: string,
): boolean {
  return ref.current === generation
    && captureAuthScope().generation === scopeGeneration;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
