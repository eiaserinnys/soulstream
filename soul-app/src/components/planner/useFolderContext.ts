import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Folder } from '../../api/types';
import type { PageSessionDefaults } from '../../api/pageEndpoints';
import { captureAuthScope, isAuthScopeCurrent } from '../../lib/auth-scope';
import {
  folderContextSources,
  mergeFolderContextPages,
  parseFolderPageContext,
  type FolderContextInheritance,
} from '../../lib/folder-context';
import type { FolderExecutionDefaults } from '../../lib/folder-settings';
import { selectPlannerInvalidationKeys } from '../../lib/planner-invalidation';
import { usePlannerStore } from '../../store/plannerStore';
import { resolveSelectedModelPresetName } from '../sheets/newSessionSelection';
import { sheetErrorDetail } from './SheetErrorNotice';

type ContextApi = Pick<ApiClient, 'getPage' | 'getPageSessionDefaults'>;
type NamesApi = Pick<ApiClient, 'listNodeAgents' | 'listModelPresets'>;

interface Loaded<T> {
  key: string;
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type Retryable<T> = Loaded<T> & { retry(): void };

function usePageRefreshKey(): string {
  return usePlannerStore((state) => String(selectPlannerInvalidationKeys(state.invalidation).pageDetail));
}

function useLoaded<T>(baseKey: string | null, load: (() => Promise<T>) | null): Retryable<T> {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const key = baseKey ? `${baseKey}\u0000${attempt}` : null;
  const [state, setState] = useState<Loaded<T>>({ key: '', data: null, loading: false, error: null });
  useEffect(() => {
    if (!key || !load) return;
    const scope = captureAuthScope();
    let cancelled = false;
    setState((previous) => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }));
    Promise.resolve().then(load).then((data) => {
      if (!cancelled && isAuthScopeCurrent(scope)) setState({ key, data, loading: false, error: null });
    }).catch((cause) => {
      if (!cancelled && isAuthScopeCurrent(scope)) setState({ key, data: null, loading: false, error: sheetErrorDetail(cause) });
    });
    return () => { cancelled = true; };
    // `load` closes over the values encoded in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key || !load) return { key: '', data: null, loading: false, error: null, retry };
  return state.key === key ? { ...state, retry } : { key, data: null, loading: true, error: null, retry };
}

/** Guidance and references along the folder's parent chain, merged with the server's nearest-wins keys. */
export function useFolderContextChain(
  api: ContextApi | null,
  folderId: string | null,
  folders: readonly Folder[],
  active: boolean,
): Retryable<FolderContextInheritance> {
  const refresh = usePageRefreshKey();
  const resolution = useMemo(() => folderId ? folderContextSources(folderId, folders) : null, [folderId, folders]);
  const sources = resolution?.status === 'resolved' ? resolution.sources : [];
  const key = api && active && resolution?.status === 'resolved'
    ? JSON.stringify([refresh, sources.map((source) => [source.pageId, source.folderName])])
    : null;
  return useLoaded(key, api ? async () => mergeFolderContextPages(await Promise.all(sources.map(async (source) => ({
    source,
    details: parseFolderPageContext((await api.getPage(source.pageId)).blocks),
  })))) : null);
}

export interface ResolvedPageDefaults {
  defaults: FolderExecutionDefaults;
  sourceName: string | null;
  sourcePageId: string;
}

/** The server's session-defaults resolution for a page, with the owning folder's name. */
export function usePageSessionDefaults(
  api: ContextApi | null,
  pageId: string | null,
  folders: readonly Folder[],
  active: boolean,
): Retryable<ResolvedPageDefaults> {
  const refresh = usePageRefreshKey();
  const key = api && active && pageId ? `${refresh}\u0000${pageId}` : null;
  const loaded = useLoaded<PageSessionDefaults | null>(key, api && pageId ? () => api.getPageSessionDefaults(pageId) : null);
  return useMemo(() => ({
    ...loaded,
    data: loaded.data ? {
      defaults: { nodeId: loaded.data.nodeId, agentId: loaded.data.agentId, modelPreset: loaded.data.modelPreset },
      sourceName: folders.find((folder) => folder.projectPageId === loaded.data!.sourcePageId)?.name ?? null,
      sourcePageId: loaded.data.sourcePageId,
    } : null,
  }), [folders, loaded]);
}

export interface ExecutionDefaultsNames {
  nodeName: string | null;
  agentName: string | null;
  modelName: string | null;
  loading: boolean;
}

/** Display names of node, agent and model for a read-only summary. */
export function useExecutionDefaultsNames(api: NamesApi | null, defaults: FolderExecutionDefaults | null): ExecutionDefaultsNames {
  const nodeId = defaults?.nodeId ?? null;
  const key = api && nodeId ? nodeId : null;
  const loaded = useLoaded(key, api && nodeId ? async () => {
    const [agents, presets] = await Promise.all([
      api.listNodeAgents(nodeId).then((result) => result.agents ?? []),
      api.listModelPresets(nodeId).then((result) => result.model_presets ?? []).catch(() => []),
    ]);
    return { agents, presets };
  } : null);
  if (!defaults) return { nodeName: null, agentName: null, modelName: null, loading: false };
  const agent = loaded.data?.agents.find((candidate) => candidate.id === defaults.agentId);
  const modelId = defaults.modelPreset ?? agent?.default_preset ?? null;
  const preset = modelId ? loaded.data?.presets.find((candidate) => candidate.id === modelId) : undefined;
  return {
    nodeName: defaults.nodeId,
    agentName: agent?.name ?? null,
    modelName: preset ? resolveSelectedModelPresetName(preset.id, [preset], true, false, !defaults.modelPreset) : null,
    loading: loaded.loading,
  };
}
