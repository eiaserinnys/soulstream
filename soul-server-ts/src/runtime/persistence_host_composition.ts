/**
 * 워커 런타임의 orch 호스트 클라이언트 묶음.
 *
 * session_db가 쓰는 배달·claude 런타임·세션 페이지·세션 데이터 호스트를 한 곳에서
 * 만들고, 배달 호스트는 notification DLQ 라우트가 같은 인스턴스로 쓰도록 돌려준다.
 */
import {
  ClaudeRuntimeHostClient,
  SessionDeliveryHostClient,
  SessionPageBindingHostClient,
} from "../control_plane/persistence_host_clients.js";
import type { HostClientConfig } from "../control_plane/persistence_host_transport.js";
import { SessionDataHostClient } from "../control_plane/session_data_host_client.js";
import type { SessionDB } from "../db/session_db.js";

export function configureWorkerPersistenceHosts(
  db: SessionDB,
  deps: HostClientConfig,
): SessionDeliveryHostClient {
  const deliveries = new SessionDeliveryHostClient(deps);
  db.configurePersistenceHosts({
    deliveries,
    claudeRuntime: new ClaudeRuntimeHostClient(deps),
    sessionPageBindings: new SessionPageBindingHostClient(deps),
    sessionData: new SessionDataHostClient(deps),
  });
  return deliveries;
}
