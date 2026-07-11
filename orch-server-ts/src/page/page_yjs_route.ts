import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { registerWebsocketPlugin } from "../websocket_plugin.js";
import {
  registerPageBrowserRoutes,
  type PageBrowserRouteOptions,
} from "./page_browser_routes.js";
import { registerPageYjsHostOperationRoutes } from "./page_host_operations.js";
import type { PageYjsService } from "./page_service.js";

export const pageYjsRouteAuthRequirements = {
  "WEBSOCKET /yjs/page/{pageId}": false,
  "POST /api/page-yjs/host/{operation}": true,
} as const;

export interface PageYjsRouteOptions {
  createService: (logger: FastifyBaseLogger) => PageYjsService;
  authBearerToken: string;
  resolveBrowserUser?: PageBrowserRouteOptions["resolveUser"];
}

export function registerPageYjsRoutes(
  app: FastifyInstance,
  options: PageYjsRouteOptions,
): void {
  const service = options.createService(app.log);
  service.assertWebsocketAuthConfigured();
  registerPageYjsHostOperationRoutes(app, {
    service,
    authBearerToken: options.authBearerToken,
  });
  if (options.resolveBrowserUser) {
    registerPageBrowserRoutes(app, { service, resolveUser: options.resolveBrowserUser });
  }
  registerWebsocketPlugin(app);
  app.after(() => {
    app.get<{ Params: { pageId: string } }>(
      "/yjs/page/:pageId",
      { websocket: true },
      (socket, request) => {
        service.handleConnection(socket, request.raw, request.params.pageId);
      },
    );
  });
  app.addHook("onClose", async () => service.close());
}
