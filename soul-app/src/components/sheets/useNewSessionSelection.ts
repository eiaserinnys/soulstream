import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
  useRef,
} from 'react';
import type { SessionAgentOption } from './optimisticSession';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import {
  resolveSelectedAgentName,
  resolveSelectedFolderName,
  resolveSelectedModelPresetName,
  resolveSelectedNodeName,
  sortNewSessionFolders,
  type NewSessionFolder,
  type NewSessionNode,
} from './newSessionSelection';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';

export interface NewSessionSelectionApi {
  listNodes: () => Promise<{ nodes?: NewSessionNode[] | null }>;
  listNodeAgents: (
    nodeId: string,
  ) => Promise<{ agents?: SessionAgentOption[] | null }>;
  listModelPresets?: (
    nodeId: string,
  ) => Promise<{ model_presets?: ModelPresetAvailability[] | null }>;
}

export interface NewSessionSelectionFailure {
  phase: 'nodes' | 'agents' | 'model-presets';
  error: unknown;
}

interface UseNewSessionSelectionArgs {
  preserveAgentOnNodeChange?: boolean;
  visible: boolean;
  api: NewSessionSelectionApi | null;
  folders: readonly NewSessionFolder[];
  defaultFolderId?: string | null;
  defaultNodeId?: string | null;
  defaultAgentId?: string | null;
  defaultModelPresetId?: string | null;
  settingsNodeId: string | null | undefined;
  onLoadError?: (failure: NewSessionSelectionFailure) => void;
}

export interface UseNewSessionSelectionResult {
  selectedFolderId: string | null;
  setSelectedFolderId: Dispatch<SetStateAction<string | null>>;
  selectedNodeId: string | null;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  nodes: NewSessionNode[];
  agents: SessionAgentOption[];
  agentId: string | null;
  setAgentId: Dispatch<SetStateAction<string | null>>;
  modelPresets: ModelPresetAvailability[];
  selectedModelPresetId: string | null;
  setSelectedModelPresetId: Dispatch<SetStateAction<string | null>>;
  effectiveModelPresetId: string | null;
  /** Preset object backing the effort picker (advertised efforts + default). */
  effectiveModelPreset: ModelPresetAvailability | null;
  selectedModelPresetName: string;
  selectedModelPresetUsageWarning: boolean;
  modelPresetSelectionInvalid: boolean;
  effectiveNodeId: string | null | undefined;
  sortedFolders: NewSessionFolder[];
  selectedFolderName: string;
  selectedAgentName: string;
  selectedNodeName: string;
}

