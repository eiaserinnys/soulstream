/**
 * unified-dashboard Session Providers
 *
 * soul-ui의 SSESessionProvider를 re-export하고,
 * storageMode에 따라 적절한 Provider를 반환하는 팩토리를 제공한다.
 */

import type { SessionStorageProvider, StorageMode } from "@seosoyoung/soul-ui";
import { sseSessionProvider } from "@seosoyoung/soul-ui";

export { sseSessionProvider };

/**
 * storageMode에 따라 적절한 Provider를 반환한다.
 * unified-dashboard single-node 모드에서는 항상 SSESessionProvider를 사용한다.
 */
export function getSessionProvider(_mode: StorageMode): SessionStorageProvider {
  return sseSessionProvider;
}
