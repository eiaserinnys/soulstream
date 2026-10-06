import type { ApiRequestContext } from './clientCore';

export interface ModelPresetAvailability {
  id: string;
  label: string;
  backend: string;
  available: boolean;
  reason: string | null;
  reason_label: string | null;
  resets_at: string | null;
  usage_warning: boolean;
  weekly_headroom?: WeeklyHeadroom | null;
  /** Effort levels the node advertised. Absent = no effort control for this preset. */
  supported_efforts?: string[];
  /** Effort applied when the create request omits one. Absent = backend default. */
  default_effort?: string;
}

export interface WeeklyHeadroom {
  status: 'ok' | 'stale' | 'unavailable';
  headroom: number | null;
  remaining_percent: number | null;
  window_remaining_percent: number | null;
  resets_at: string | null;
  observed_at: string | null;
  quota_label: string | null;
}

export function createNodeEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    // 연결된 호스트 노드 목록 — NewSessionSheet에서 노드 수동 선택용.
    listNodes: (): Promise<{
      nodes: Array<{
        nodeId: string;
        host?: string;
        port?: number;
        status?: string;
        sessionCount?: number;
        [k: string]: unknown;
      }>;
    }> => authFetch(`${base}/api/nodes`).then((r) => readJson(r, 'listNodes')),

    // 노드별 에이전트 목록 — NewSessionSheet의 picker용.
    listNodeAgents: (
      nodeId: string,
    ): Promise<{
      agents: Array<{
        id: string;
        name: string | null;
        portraitUrl?: string;
        default_preset?: string;
      }>;
    }> =>
      authFetch(`${base}/api/nodes/${nodeId}/agents`).then((r) =>
        readJson(r, 'listNodeAgents'),
      ),

    listModelPresets: (
      nodeId: string,
    ): Promise<{ model_presets: ModelPresetAvailability[] }> =>
      authFetch(`${base}/api/nodes/${nodeId}/model-presets`).then((r) =>
        readJson(r, 'listModelPresets'),
      ),
  };
}
