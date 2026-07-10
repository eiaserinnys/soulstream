import type { AttachmentRouteOptions } from "../attachments/attachment_routes.js";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import type { LiveDashboardAccessProvider } from "./live_dashboard_access_provider.js";

export type LiveAttachmentRouteProviderBundle = Pick<
  AttachmentRouteOptions,
  "provider" | "accessProvider"
>;

export type CreateLiveAttachmentRouteProvidersOptions = {
  readonly registry: Pick<InMemoryNodeRegistry, "getConnectedNode">;
  readonly dashboardAccessProvider: Pick<
    LiveDashboardAccessProvider,
    "resolveAccess"
  >;
  readonly sessionResourceAccessProvider: Pick<
    SessionResourceAccessProvider,
    "requireSessionAccess"
  >;
};

export function createLiveAttachmentRouteProviders(
  options: CreateLiveAttachmentRouteProvidersOptions,
): LiveAttachmentRouteProviderBundle {
  return {
    provider: {
      async getNode(nodeId) {
        return options.registry.getConnectedNode(nodeId) ?? null;
      },
    },
    accessProvider: {
      resolveAccess: options.dashboardAccessProvider.resolveAccess,
      requireSessionAccess:
        options.sessionResourceAccessProvider.requireSessionAccess,
    },
  };
}
