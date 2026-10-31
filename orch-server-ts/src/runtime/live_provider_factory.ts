// Provider option types and bundle assembly stay together as one runtime wiring boundary.
import type { FastifyRequest } from "fastify";
import type { AdminUsersRouteOptions } from "../admin/admin_users_routes.js";
import type { AtomRouteOptions } from "../atom/atom_routes.js";
import { createLiveMultipartAttachmentOptions } from "./live_multipart_attachment_provider.js";
import type { MultipartAttachmentOptions } from "../attachments/multipart_attachment_routes.js";
import type { AttachmentRouteOptions } from "../attachments/attachment_routes.js";
import type { AgentAttachmentRouteOptions } from "../attachments/agent_attachment_routes.js";
import type { WorkerAttachmentRouteOptions } from "../attachments/worker_attachment_routes.js";
import { createWorkerAttachmentAccess } from "../attachments/worker_attachment_access.js";
import { createWorkerAttachmentRead } from "../attachments/worker_attachment_read.js";
import { createLiveWorkerAttachmentRepository } from "./live_worker_attachment_repository.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import { createAgentAttachmentRegistration } from "../attachments/agent_attachment_registration.js";
import { createSessionOutputAttachmentValidation } from "../attachments/session_output_attachment_validation.js";
import { createOwnedAttachmentCommitService } from "../attachments/attachment_commit_service.js";
import type { CreateOwnedAttachmentCommitServiceOptions } from "../attachments/attachment_commit_contract.js";
import type { RepositorySql } from "../cards/control_plane/card_types.js";
import { createLiveAttachmentReadOptions } from "./live_attachment_read_provider.js";
import type { CreateLiveAttachmentReadOptions } from "./live_attachment_read_provider.js";
import type { CogitoRouteOptions } from "../cogito/cogito_routes.js";
import type { OrchestratorRuntimeServices } from "./composition.js";
import {
  createLiveAuthHttpClient,
  createLiveAuthJwtHelper,
  createLiveAuthNativeVerifier,
  createLiveAuthTokenResolver,
  createLiveAuthUserAuthorizer,
} from "./live_auth_route_provider.js";
import {
  createLiveCogitoRouteProviders,
  type LiveCogitoRouteProviderBundle,
} from "./live_cogito_route_provider.js";
import { createLiveCogitoSearchAccessProvider } from "./live_cogito_search_access_provider.js";
import {
  createLiveConfigRouteProviders,
  type LiveConfigRouteProviderBundle,
} from "./live_config_route_providers.js";
import type { ExecuteProxyRouteOptions } from "../execute/execute_proxy_routes.js";
import type { FolderRouteOptions } from "../folders/folder_routes.js";
import type { BoardAssetRouteOptions } from "../board/board_asset_routes.js";
import type { BoardItemRouteOptions } from "../board/board_item_routes.js";
import type { MarkdownDocumentRouteOptions } from "../board/markdown_document_routes.js";
import type { PublicStatusRouteOptions } from "../public/public_status_routes.js";
import type { PushRouteOptions } from "../push/push_routes.js";
import type { UserPreferencesRouteOptions } from "../user/user_preferences_routes.js";
import type { UserBackgroundRouteOptions } from "../user/user_background_routes.js";
import type { UsageSummaryRouteOptions } from "../usage/usage_summary_routes.js";
import { SessionStatisticsDailyService } from "../usage/session_statistics_daily_service.js";
import { statisticsLiveDays } from "../usage/session_statistics_daily_calculator.js";
import type { SessionStatisticsRepositoryPort } from "../usage/session_statistics_types.js";
import type { SessionStatisticsRouteOptions } from "../usage/session_statistics_routes.js";
import type { UiEventRepository, UiEventRouteOptions }
  from "../ui-events/ui_event_routes.js";