export function useNewSessionSelection({
  preserveAgentOnNodeChange = false,
  visible,
  api,
  folders,
  defaultFolderId,
  defaultNodeId,
  defaultAgentId,
  defaultModelPresetId,
  settingsNodeId,
  onLoadError,
}: UseNewSessionSelectionArgs): UseNewSessionSelectionResult {
  const scopeGeneration = useAuthScopeGeneration();
  const ownerGeneration = useRef(scopeGeneration);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(
    defaultFolderId ?? null,
  );
  // 빌드 19: 노드(호스트) 수동 선택 추가. null이면 settings.nodeId 자동 사용.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    defaultNodeId ?? null,
  );
  const [nodes, setNodes] = useState<NewSessionNode[]>([]);
  const [agents, setAgents] = useState<SessionAgentOption[]>([]);
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? null);
  const [modelPresets, setModelPresets] = useState<ModelPresetAvailability[]>([]);
  const [selectedModelPresetId, setSelectedModelPresetId] = useState<string | null>(
    defaultModelPresetId ?? null,
  );
  const latestAgentId = useRef(agentId);
  latestAgentId.current = agentId;
  const [modelPresetsLoaded, setModelPresetsLoaded] = useState(false);
  const [modelPresetsFailed, setModelPresetsFailed] = useState(false);
  const ownsSelection = ownerGeneration.current === scopeGeneration;

  useEffect(() => {
    if (ownerGeneration.current === scopeGeneration) return;
    ownerGeneration.current = scopeGeneration;
    setSelectedFolderId(defaultFolderId ?? null);
    setSelectedNodeId(defaultNodeId ?? null);
    setAgentId(defaultAgentId ?? null);
    setSelectedModelPresetId(defaultModelPresetId ?? null);
    setNodes([]);
    setAgents([]);
    setModelPresets([]);
    setModelPresetsLoaded(false);
    setModelPresetsFailed(false);
  }, [
    defaultAgentId,
    defaultFolderId,
    defaultModelPresetId,
    defaultNodeId,
    scopeGeneration,
  ]);

  const visibleSelectedFolderId = ownsSelection
    ? selectedFolderId
    : defaultFolderId ?? null;
  const visibleSelectedNodeId = ownsSelection
    ? selectedNodeId
    : defaultNodeId ?? null;
  const visibleAgentId = ownsSelection ? agentId : defaultAgentId ?? null;
  const visibleSelectedModelPresetId = ownsSelection
    ? selectedModelPresetId
    : defaultModelPresetId ?? null;

  // 에이전트 목록은 "현재 선택된 노드"를 기준으로 가져온다 (수동 선택 우선, 없으면 settings 기본).
  const effectiveNodeId = visibleSelectedNodeId ?? settingsNodeId;

  const sortedFolders = useMemo(
    () => sortNewSessionFolders(folders),
    [folders],
  );

  const selectedFolderName = useMemo(
    () => resolveSelectedFolderName(visibleSelectedFolderId, sortedFolders),
    [visibleSelectedFolderId, sortedFolders],
  );

  const selectedAgentName = useMemo(
    () => resolveSelectedAgentName(visibleAgentId, ownsSelection ? agents : []),
    [agents, ownsSelection, visibleAgentId],
  );

  const selectedNodeName = useMemo(
    () => resolveSelectedNodeName(visibleSelectedNodeId, settingsNodeId),
    [visibleSelectedNodeId, settingsNodeId],
  );
  const visibleAgents = ownsSelection ? agents : [];
  const visibleModelPresets = ownsSelection ? modelPresets : [];
  const selectedAgent = visibleAgents.find(
    (candidate) => candidate.id === visibleAgentId,
  );
  const agentDefaultPresetId = normalized(selectedAgent?.default_preset);
  const effectiveModelPresetId =
    visibleSelectedModelPresetId ?? agentDefaultPresetId;
  const effectivePreset = visibleModelPresets.find(
    (candidate) => candidate.id === effectiveModelPresetId,
  );
  const selectedModelPresetName = resolveSelectedModelPresetName(
    effectiveModelPresetId,
    visibleModelPresets,
    ownsSelection && modelPresetsLoaded,
    ownsSelection && modelPresetsFailed,
    visibleSelectedModelPresetId === null && effectiveModelPresetId !== null,
  );
  const modelPresetSelectionInvalid = Boolean(
    ownsSelection
      && modelPresetsLoaded
      && effectiveModelPresetId
      && (!effectivePreset || !effectivePreset.available),
  );
  const selectedModelPresetUsageWarning = Boolean(
    effectivePreset?.available && effectivePreset.usage_warning,
  );

  // 시트가 다시 열릴 때마다 선택 상태 초기화. defaultFolderId가 바뀌면 그것을 따라간다.
  useEffect(() => {
    if (visible) {
      setSelectedFolderId(defaultFolderId ?? null);
      setSelectedNodeId(defaultNodeId ?? null);
      setAgentId(defaultAgentId ?? null);
      setSelectedModelPresetId(defaultModelPresetId ?? null);
    }
  }, [
    visible,
    defaultAgentId,
    defaultFolderId,
    defaultModelPresetId,
    defaultNodeId,
  ]);

  // 시트 열릴 때 노드 목록 로드.
  useEffect(() => {
    if (!visible || !api) return;
    const requestGeneration = scopeGeneration;
    let cancelled = false;
    invokeApi(() => api.listNodes())
      .then((res) => {
        if (cancelled || captureAuthScope().generation !== requestGeneration) return;
        setNodes(res.nodes ?? []);
      })
      .catch((err) => {
        if (cancelled || captureAuthScope().generation !== requestGeneration) return;
        console.warn('[NewSessionSheet] node list fetch failed:', err);
        notifyLoadError(onLoadError, { phase: 'nodes', error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, api, onLoadError, scopeGeneration]);

  // 노드가 바뀌면 에이전트와 preset을 같은 노드 기준으로 다시 평가한다.
  useEffect(() => {
    if (!visible || !api) return;
    if (!effectiveNodeId) {
      setAgents([]);
      setModelPresets([]);
      setModelPresetsLoaded(false);
      setModelPresetsFailed(false);
      return;
    }
    const requestGeneration = scopeGeneration;
    let cancelled = false;
    setAgents([]);
    setModelPresets([]);
    setModelPresetsLoaded(false);
    setModelPresetsFailed(false);
    // 이전 노드에서 고른 값은 무효. 원래 기본 노드로 돌아온 경우에만 사다리 기본값을 복원한다.
    setAgentId(
      preserveAgentOnNodeChange ? latestAgentId.current : effectiveNodeId === defaultNodeId ? defaultAgentId ?? null : null,
    );
    setSelectedModelPresetId(
      effectiveNodeId === defaultNodeId ? defaultModelPresetId ?? null : null,
    );
    invokeApi(() => api.listNodeAgents(effectiveNodeId))
      .then((res) => {
        if (cancelled || captureAuthScope().generation !== requestGeneration) return;
        const nextAgents = res.agents ?? [];
        setAgents(nextAgents);
        if (preserveAgentOnNodeChange) setAgentId((current) => nextAgents.some((agent) => agent.id === current) ? current : null);
      })
      .catch((err) => {
        if (cancelled || captureAuthScope().generation !== requestGeneration) return;
        console.warn('[NewSessionSheet] agent list fetch failed:', err);
        notifyLoadError(onLoadError, { phase: 'agents', error: err });
      });
    if (api.listModelPresets) {
      invokeApi(() => api.listModelPresets!(effectiveNodeId))
        .then((res) => {
          if (cancelled || captureAuthScope().generation !== requestGeneration) return;
          setModelPresets(res.model_presets ?? []);
          setModelPresetsLoaded(true);
          setModelPresetsFailed(false);
        })
        .catch((err) => {
          if (cancelled || captureAuthScope().generation !== requestGeneration) return;
          setModelPresetsFailed(true);
          console.warn('[NewSessionSheet] model preset fetch failed:', err);
          notifyLoadError(onLoadError, { phase: 'model-presets', error: err });
        });
    } else {
      setModelPresetsFailed(true);
    }
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    api,
    defaultAgentId,
    defaultModelPresetId,
    defaultNodeId,
    effectiveNodeId,
    preserveAgentOnNodeChange,
    onLoadError,
    scopeGeneration,
  ]);

  return {
    selectedFolderId: visibleSelectedFolderId,
    setSelectedFolderId,
    selectedNodeId: visibleSelectedNodeId,
    setSelectedNodeId,
    nodes: ownsSelection ? nodes : [],
    agents: visibleAgents,
    agentId: visibleAgentId,
    setAgentId,
    modelPresets: visibleModelPresets,
    selectedModelPresetId: visibleSelectedModelPresetId,
    setSelectedModelPresetId,
    effectiveModelPresetId,
    effectiveModelPreset: effectivePreset ?? null,
    selectedModelPresetName,
    selectedModelPresetUsageWarning,
    modelPresetSelectionInvalid,
    effectiveNodeId,
    sortedFolders,
    selectedFolderName,
    selectedAgentName,
    selectedNodeName,
  };
}

function normalized(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function invokeApi<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function notifyLoadError(
  listener: ((failure: NewSessionSelectionFailure) => void) | undefined,
  failure: NewSessionSelectionFailure,
) {
  try {
    listener?.(failure);
  } catch (listenerError) {
    console.warn('[NewSessionSheet] load error listener failed:', listenerError);
  }
}
