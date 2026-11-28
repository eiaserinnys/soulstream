import type { createI18n } from "@soulstream/i18n";
import { isMcpVersionConflict, McpApiError, type McpConfig } from "../../lib/mcp-api";
import type { DeleteTarget } from "./McpDialogs";

export class PartialProfileSaveError extends Error {}

export type McpErrorAction = "reload" | "showProfiles" | null;

export function mcpErrorAction(error: unknown): McpErrorAction {
  if (!(error instanceof McpApiError)) return null;
  if (isMcpVersionConflict(error)) return "reload";
  return error.code === "MCP_SERVER_INUSE" ? "showProfiles" : null;
}

export function errorText(
  t: ReturnType<typeof createI18n>["t"],
  error: unknown,
  config: McpConfig | null,
  target: DeleteTarget | null,
  action: "save" | "delete" | "rollback" = "save",
): string {
  if (error instanceof PartialProfileSaveError)
    return t("mcp.partialProfileSave");
  if (!(error instanceof McpApiError))
    return t("mcp.requestFailed");
  if (isMcpVersionConflict(error)) {
    if (action === "delete") return t("mcp.deleteConflict");
    if (action === "rollback") return t("mcp.rollbackConflict");
    return t("mcp.saveConflict");
  }
  if (error.code === "MCP_SERVER_INUSE") {
    const profiles = config?.profiles
        .filter((p) => p.mcp_servers.includes(target?.id ?? ""))
        .map((p) => p.name || p.id) ?? [];
    const names = profiles.slice(0, 3).join(", ") || error.message || t("mcp.requestFailedBrief");
    const rest = profiles.length > 3 ? " " + t("mcp.remainingCount", { count: profiles.length - 3 }) : "";
    return t("mcp.serverInUse", { profiles: names + rest });
  }
  if (error.code === "MCP_PROFILE_INUSE") {
    const agents = config?.bindings
      .filter((binding) => binding.mcp_profile_id === target?.id)
      .map((binding) => `${binding.agent_id} (${binding.node_id})`)
      .join(", ") || error.message || t("mcp.requestFailedBrief");
    return t("mcp.profileInUse", { agents });
  }
  if (error.code === "MCP_SECRET_INUSE") {
    const secret = config?.secrets.find((s) => s.name === target?.id);
    return t("mcp.secretInUse", {
      servers: secret?.servers.join(", ") || t("mcp.none"),
      profiles: secret?.profiles.join(", ") || t("mcp.none"),
    });
  }
  const messages: Record<string, string> = {
    MCP_DUPLICATE_SERVER_NAME: t("mcp.duplicateTransportName"),
    MCP_MIXED_SECRET_ENV_REF: t("mcp.mixedReferences"),
    MCP_INVALID_ICON: t("mcp.invalidIcon"),
    MCP_INVALID_ICON_UPLOAD: t("mcp.invalidIconUpload"),
    MCP_ROLLBACK_BROKEN_REFERENCE: t("mcp.brokenRollbackReference"),
  };
  return messages[error.code] ?? t("mcp.checkRequestAndRetry");
}
