import type { ApiRequestContext } from './clientCore';
import type { ModelPresetAvailability } from '../../../packages/soul-ui/src/lib/model-preset-availability';

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
