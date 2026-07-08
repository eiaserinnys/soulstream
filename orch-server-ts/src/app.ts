import Fastify, { type FastifyInstance } from "fastify";

import type { OrchServerTsConfig } from "./config.js";
import { routeOwnerManifest, type RouteOwnerManifest } from "./contract/route_owner_manifest.js";
import { registerNodeWsRoute, type NodeWsRouteOptions } from "./node/ws_route.js";

export type CreateAppOptions = {
  config: OrchServerTsConfig;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  nodeWsRoute?: NodeWsRouteOptions;
};

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const owners = options.routeOwners ?? routeOwnerManifest;

  if (options.exposeLocalHealthRoute) {
    app.get("/__orch_server_ts/health", async () => ({
      ok: true,
      package: "@soulstream/orch-server-ts",
      environment: options.config.environment,
      routeOwnersArtifactOnly: owners.artifactOnly,
    }));
  }
  if (options.nodeWsRoute !== undefined) {
    registerNodeWsRoute(app, options.nodeWsRoute);
  }

  return app;
}
