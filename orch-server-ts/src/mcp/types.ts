import type { SessionActionCommandRouteOptions } from "../session/session_action_command_routes.js";
import type { RecurringJobHostRouteOptions } from "../recurring-jobs/recurring_job_host_routes.js";
import type { CardOrchestrationRouteOptions } from "../cards/card_orchestration_routes.js";
import type { NodeSnapshotRouteOptions } from "../node/node_snapshot_routes.js";
import type { NodeAgentProfileRouteOptions, NodeAgentProfileProvider } from "../node/node_agent_profile_routes.js";
import type { CogitoRouteOptions } from "../cogito/cogito_routes.js";
import type { SessionCommandRouteOptions } from "../session/session_command_routes.js";
import type { FastifyBaseLogger } from "fastify";
import type { PageYjsService } from "../page/page_service.js";
import type { AtomHttpClient } from "../atom/atom_routes.js";
import type { SessionMcpDependencies } from "./session_handlers.js";
import type { CallToolResult } from "@soulstream/mcp-contract";
import type { FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";
import type { CardRouteBodyOptions } from "../cards/card_route_body.js";
import type { BoardAccess } from "../board/board_access.js";
import type { FlatFolderContentHost } from "../board/flat_folder_content_host.js";
import type { AgentProfileRepository } from "../node/agent_profile_routes.js";
import type { ContextBundleRepository } from "../node/context_bundle_routes.js";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";
import type { InMemorySseReplayBroadcaster, SessionStreamEvent } from "../sse/replay_broadcaster.js";
import type { CatalogDeltaFolderProvider } from "../runtime/catalog_delta_broadcaster.js";
import type { PersistentSessionSettingsService } from "../session/persistent_session_settings_service.js";
import type { CardWorkDispatchService, DispatchWorkActor } from "../cards/card_work_dispatch_service.js";
import type {
  EventIngressDeadLetterListInput,
  EventIngressDeadLetterListResult,
} from "../node/event_ingress_dead_letter_store.js";
import type {
  DeliveryLatencyQueryInput,
  DeliveryLatencyResult,
} from "../node/event_ingress_delivery_latency.js";

export interface McpCallContext {
  signal?: AbortSignal;
  principal: "internal" | "external";
  callerSessionId: string | null;
  nodeId: string;
  callerInfo?: Record<string, unknown>;
  /** Set only by the orchestrator's own external ingress; never accepted from the worker forward body. */
  externalCaller?: { source: string; displayName: string };
  ownedAgent?: { agentId: string; ownerEmail: string; credentialId: string };
  execution?: { registrationId: string; executionCommandId: string };
}

export interface McpHostOptions {
  resolveSessionOwner?: import("../session/session_owner.js").SessionOwnerResolver;
  ownedAgents?: import("../owned-agents/service.js").OwnedAgentService;
  sessionMessages?: SessionActionCommandRouteOptions;
  /** Node pairing + credential administration; absent when the host does not own the store. */
  nodePairing?: import("../node_credentials/types.js").NodePairingHostOptions;
  externalLlm?: { service?: import("../external_events/service.js").ExternalEventsService; getSession(id: string): Promise<unknown | null> };
  /** 외부 연동 회신 도구의 저장소. 없는 host는 그 도구에서만 external_access_unavailable을 낸다. */
  externalAccess?: {
    sql: import("../control_plane/control_plane_types.js").SqlClient;
    /** 대기 중인 상태 조회를 깨우는 프로세스 안 신호기. 없어도 회신은 그대로 저장된다. */
    replySignal?: import("../external_access/external_reply_signal.js").ExternalReplySignal;
  };
  /**
   * 웹훅 관리 도구가 부르는 공용 명령 층. 설정 화면 경로와 같은 인스턴스다.
   * 칸이 없으면 그 방향의 도구가 webhooks_unavailable을 낸다.
   */
  webhooks?: {
    inbound?: import("../webhooks/webhook_management.js").InboundWebhookManagement;
    outbound?: import("../webhooks/webhook_management.js").OutboundWebhookManagement;
  };
  sessions?: SessionMcpDependencies;
  persistentSessionSettings?: PersistentSessionSettingsService;
  persistentDefaults?: import("../admin/persistent_defaults_routes.js").PersistentDefaultsRoutes;
  authBearerToken: string;
  /** Node pairing credentials; `null` is explicit outside production composition. */
  nodeCredentials: import("../node_credentials/types.js").NodeCredentialResolver | null;
  recurringJobs: RecurringJobHostRouteOptions;
  cardOrchestration: CardOrchestrationRouteOptions;
  cluster: {
    nodes: NodeSnapshotRouteOptions;
    nodeAgentProfiles: NodeAgentProfileRouteOptions;
    /** 중앙 에이전트 프로필 도구가 직접 부르는 저장소. HTTP 라우트를 거치지 않는다. */
    centralAgentProfiles: {
      repository: AgentProfileRepository;
      bundleRepository: ContextBundleRepository;
      modelCatalog?: ModelCatalogSource;
    };
    cogito: CogitoRouteOptions;
    sessions: SessionCommandRouteOptions;
    readSession(sessionId: string): Promise<{ folder_id?: string | null } | null>;
    /** event ingress 읽기 전용 조회 도구의 자리. 없는 host는 그 도구에서만 오류를 낸다. */
    eventIngress?: {
      listDeadLetters(input: EventIngressDeadLetterListInput): Promise<EventIngressDeadLetterListResult>;
      deliveryLatency?(input: DeliveryLatencyQueryInput): Promise<DeliveryLatencyResult>;
    };
    logger: Pick<FastifyBaseLogger, "warn">;
  };
  environment?: string;
  folders: FolderControlPlaneHostRouteOptions;
  pages?: { service: PageYjsService; logger: Pick<FastifyBaseLogger, "error"> };
  /** 스킬 린트 보고 한 건의 저장소. 없는 host는 put_skill_lint_report에서만 오류를 낸다. */
  skillLintReport?: import("../skills/skill_lint_report_store.js").SkillLintReportStorePort;
  skills?: { enabled: boolean; serverUrl: string; apiKey: string; nodeId: string; catalogsNodeId?: string; typesafeApiKey: string; httpClient: AtomHttpClient; logger?: Pick<FastifyBaseLogger, "warn"> };
  cards: CardRouteBodyOptions & { resolveAccess: () => BoardAccess | Promise<BoardAccess>;
    cardExecutionServiceProvider?: NonNullable<import("../folders/folder_routes.js").FolderRouteOptions["cardExecutionServiceProvider"]>;
    workDispatchServiceProvider?: (authorizeFolder: (folderId: string, actor: DispatchWorkActor) => Promise<void>) => Promise<CardWorkDispatchService>;
    runConfirm?: { intervalMs: number; timeoutMs: number } };
  board: {
    host: FlatFolderContentHost;
    getSession: (id: string) => Promise<{ folder_id: string | null } | null>;
    listAgentProfiles: NodeAgentProfileProvider["listAgentProfiles"];
    broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
    catalogFolderProvider: CatalogDeltaFolderProvider;
  };
}

export type McpToolHandler = (
  dependencies: McpHostOptions,
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<CallToolResult>;