import { createLiveUiEventIdentityResolver } from "./live_ui_event_identity.js";
import {
  ModelPresetAvailabilityService,
  type ModelPresetUsageSummary,
} from "../model/model_preset_availability.js";
import type { NodeAgentProfileRouteOptions } from "../node/node_agent_profile_routes.js";
import type { AgentProfileRouteOptions } from "../node/agent_profile_routes.js";
import type { ContextBundleRouteOptions } from "../node/context_bundle_routes.js";
import type { SessionCatalogRouteOptions } from "../session/session_catalog_routes.js";
import { createLiveDashboardAccessProvider } from "./live_dashboard_access_provider.js";
import { createLiveExecuteProxyRouteProvider } from "./live_execute_proxy_route_provider.js";
import {
  createLiveNodeClaudeAuthRouteProviders,
  type LiveNodeClaudeAuthRouteProviderBundle,
} from "./live_node_claude_auth_route_provider.js";
import {
  createLiveNodeAgentProfileRouteProviders,
} from "./live_node_agent_profile_route_provider.js";
import {
  createLiveSystemConfigRouteProviders,
  type LiveSystemConfigRouteProviderBundle,
} from "./live_system_config_route_provider.js";
import type { AuthRouteOptions } from "../auth/auth_routes.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { createOAuthAccessTokenResolver, type OAuthAccessTokenResolver } from "../oauth/oauth_access.js";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { LiveProviderDependencies } from "./live_provider_dependencies.js";
import { liveProviderDependencyCategories } from "./live_provider_dependencies.js";
import {
  createSessionResourceAccessProvider,
} from "../session/session_resource_access.js";
import {
  createSessionCreateLifecycle,
} from "../session/session_create_lifecycle.js";
import {
  createSessionStreamEventFilter,
} from "../session/session_stream_event_filter.js";
import { withSessionCatalogMutationBroadcasts } from "./live_session_catalog_mutation_broadcaster.js";
import { withBoardAssetMutationBroadcasts } from "./live_board_asset_mutation_broadcaster.js";
import {
  createLiveAuthenticatedUserResolvers,
  type LiveAuthenticatedUserResolvers,
} from "./live_authenticated_user_resolver.js";
import { createLiveAdminUsersRouteProvider } from "./live_admin_users_route_provider.js";
import { createLiveAtomHttpClient } from "./live_atom_route_provider.js";
import { createLiveAttachmentRouteProviders } from "./live_attachment_route_provider.js";
import { createLiveAttachmentUploadOptions } from "./live_attachment_upload_provider.js";
import { createLiveAttachmentInputAdmission } from "../attachments/live_attachment_input_admission.js";
import { broadcastCatalogSnapshot } from "./live_folder_mutation_broadcaster.js";
import {
  resolveSessionSnapshotIds,
  resolveSessionSnapshotLimit,
  resolveSessionSnapshotOffset,
} from "../session/session_snapshot_service.js";
import {
  liveProviderWiringInventory,
  type LiveProviderPath,
  type LiveProviderWiringInventoryEntry,
} from "./provider_wiring_inventory.js";
import {
  LiveProviderFactoryError,
  liveFactoryImplementedProviderPaths,
  liveProviderFactoryFailures,
  validateLiveProviderFactoryInventoryAlignment,
  type LiveProviderFactoryFailure,
  type LiveProviderFactoryInventoryAlignmentResult,
  type ValidateLiveProviderFactoryInventoryAlignmentInput,
} from "./live_provider_factory_inventory.js";
import {
  buildLiveRuntimeProviderBundle,
  type LiveRuntimeProviderBundle,
} from "./live_runtime_provider_bundle.js";

export {
  LiveProviderFactoryError,
  liveFactoryImplementedProviderPaths,
  validateLiveProviderFactoryInventoryAlignment,
  type LiveProviderFactoryFailure,
  type LiveProviderFactoryFailureStatus,
  type LiveProviderFactoryInventoryAlignmentResult,
  type ValidateLiveProviderFactoryInventoryAlignmentInput,
} from "./live_provider_factory_inventory.js";
export type { LiveRuntimeProviderBundle } from "./live_runtime_provider_bundle.js";

