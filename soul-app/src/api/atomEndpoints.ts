import type { ApiRequestContext } from './clientCore';

export function createAtomEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    // atom 트리 드릴다운 — 플래너 컨텍스트 노드 picker용.
    listAtomRootNodes: (): Promise<{
      nodes?: Array<any>;
      children?: Array<any>;
      [k: string]: any;
    }> =>
      authFetch(`${base}/api/atom/nodes`).then((r) =>
        readJson(r, 'listAtomRootNodes'),
      ),

    listAtomNodeChildren: (
      nodeId: string,
    ): Promise<{ children?: Array<any>; [k: string]: any }> =>
      authFetch(`${base}/api/atom/nodes/${nodeId}/children`).then((r) =>
        readJson(r, 'listAtomNodeChildren'),
      ),
  };
}
