import type { CogitoNode, CogitoNodeProvider } from "../cogito/cogito_routes.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";

export type LiveCogitoNodeRegistry = {
  readonly listConnectedNodes: () => readonly NodeConnectionSnapshot[];
};

export type CreateLiveCogitoRouteProviderOptions = {
  readonly registry: LiveCogitoNodeRegistry;
};

export type LiveCogitoRouteProviderBundle = {
  readonly cogitoRoutes: {
    readonly provider: CogitoNodeProvider;
  };
};

export function createLiveCogitoRouteProvider(
  options: CreateLiveCogitoRouteProviderOptions,
): CogitoNodeProvider {
  return {
    listConnectedNodes: () => listConnectedNodes(options.registry),
  };
}

export function createLiveCogitoRouteProviders(
  options: CreateLiveCogitoRouteProviderOptions,
): LiveCogitoRouteProviderBundle {
  return {
    cogitoRoutes: {
      provider: createLiveCogitoRouteProvider(options),
    },
  };
}

function listConnectedNodes(registry: LiveCogitoNodeRegistry): CogitoNode[] {
  return registry.listConnectedNodes().map((node) => ({
    id: node.nodeId,
    host: node.host,
    port: node.port,
    capabilities: { ...node.capabilities },
  }));
}