export type LiveOrchestratorProviderBundle = {
  readonly authenticatedUserResolvers: LiveAuthenticatedUserResolvers;
  readonly modelPresetAvailability: ModelPresetAvailabilityService;
  readonly adminUsersRoutes: AdminUsersRouteOptions;
  readonly atomRoutes: AtomRouteOptions;
  readonly attachmentRoutes: Pick<
    AttachmentRouteOptions,
    "provider" | "accessProvider" | "transport" | "multipart" | "assetRead" | "assetUpload"
  >;
  readonly agentAttachmentRoutes?: AgentAttachmentRouteOptions;
  readonly workerAttachmentRoutes?: WorkerAttachmentRouteOptions;
  readonly authRoutes: Pick<
    AuthRouteOptions,
    | "configProvider"
    | "httpClient"
    | "jwt"
    | "nativeVerifier"
    | "resolveTokenAccess"
    | "authorizeUser"
    | "userPayloadExtra"
  >;
  readonly folderRoutes: Pick<
    FolderRouteOptions,
    "accessProvider" | "provider" | "resolveDashboardUserId"
  >;
  readonly boardAssetRoutes: Pick<BoardAssetRouteOptions, "accessProvider" | "provider">;
  readonly boardItemRoutes: Pick<BoardItemRouteOptions, "accessProvider" | "provider">;
  readonly markdownDocumentRoutes: Pick<
    MarkdownDocumentRouteOptions,
    "accessProvider" | "provider"
  >;
  readonly publicStatusRoutes: Pick<
    PublicStatusRouteOptions,
    "folderCountsProvider"
  >;
  readonly pushRoutes: PushRouteOptions;
  readonly userPreferencesRoutes: UserPreferencesRouteOptions;
  readonly userBackgroundRoutes: UserBackgroundRouteOptions;
  readonly sessionCatalogRoutes: SessionCatalogRouteOptions;
  readonly runtime: LiveRuntimeProviderBundle;
  readonly cogitoRoutes:
    & LiveCogitoRouteProviderBundle["cogitoRoutes"]
    & Pick<CogitoRouteOptions, "accessProvider">;
  readonly configProviders: LiveConfigRouteProviderBundle;
  readonly executeProxyRoutes: ExecuteProxyRouteOptions;
  readonly nodeAgentProfileRoutes: NodeAgentProfileRouteOptions;
  readonly agentProfileRoutes: AgentProfileRouteOptions;
  readonly contextBundleRoutes: ContextBundleRouteOptions;
  readonly nodeClaudeAuthRoutes: LiveNodeClaudeAuthRouteProviderBundle["nodeClaudeAuthRoutes"];
  readonly systemConfigRoutes: LiveSystemConfigRouteProviderBundle["systemConfigRoutes"];
  readonly usageSummaryRoutes: LiveUsageSummaryRouteOptions;
  readonly sessionStatisticsRoutes: LiveSessionStatisticsProvider;
  readonly uiEventRoutes: UiEventRouteOptions;
  readonly implementedProviderPaths: readonly LiveProviderPath[];
};

export type LiveSessionStatisticsProvider = SessionStatisticsRouteOptions & {
  readonly startBackground?: () => void;
};

export type CreateLiveOrchestratorProviderBundleOptions = {
  readonly dependencies: LiveProviderDependencies;
  readonly runtimeServices: OrchestratorRuntimeServices;
  readonly usageSummaryRoutes: LiveUsageSummaryRouteOptions;
  readonly sessionStatisticsRepositoryProvider: () => Promise<SessionStatisticsRepositoryPort>;
  readonly uiEventRepository: UiEventRepository;
  readonly inventory?: readonly LiveProviderWiringInventoryEntry[];
  readonly factoryProviderPaths?: readonly LiveProviderPath[];
  readonly resolveAttachmentStorage?: CreateOwnedAttachmentCommitServiceOptions["resolveAttachmentBinding"];
  readonly resolveReadStorage?: CreateLiveAttachmentReadOptions["resolveReadStorage"];
  readonly dbSqlResolver?: LiveDbSqlResolver;
  readonly readPageAttachmentEvidence?: CreateLiveAttachmentReadOptions["readPageAttachmentEvidence"];
  readonly findSessionNode?: (sessionId: string) => Promise<string | null>;
  readonly agentAttachmentRegistration?: {
    readonly authBearerToken: string;
    readonly environment: string;
    readonly sql: RepositorySql;
    readonly resolveAttachmentBinding: CreateOwnedAttachmentCommitServiceOptions["resolveAttachmentBinding"];
  };
};

