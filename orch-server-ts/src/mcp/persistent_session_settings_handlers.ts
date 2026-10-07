import { errorResult, jsonResult, persistentSessionSettingsTools } from "@soulstream/mcp-contract";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import type { McpToolHandler } from "./types.js";

export const persistentSessionSettingsHandlers = {
  update_persistent_session_settings: async (options, args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    const callerSessionId = context.callerSessionId?.trim();
    if (!callerSessionId || !options.resolveSessionOwner) {
      return errorResult("A trusted Soulstream caller session is required for persistent session settings.");
    }
    if (!options.persistentSessionSettings) {
      return errorResult("Persistent session settings service is unavailable.");
    }

    try {
      const owner = await options.resolveSessionOwner(callerSessionId);
      if (!owner) return errorResult("The trusted caller session has no verified owner email for persistent session settings.");
      const { session_id: sessionId, ...settings } = args;
      const result = await options.persistentSessionSettings.update(
        SERVICE_CALLER,
        sessionId as string,
        { settings },
        owner.ownerEmail,
      );
      return jsonResult({ session_id: sessionId, settings: result.session.settings });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
} satisfies Record<keyof typeof persistentSessionSettingsTools, McpToolHandler>;
