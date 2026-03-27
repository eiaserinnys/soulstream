/**
 * AppConfig — /api/config 응답 타입
 *
 * soul-server(single-node)와 soulstream-server(orchestrator) 양쪽이
 * 동일한 형태로 응답한다. mode 필드로 모드를 구분한다.
 */
export interface AppConfig {
  mode: "single" | "orchestrator";
  nodeId: string | null;
  auth: {
    enabled: boolean;
    /** OAuth 프로바이더. auth.enabled=true일 때만 존재 */
    provider?: "google";
  };
  features: {
    /** ConfigModal 표시 여부 (soul-server: true, soulstream-server: true) */
    configModal: boolean;
    /** SearchModal 표시 여부 (soul-server: true, soulstream-server: true) */
    searchModal: boolean;
    /** NodePanel 표시 여부 (single: false, orchestrator: true) */
    nodePanel: boolean;
    /**
     * node-guard 배지 표시 여부 (single: true, orchestrator: false)
     * 현재 노드와 다른 노드의 세션임을 배지로 표시한다.
     */
    nodeGuard: boolean;
  };
}
