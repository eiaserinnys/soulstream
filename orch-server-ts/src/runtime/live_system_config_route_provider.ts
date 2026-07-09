import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type {
  SystemConfigHttpClient,
  SystemConfigNodeCandidate,
  SystemConfigRouteProvider,
  SystemPortraitResult,
  SystemPortraitSource,
} from "../system/system_config_routes.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";

export type SystemPortraitAssetFileName = "system.png";

export const systemPortraitAssetFileBySource = {
  system: "system.png",
  channel_observer: "system.png",
  trello_watcher: "system.png",
} as const satisfies Record<SystemPortraitSource, SystemPortraitAssetFileName>;

export type LiveSystemPortraitAssetBoundary = {
  readonly readSystemPortraitAsset: (
    filename: SystemPortraitAssetFileName,
  ) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
};

export type LiveSystemConfigNodeRegistry = {
  readonly listConnectedNodes: () => readonly NodeConnectionSnapshot[];
};

export type CreateLiveSystemConfigRouteProviderOptions = {
  readonly registry: LiveSystemConfigNodeRegistry;
  readonly portraitAssets: LiveSystemPortraitAssetBoundary;
};

export type LiveSystemConfigNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveSystemConfigHttpClientOptions = {
  readonly nodeHttpClient: LiveSystemConfigNodeHttpClient;
};

export type CreateLiveSystemConfigRouteProvidersOptions =
  CreateLiveSystemConfigRouteProviderOptions &
  CreateLiveSystemConfigHttpClientOptions;

export type LiveSystemConfigRouteProviderBundle = {
  readonly systemConfigRoutes: {
    readonly provider: SystemConfigRouteProvider;
    readonly httpClient: SystemConfigHttpClient;
  };
};

export function createLiveSystemConfigRouteProvider(
  options: CreateLiveSystemConfigRouteProviderOptions,
): SystemConfigRouteProvider {
  return {
    getSystemPortrait: (source) => getSystemPortrait(options, source),
    listConnectedNodes: () => listConnectedNodes(options.registry),
  };
}

export function createLiveSystemConfigRouteProviders(
  options: CreateLiveSystemConfigRouteProvidersOptions,
): LiveSystemConfigRouteProviderBundle {
  return {
    systemConfigRoutes: {
      provider: createLiveSystemConfigRouteProvider(options),
      httpClient: createLiveSystemConfigHttpClient(options),
    },
  };
}

export function createLiveSystemConfigHttpClient(
  options: CreateLiveSystemConfigHttpClientOptions,
): SystemConfigHttpClient {
  return async (request) => {
    const response = await options.nodeHttpClient.requestNode({
      nodeId: request.node.nodeId,
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    };
  };
}

async function getSystemPortrait(
  options: CreateLiveSystemConfigRouteProviderOptions,
  source: SystemPortraitSource,
): Promise<SystemPortraitResult | undefined> {
  const filename = systemPortraitAssetFileBySource[source];
  const body = await options.portraitAssets.readSystemPortraitAsset(filename);
  if (body === undefined) return undefined;
  return { body };
}

function listConnectedNodes(
  registry: LiveSystemConfigNodeRegistry,
): SystemConfigNodeCandidate[] {
  return registry.listConnectedNodes().map((node) => ({
    nodeId: node.nodeId,
    host: node.host,
    port: node.port,
  }));
}