type LiveUsageSummaryRouteOptions = Omit<UsageSummaryRouteOptions, "service"> & {
  readonly service: UsageSummaryRouteOptions["service"] & ModelPresetUsageSummary;
};

export function createLiveOrchestratorProviderBundle(
  options: CreateLiveOrchestratorProviderBundleOptions,
): LiveOrchestratorProviderBundle {
  assertLiveProviderDependencies(options.dependencies);
  const inventory = options.inventory ?? liveProviderWiringInventory;
  const factoryProviderPaths =
    options.factoryProviderPaths ?? liveFactoryImplementedProviderPaths;
  const alignment = validateLiveProviderFactoryInventoryAlignment({
    inventory,
    factoryProviderPaths,
  });
  const failures = liveProviderFactoryFailures(alignment, inventory);
  if (failures.length > 0) {
    throw new LiveProviderFactoryError(failures);
  }

  const systemConfigProviders = createLiveSystemConfigRouteProviders({
    registry: options.runtimeServices.registry,
    nodeHttpClient: options.dependencies.nodeHttpClient,
    portraitAssets: options.dependencies.systemPortraitAssets,
  });
  const configProviders = createLiveConfigRouteProviders(
    options.dependencies.configProvider,
  );
  const nodeClaudeAuthProviders = createLiveNodeClaudeAuthRouteProviders({
    configProvider: options.dependencies.configProvider,
    nodeHttpClient: options.dependencies.nodeHttpClient,
  });
  const nodeAgentProfileProviders = createLiveNodeAgentProfileRouteProviders({
    registry: options.runtimeServices.registry,
    bridge: options.runtimeServices.sessionBridge,
    nodeHttpClient: options.dependencies.nodeHttpClient,
    agentProfileRepository: options.dependencies.dbCatalogRepository.agentProfileRepository,
  });
  const modelPresetAvailability = new ModelPresetAvailabilityService(
    options.runtimeServices.registry,
    options.usageSummaryRoutes.service,
  );
  const authJwt = createLiveAuthJwtHelper({
    configProvider: options.dependencies.configProvider,
  });
  const authorizeUser = createLiveAuthUserAuthorizer({
    configProvider: options.dependencies.configProvider,
  });
  let oauthAccessTokenResolver: OAuthAccessTokenResolver | undefined;
  const resolveOAuthToken: OAuthAccessTokenResolver | undefined = options.dbSqlResolver === undefined
    ? undefined
    : async (token) => {
      const sql = await options.dbSqlResolver!.resolveSql() as unknown as SqlClient;
      oauthAccessTokenResolver ??= createOAuthAccessTokenResolver(sql, authorizeUser);
      return oauthAccessTokenResolver(token);
    };
  const authenticatedUserResolvers = createLiveAuthenticatedUserResolvers({
    jwt: authJwt,
    ...(resolveOAuthToken === undefined ? {} : { resolveOAuthToken }),
    isServiceBearer: async request => {
      const config = await options.dependencies.configProvider.getConfig();
      const token = config.auth_bearer_token;
      return typeof token === "string" && token.length > 0 &&
        verifyServiceBearerAuthorization(request.headers.authorization, token).ok;
    },
  });
  const dashboardAccessProvider = createLiveDashboardAccessProvider({
    configProvider: options.dependencies.configProvider,
    jwt: authJwt,
    repository: options.dependencies.dbCatalogRepository.adminUsersRepository,
    verifyDashboardToken: authenticatedUserResolvers.verifyToken,
    resolveOAuthAccess: authenticatedUserResolvers.resolveOAuthAccess,
  });
  const sessionResourceAccessProvider = createSessionResourceAccessProvider({
    accessProvider: dashboardAccessProvider,
    repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
  });
  const cogitoProviders = createLiveCogitoRouteProviders({
    registry: options.runtimeServices.registry,
    bridge: options.runtimeServices.sessionBridge,
    searchProvider: options.dependencies.dbCatalogRepository.cogitoSearchProvider,
  });
  const cogitoSearchAccessProvider = createLiveCogitoSearchAccessProvider({
    accessProvider: sessionResourceAccessProvider,
    repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
  });
  const attachmentProviders = createLiveAttachmentRouteProviders({
    registry: options.runtimeServices.registry,
    bridge: options.runtimeServices.sessionBridge,
    dashboardAccessProvider,
    sessionResourceAccessProvider,
  });
  const attachmentReadOptions = options.resolveReadStorage && options.readPageAttachmentEvidence
    ? createLiveAttachmentReadOptions({
        repository: options.dependencies.dbCatalogRepository.attachmentReadRepository,
        resolveEmail: authenticatedUserResolvers.resolveEmail,
        resolveReadStorage: options.resolveReadStorage,
        readPageAttachmentEvidence: options.readPageAttachmentEvidence,
        dashboardAccessProvider,
        sessionResourceAccessProvider,
        folderProvider: options.dependencies.dbCatalogRepository.folderRouteProvider,
      })
    : undefined;
  if (options.resolveAttachmentStorage !== undefined && attachmentReadOptions === undefined) {
    throw new Error(
      "resolveAttachmentStorage requires attachment read storage and page evidence",
    );
  }
  const commitBinding = options.resolveAttachmentStorage ??
    options.agentAttachmentRegistration?.resolveAttachmentBinding;
  const commits = commitBinding === undefined
    ? undefined
    : createOwnedAttachmentCommitService({
        repository: options.dependencies.dbCatalogRepository.attachmentCommitRepository,
        resolveAttachmentBinding: commitBinding,
      });
  if (options.agentAttachmentRegistration !== undefined && commits === undefined) {
    throw new Error("agentAttachmentRegistration requires attachment storage binding");
  }
  const attachmentUploadOptions = options.resolveAttachmentStorage === undefined
    ? undefined
    : createLiveAttachmentUploadOptions({
        resolveEmail: authenticatedUserResolvers.resolveEmail,
        readOptions: attachmentReadOptions!,
        repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
        access: sessionResourceAccessProvider,
        commits: commits!,
        commitRepository: options.dependencies.dbCatalogRepository.attachmentCommitRepository,
        resolveBinding: options.resolveAttachmentStorage,
      });
  const attachmentMultipartOptions = options.resolveAttachmentStorage === undefined
    ? undefined
    : {
        ...createLiveMultipartAttachmentOptions({
          resolveStorage: options.resolveAttachmentStorage,
          configProvider: options.dependencies.configProvider,
          resolveEmail: authenticatedUserResolvers.resolveEmail,
          repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
          access: sessionResourceAccessProvider,
          registry: options.runtimeServices.registry,
          bridge: options.runtimeServices.sessionBridge,
        }),
        uploads: attachmentUploadOptions!,
      };
  const attachmentInputAdmission = attachmentReadOptions === undefined || options.findSessionNode === undefined
    ? undefined
    : createLiveAttachmentInputAdmission({
        repository: options.dependencies.dbCatalogRepository.attachmentReadRepository,
        resolveEmail: authenticatedUserResolvers.resolveEmail,
        readService: attachmentReadOptions.service,
        findSessionNode: options.findSessionNode,
      });
  const agentAttachmentRoutes = options.agentAttachmentRegistration === undefined
    ? undefined
    : {
        authBearerToken: options.agentAttachmentRegistration.authBearerToken,
        environment: options.agentAttachmentRegistration.environment,
        register: createAgentAttachmentRegistration({
          sql: options.agentAttachmentRegistration.sql,
          commit: commits!,
          readAsset: (id) => options.dependencies.dbCatalogRepository.attachmentReadRepository.getAsset(id),
        }),
        validateSessionOutput: createSessionOutputAttachmentValidation({
          sql: options.agentAttachmentRegistration.sql,
        }),
      };
  const workerAttachmentRoutes = (() => {
    const registration = options.agentAttachmentRegistration;
    const sqlResolver = options.dbSqlResolver;
    const resolveReadStorage = options.resolveReadStorage;
    if (registration === undefined || sqlResolver === undefined || resolveReadStorage === undefined) {
      return undefined;
    }
    const repository = createLiveWorkerAttachmentRepository(sqlResolver);
    return {
      authBearerToken: registration.authBearerToken,
      environment: registration.environment,
      service: createWorkerAttachmentRead({
        access: createWorkerAttachmentAccess({
          repository,
          findSession: repository.findSession,
          findDelivery: repository.findDelivery,
        }),
        repository,
        resolveReadStorage,
      }),
    };
  })();
  const sessionStreamEventFilter = createSessionStreamEventFilter({
    accessProvider: sessionResourceAccessProvider,
    repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
  });
  const sessionCreateLifecycle = createSessionCreateLifecycle({
    resolveCallerInfo: authenticatedUserResolvers.resolveCallerInfo,
    boardItems: options.dependencies.dbCatalogRepository.boardItemRouteProvider,
    access: sessionResourceAccessProvider,
  });
  const sessionStatisticsProvider = createLiveSessionStatisticsProvider({
    repositoryProvider: options.sessionStatisticsRepositoryProvider,
    accessProvider: dashboardAccessProvider,
    folderProvider: options.dependencies.dbCatalogRepository.folderRouteProvider,
    now: () => new Date(),
  });

  return {
    agentProfileRoutes: {
      repository: options.dependencies.dbCatalogRepository.agentProfileRepository,
      bundleRepository: options.dependencies.dbCatalogRepository.contextBundleRepository,
    },
    contextBundleRoutes: {
      repository: options.dependencies.dbCatalogRepository.contextBundleRepository,
      profileRepository: options.dependencies.dbCatalogRepository.agentProfileRepository,
    },
    authenticatedUserResolvers,
    modelPresetAvailability,
    adminUsersRoutes: {
      provider: createLiveAdminUsersRouteProvider({
        repository: options.dependencies.dbCatalogRepository.adminUsersRepository,
        currentEmail: authenticatedUserResolvers.resolveEmail,
        isAdminEmail: dashboardAccessProvider.isAdminEmail,
        listFolders: options.dependencies.dbCatalogRepository.folderRouteProvider.listFolders,
        broadcastAccessChange: () =>
          broadcastCatalogSnapshot(
            options.dependencies.dbCatalogRepository.folderRouteProvider,
            options.runtimeServices.sessionBroadcaster,
          ),
      }),
    },
    atomRoutes: {
      configProvider: configProviders.atomRoutes.configProvider,
      httpClient: createLiveAtomHttpClient(),
    },
    attachmentRoutes: {
      ...attachmentProviders,
      ...(attachmentReadOptions === undefined ? {} : { assetRead: attachmentReadOptions }),
      ...(attachmentUploadOptions === undefined ? {} : { assetUpload: attachmentUploadOptions }),
      ...(attachmentMultipartOptions === undefined ? {} : { multipart: attachmentMultipartOptions }),
    },
    ...(agentAttachmentRoutes === undefined ? {} : { agentAttachmentRoutes }),
    ...(workerAttachmentRoutes === undefined ? {} : { workerAttachmentRoutes }),
    authRoutes: {
      configProvider: configProviders.authRoutes.configProvider,
      httpClient: createLiveAuthHttpClient(),
      jwt: authJwt,
      nativeVerifier: createLiveAuthNativeVerifier({
        configProvider: options.dependencies.configProvider,
      }),
      resolveTokenAccess: createLiveAuthTokenResolver({
        configProvider: options.dependencies.configProvider,
        jwt: authJwt,
        resolveDashboardUser: authenticatedUserResolvers.resolveUser,
      }),
      authorizeUser,
      userPayloadExtra: dashboardAccessProvider.userPayloadExtra,
    },
    folderRoutes: {
      provider: options.dependencies.dbCatalogRepository.folderRouteProvider,
      accessProvider: dashboardAccessProvider,
      resolveDashboardUserId: authenticatedUserResolvers.resolveEmail,
    },
    boardAssetRoutes: {
      provider: withBoardAssetMutationBroadcasts(
        options.dependencies.dbCatalogRepository.boardAssetRouteProvider,
        options.dependencies.dbCatalogRepository.folderRouteProvider,
        options.runtimeServices.sessionBroadcaster,
      ),
      accessProvider: dashboardAccessProvider,
    },
    boardItemRoutes: {
      provider: options.dependencies.dbCatalogRepository.boardItemRouteProvider,
      accessProvider: dashboardAccessProvider,
    },
    markdownDocumentRoutes: {
      provider: options.dependencies.dbCatalogRepository.markdownDocumentRouteProvider,
      accessProvider: dashboardAccessProvider,
    },
    publicStatusRoutes: {
      folderCountsProvider: {
        ...options.dependencies.dbCatalogRepository.folderCountsProvider,
        resolveAccess: dashboardAccessProvider.resolveAccess,
      },
    },
    pushRoutes: {
      repository: options.dependencies.pushRepository,
      resolveJwtUser: authenticatedUserResolvers.resolveUser,
    },
    userPreferencesRoutes: {
      repository: options.dependencies.dbCatalogRepository.userPreferencesRepository,
      resolveAuthenticatedEmail: authenticatedUserResolvers.resolveEmail,
    },
    userBackgroundRoutes: {
      repository: options.dependencies.dbCatalogRepository.userPreferencesRepository,
      resolveAuthenticatedEmail: authenticatedUserResolvers.resolveEmail,
    },
    sessionCatalogRoutes: {
      provider: withSessionCatalogMutationBroadcasts(
        options.dependencies.dbCatalogRepository.sessionCatalogProvider,
        options.dependencies.dbCatalogRepository.folderRouteProvider,
        options.runtimeServices.sessionBroadcaster,
      ),
      accessProvider: sessionResourceAccessProvider,
    },
    runtime: buildLiveRuntimeProviderBundle(
      options.runtimeServices,
      sessionResourceAccessProvider,
      sessionStreamEventFilter,
      authenticatedUserResolvers.resolveCallerInfo,
      sessionCreateLifecycle,
      options.dependencies.dbCatalogRepository.sessionReviewRepository,
      modelPresetAvailability,
      {
        snapshotService: {
          async listSessions(query, request) {
            const folderId = query.folder_id ?? query.folderId;
            if (folderId !== undefined) {
              await sessionResourceAccessProvider.requireFolderAccess({
                request,
                folderId,
              });
            }
            const access = await sessionResourceAccessProvider.resolveAccess({ request });
            return options.dependencies.dbCatalogRepository.listSessionSnapshots({
              access,
              sessionIds: resolveSessionSnapshotIds(query.session_ids),
              feedOnly: query.feed_only === true,
              feedDisplay: query.feed_display === true,
              folderId,
              sessionType: query.session_type, search: query.search, nodeId: query.node_id, statuses: query.status,
              backends: query.backend, updatedAfter: query.updated_after,
              offset: resolveSessionSnapshotOffset(query),
              limit: resolveSessionSnapshotLimit(query.limit),
            });
          },
        },
      },
      async (request) => {
        const access = await sessionResourceAccessProvider.resolveAccess({ request });
        const feedDisplay = queryBool(request.query, "feed_display");
        const requestedLimit = queryNumber(request.query, "limit");
        return options.dependencies.dbCatalogRepository.loadSessionSnapshot({
          access,
          feedOnly: queryBool(request.query, "feed_only"),
          feedDisplay,
          ...(feedDisplay
            ? {
                limit: resolveSessionSnapshotLimit(requestedLimit ?? 30),
                offset: 0,
              }
            : {}),
        });
      },
      attachmentInputAdmission?.forRequest,
    ),
    cogitoRoutes: {
      ...cogitoProviders.cogitoRoutes,
      accessProvider: cogitoSearchAccessProvider,
    },
    configProviders,
    executeProxyRoutes: {
      provider: createLiveExecuteProxyRouteProvider({
        registry: options.runtimeServices.registry,
        router: options.runtimeServices.sessionRouter,
        bridge: options.runtimeServices.sessionBridge,
        sessionEventHub: options.runtimeServices.sessionEventHub,
        modelPresetAvailability,
        ...(options.dbSqlResolver === undefined ? {} : {
          persistentResume: {
            getSession: async (sessionId: string) => {
              const sql = await options.dbSqlResolver!.resolveSql();
              const rows = await sql<Record<string, unknown>[]>`SELECT * FROM session_get(${sessionId})`;
              return rows[0] ?? null;
            },
            updateSession: async (input) => {
              const sql = await options.dbSqlResolver!.resolveSql();
              await sql`
                UPDATE sessions SET node_id = ${input.nodeId},
                  model_preset = ${input.modelPreset}, model = ${input.model},
                  reasoning_effort = ${input.reasoningEffort},
                  claude_session_id = ${input.claudeSessionId},
                  metadata = ${sql.json(input.metadata)}
                WHERE session_id = ${input.sessionId}
              `;
            },
            listAgentProfiles: async (nodeId: string) =>
              await nodeAgentProfileProviders.nodeAgentProfileRoutes.provider.listAgentProfiles(nodeId) as
                Record<string, unknown> | undefined,
          },
        }),
        ...(attachmentInputAdmission === undefined ? {} : {
          admitAttachmentInput: (request, input) => attachmentInputAdmission.forRequest(
            request ?? { headers: {} } as FastifyRequest,
            input,
          ),
        }),
      }),
    },
    nodeAgentProfileRoutes: {
      ...nodeAgentProfileProviders.nodeAgentProfileRoutes,
      modelPresetProvider: modelPresetAvailability,
    },
    nodeClaudeAuthRoutes: nodeClaudeAuthProviders.nodeClaudeAuthRoutes,
    systemConfigRoutes: systemConfigProviders.systemConfigRoutes,
    usageSummaryRoutes: options.usageSummaryRoutes,
    sessionStatisticsRoutes: sessionStatisticsProvider,
    uiEventRoutes: {
      repository: options.uiEventRepository,
      resolveIdentity: createLiveUiEventIdentityResolver({
        resolveCallerInfo: authenticatedUserResolvers.resolveCallerInfo,
      }),
    },
    implementedProviderPaths: alignment.factoryProviderPaths,
  };
}

