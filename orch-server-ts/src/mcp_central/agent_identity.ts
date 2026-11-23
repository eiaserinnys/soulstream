import type { AdminAccessProvider } from "../admin/admin_access.js";
import { verifyServiceBearerAuthorization, type ServiceBearerOptions } from "../auth/service_bearer.js";
import type { SessionOwnerResolver } from "../session/session_owner.js";

export function createMcpCentralAccessProvider(options: {
  provider: AdminAccessProvider;
  auth: ServiceBearerOptions;
  resolveSessionOwner: SessionOwnerResolver;
}): AdminAccessProvider {
  return {
    isAdminEmail: email => options.provider.isAdminEmail(email),
    async currentEmail(request) {
      const sessionId = request.headers["x-soulstream-agent-session-id"];
      const verified = verifyServiceBearerAuthorization(request.headers.authorization, options.auth);
      if (typeof sessionId === "string" && sessionId && verified.ok && !verified.developmentBypass) {
        return (await options.resolveSessionOwner(sessionId))?.ownerEmail ?? null;
      }
      return options.provider.currentEmail(request);
    },
  };
}
