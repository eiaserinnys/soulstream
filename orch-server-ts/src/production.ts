import { readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";

import { createApp, type CreateAppOptions } from "./app.js";
import {
  createEnvironmentConfigProvider,
  type OrchServerEnvironmentConfig,
  toOrchServerTsConfig,
} from "./config.js";
import { registerDashboardServing } from "./dashboard/dashboard_serving.js";
import { InMemoryNodeRegistry } from "./node/registry.js";
import {
  createOrchestratorRuntimeServices,
  type OrchestratorRuntimeServices,
} from "./runtime/composition.js";
import { resolveLiveBoardAssetStorageFromConfig } from "./runtime/live_board_asset_storage.js";
import { createLiveDbCatalogRepository } from "./runtime/live_db_catalog_repository.js";
import { createLiveDbSqlResolver } from "./runtime/live_db_sql.js";
import type { LiveProviderDependencies } from "./runtime/live_provider_dependencies.js";
import {
  createLiveOrchestratorProviderBundle,
  type LiveOrchestratorProviderBundle,
} from "./runtime/live_provider_factory.js";
import { createLivePushRegistrationRepository } from "./runtime/live_push_registration_repository.js";
import type { LiveSystemPortraitAssetBoundary } from "./runtime/live_system_config_route_provider.js";

export type ProductionApplication = {
  readonly app: FastifyInstance;
  readonly startBackground: () => Promise<void>;
  readonly closeResources: () => Promise<void>;
};

export type ProductionApplicationFactory = (
  config: OrchServerEnvironmentConfig,
  context: { readonly warn: (message: string) => void },
) => Promise<ProductionApplication>;

export type CreateProductionOrchestratorOptions = {
  readonly config: OrchServerEnvironmentConfig;
  readonly applicationFactory?: ProductionApplicationFactory;
  readonly warn?: (message: string) => void;
};

export type ProductionOrchestrator = {
  readonly app: FastifyInstance;
  readonly listen: () => Promise<string>;
  readonly close: () => Promise<void>;
};

export async function createProductionOrchestrator(
  options: CreateProductionOrchestratorOptions,
): Promise<ProductionOrchestrator> {
  const warn = options.warn ?? console.warn;
  const application = await (
    options.applicationFactory ?? createLiveProductionApplication
  )(options.config, { warn });
  await registerDashboardServing(application.app, {
    dashboardDir: options.config.dashboard_dir,
    warn,
  });

  let startAttempted = false;
  let closed = false;
  return {
    app: application.app,
    async listen() {
      if (closed) throw new Error("Production orchestrator is already closed");
      if (startAttempted) throw new Error("Production orchestrator listen() may only run once");
      startAttempted = true;
      try {
        await application.startBackground();
        return await application.app.listen({
          host: options.config.host,
          port: options.config.port,
        });
      } catch (error) {
        await closeApplication(application);
        closed = true;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeApplication(application);
    },
  };
}

export async function createLiveProductionApplication(
  config: OrchServerEnvironmentConfig,
  context: { readonly warn: (message: string) => void },
): Promise<ProductionApplication> {
  const appConfig = toOrchServerTsConfig(config);
  const configProvider = createEnvironmentConfigProvider(config);
  const sqlResolver = createLiveDbSqlResolver({ databaseUrl: config.database_url });
  const registry = new InMemoryNodeRegistry();
  const boardAssetStorage = await resolveLiveBoardAssetStorageFromConfig(config);
  warnForPartialR2Config(config, context.warn);
  const dbCatalogRepository = createLiveDbCatalogRepository({
    sqlResolver,
    configProvider,
    registry,
    boardAssetStorage,
  });
  const runtimeServices = createOrchestratorRuntimeServices({
    config: appConfig,
    registry,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    loadSessionSnapshot: async () => dbCatalogRepository.loadSessionSnapshot(),
    loadTaskSnapshot: dbCatalogRepository.loadTaskSnapshot,
    sessionHistoryProvider: dbCatalogRepository.sessionHistoryProvider,
    sessionHistoryCloseAfterHistorySync: false,
  });
  const dependencies: LiveProviderDependencies = {
    dbCatalogRepository,
    nodeHttpClient: runtimeServices.nodeHttpClient,
    pushRepository: createLivePushRegistrationRepository({ sqlResolver }),
    configProvider,
    systemPortraitAssets: createSystemPortraitAssets(),
  };

  let providers: LiveOrchestratorProviderBundle;
  try {
    providers = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
    });
  } catch (error) {
    await dbCatalogRepository.close();
    throw error;
  }
  const app = createApp(buildProductionRouteOptions(
    appConfig,
    runtimeServices,
    providers,
    config.cors_allowed_origins,
  ));
  let resourcesClosed = false;
  return {
    app,
    startBackground: providers.runtime.taskChangeListener.start,
    async closeResources() {
      if (resourcesClosed) return;
      resourcesClosed = true;
      await providers.runtime.taskChangeListener.stop();
      await dbCatalogRepository.close();
    },
  };
}

