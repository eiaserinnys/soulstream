import type { AuthUserAuthorizer } from "../auth/auth_routes.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import type { WebhookPost } from "../external_events/webhook_transport.js";
import { OutboundWebhookService } from "./outbound_service.js";

export type ProductionOutboundWebhookOptions = {
  resolveSql: () => Promise<SqlClient>;
  authorizeUser: AuthUserAuthorizer;
  sessionAccess: Pick<SessionResourceAccessProvider, "requireSessionAccess">;
  post?: WebhookPost;
  warn: (message: string) => void;
};

/** Wires the outbound webhook service from the live orchestrator providers. */
export function createProductionOutboundWebhook(
  options: ProductionOutboundWebhookOptions,
): OutboundWebhookService {
  return new OutboundWebhookService({
    resolveSql: options.resolveSql,
    authorizeUser: options.authorizeUser,
    requireSessionAccess: async (input) => {
      await options.sessionAccess.requireSessionAccess(input);
    },
    ...(options.post === undefined ? {} : { post: options.post }),
    warn: options.warn,
  });
}