function createLiveSessionStatisticsProvider(options: {
  repositoryProvider: () => Promise<SessionStatisticsRepositoryPort>;
  accessProvider: SessionStatisticsRouteOptions["accessProvider"];
  folderProvider: SessionStatisticsRouteOptions["folderProvider"];
  now: () => Date;
}): LiveSessionStatisticsProvider {
  const service = new SessionStatisticsDailyService(options.repositoryProvider, options.now);
  return {
    service,
    accessProvider: options.accessProvider,
    folderProvider: options.folderProvider,
    now: options.now,
    startBackground: () => {
      void service.startBackground(async () => {
        const asOf = options.now().toISOString();
        return {
          query: { period: "week", anchor: statisticsLiveDays(asOf).at(-1)! },
          timezone: "Asia/Seoul",
          asOf,
          access: { restricted: false, allowedFolderIds: [] },
          visibleFolders: await options.folderProvider.listFolders(),
          day: null,
        };
      });
    },
  };
}

function assertLiveProviderDependencies(
  dependencies: unknown,
): asserts dependencies is LiveProviderDependencies {
  const missing = liveProviderDependencyCategories.filter(
    (category) =>
      dependencies == null ||
      (dependencies as Partial<Record<typeof category, unknown>>)[category] ==
        null,
  );
  if (missing.length > 0) {
    throw new LiveProviderFactoryError(
      missing.map((category) => ({
        owner: "live.dependencies",
        path: category,
        status: "factory_missing",
        source: "CreateLiveOrchestratorProviderBundleOptions.dependencies",
        notes: "Live provider factory dependencies must be passed explicitly.",
      })),
    );
  }
}

function queryBool(query: unknown, key: string): boolean {
  if (typeof query !== "object" || query === null || !(key in query)) return false;
  const value = (query as Record<string, unknown>)[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return (
    typeof raw === "string" &&
    ["1", "true", "yes", "on"].includes(raw.toLowerCase())
  );
}

function queryNumber(query: unknown, key: string): number | undefined {
  if (typeof query !== "object" || query === null || !(key in query)) return undefined;
  const value = (query as Record<string, unknown>)[key];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
