/**
 * unified-dashboard Session Providers
 *
 * soul-ui의 SSESessionProvider와 unified-dashboard의 OrchestratorSessionProvider를 관리.
 *
 * - single-node 모드: soul-ui SSESessionProvider (/api/sessions)
 * - orchestrator 모드: OrchestratorSessionProvider (/api/sessions)
 */

import type { SessionStorageProvider } from "@seosoyoung/soul-ui";
import { sseSessionProvider } from "@seosoyoung/soul-ui";
import { orchestratorSessionProvider } from "./OrchestratorSessionProvider";

export { sseSessionProvider };
export { orchestratorSessionProvider };

/**
 * single-node 모드용 Provider(SSESessionProvider)를 반환한다.
 * DashboardLayout에서 useSessionListProvider/useSessionProvider의 팩토리로 사용된다.
 */
export function getSessionProvider(): SessionStorageProvider {
  return sseSessionProvider;
}

/**
 * orchestrator 모드용 Provider를 반환한다.
 * OrchestratorDashboardLayout에서 사용.
 */
export function getOrchestratorSessionProvider(): SessionStorageProvider {
  return orchestratorSessionProvider;
}