export function buildProductionRouteOptions(
  config: CreateAppOptions["config"],
  runtime: OrchestratorRuntimeServices,
  providers: LiveOrchestratorProviderBundle,
  corsAllowedOrigins: readonly string[] = [],
): CreateAppOptions {
  return {
    config,
    corsAllowedOrigins,
    adminUsersRoutes: providers.adminUsersRoutes,
    atomRoutes: providers.atomRoutes,
    authRoutes: providers.authRoutes,
    attachmentRoutes: providers.attachmentRoutes,
    boardAssetRoutes: providers.boardAssetRoutes,
    boardItemRoutes: {
      ...providers.boardItemRoutes,
      hostProxy: providers.runtime.boardYjsHostProxyRoutes,
    },
    boardYjsHostProxyRoutes: providers.runtime.boardYjsHostProxyRoutes,
    cogitoRoutes: providers.cogitoRoutes,
    executeProxyRoutes: providers.executeProxyRoutes,
    folderRoutes: providers.folderRoutes,
    markdownDocumentRoutes: {
      ...providers.markdownDocumentRoutes,
      hostProxy: providers.runtime.boardYjsHostProxyRoutes,
    },
    nodeAgentProfileRoutes: providers.nodeAgentProfileRoutes,
    nodeClaudeAuthRoutes: {
      ...providers.nodeClaudeAuthRoutes,
      registry: runtime.registry,
      bridge: runtime.sessionBridge,
    },
    nodeSnapshotRoutes: providers.runtime.nodeSnapshotRoutes,
    nodeWsRoute: providers.runtime.nodeWsRoute,
    publicStatusRoutes: {
      ...providers.publicStatusRoutes,
      configProvider: providers.configProviders.publicStatusRoutes.configProvider,
    },
    pushRoutes: providers.pushRoutes,
    runbookRoutes: providers.runbookRoutes,
    sessionActionCommandRoutes: providers.runtime.sessionActionCommandRoutes,
    sessionBackgroundScheduleRoutes:
      providers.runtime.sessionBackgroundScheduleRoutes,
    sessionCatalogRoutes: providers.sessionCatalogRoutes,
    sessionCommandRoutes: providers.runtime.sessionCommandRoutes,
    sessionHistoryRoutes: providers.runtime.sessionHistoryRoutes,
    sessionSnapshotRoutes: providers.runtime.sessionSnapshotRoutes,
    sseReplayRoutes: providers.runtime.sseReplayRoutes,
    systemConfigRoutes: providers.systemConfigRoutes,
    taskMutationRoutes: providers.taskMutationRoutes,
    taskReadRoutes: providers.taskReadRoutes,
    userBackgroundRoutes: providers.userBackgroundRoutes,
    userPreferencesRoutes: providers.userPreferencesRoutes,
  };
}

async function closeApplication(application: ProductionApplication): Promise<void> {
  let appCloseError: unknown;
  try {
    await application.app.close();
  } catch (error) {
    appCloseError = error;
  }
  try {
    await application.closeResources();
  } catch (resourceError) {
    if (appCloseError !== undefined) {
      throw new AggregateError(
        [appCloseError, resourceError],
        "Failed to close production orchestrator",
      );
    }
    throw resourceError;
  }
  if (appCloseError !== undefined) throw appCloseError;
}

function warnForPartialR2Config(
  config: OrchServerEnvironmentConfig,
  warn: (message: string) => void,
): void {
  const values = [
    config.r2_board_assets_access_key_id,
    config.r2_board_assets_secret_access_key,
    config.r2_board_assets_bucket,
    config.r2_board_assets_endpoint,
  ];
  if (values.some(Boolean) && !values.every(Boolean)) {
    warn("Board asset R2 storage is partially configured; asset uploads are disabled");
  }
}

function createSystemPortraitAssets(): LiveSystemPortraitAssetBoundary {
  const portraitUrl = new URL(
    "../../packages/soul-common/src/soul_common/portraits/",
    import.meta.url,
  );
  return {
    async readSystemPortraitAsset(filename) {
      try {
        return await readFile(new URL(filename, portraitUrl));
      } catch (error) {
        if (isMissingFileError(error)) return undefined;
        throw error;
      }
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
