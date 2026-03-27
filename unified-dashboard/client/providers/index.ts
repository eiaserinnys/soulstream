/**
 * unified-dashboard Session Providers
 *
 * soul-ui의 SSESessionProvider와 unified-dashboard의 OrchestratorSessionProvider를 관리.
 * AppConfig.mode에 따라 적절한 Provider를 반환하는 팩토리를 제공한다.
 *
 * - single-node 모드: soul-ui SSESessionProvider (/api/sessions)
 * - orchestrator 모드: OrchestratorSessionProvider (/api/catalog)
 */

import type { SessionStorageProvider, StorageMode } from "@seosoyoung/soul-ui";
import { sseSessionProvider } from "@seosoyoung/soul-ui";
import { orchestratorSessionProvider } from "./OrchestratorSessionProvider";

export { sseSessionProvider };
export { orchestratorSessionProvider };

/**
 * AppConfig.mode에 따라 적절한 Provider를 반환한다.
 * - single-node: SSESessionProvider (soul-ui 기본 구현)
 * - orchestrator: OrchestratorSessionProvider (/api/catalog 기반)
 */
export function getSessionProvider(_mode: StorageMode): SessionStorageProvider {
  return sseSessionProvider;
}

/**
 * orchestrator 모드용 Provider를 반환한다.
 * Phase 5 OrchestratorDashboardLayout에서 사용.
 */
export function getOrchestratorSessionProvider(): SessionStorageProvider {
  return orchestratorSessionProvider;
}
