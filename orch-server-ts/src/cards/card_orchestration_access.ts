import { ORCHESTRATION_DECISION_PURPOSE } from "@soulstream/wire-schema/card-orchestration";
import {
  isFolderAllowed,
  normalizeAccess,
  type FolderRecord,
} from "../folders/folder_route_access.js";
import type { DashboardUserRepository } from "../runtime/live_dashboard_access_provider.js";
export type CardOrchestrationAccessOptions = {
  getSession(sessionId: string): Promise<Record<string, unknown> | null>;
  listFolders(): Promise<readonly (FolderRecord & { archived?: boolean })[]>;
  findUserByEmail: DashboardUserRepository["findUserByEmail"];
};
/** Only persisted server metadata participates; request actor/email fields never do. */
export function createCardOrchestrationAccess(
  options: CardOrchestrationAccessOptions,
) {
  return {
    resolveCaller: async (
      sessionId: string,
    ): Promise<{ ownerEmail: string; purpose: string | null } | null> => {
      const session = await options.getSession(sessionId);
      if (!session) return null;
      const metadata = session.metadata;
      const entries = Array.isArray(metadata) ? metadata.filter(isRecord) : [];
      const purpose = entries.some(
        (entry) => entry.type === ORCHESTRATION_DECISION_PURPOSE,
      )
        ? ORCHESTRATION_DECISION_PURPOSE
        : null;
      let caller: Record<string, unknown> | undefined;
      for (const entry of entries) {
        if (entry.type !== "caller_info" || !isRecord(entry.value)) continue;
        if (
          ["slack", "browser", "soul-app", "agent"].includes(
            String(entry.value.source),
          )
        )
          caller = entry.value;
      }
      // Retain the pre-array canonical storage shape without trusting top-level request values.
      if (!Array.isArray(metadata) && isRecord(metadata)) {
        const legacy = metadata.caller_info ?? metadata.callerInfo;
        if (
          isRecord(legacy) &&
          ["slack", "browser", "soul-app", "agent"].includes(
            String(legacy.source),
          )
        )
          caller = legacy;
      }
      const email =
        typeof caller?.email === "string"
          ? caller.email.trim().toLowerCase()
          : "";
      if (!email) return null;
      return { ownerEmail: email, purpose };
    },
    validateFolder: async (
      id: string,
      ownerEmail: string,
    ): Promise<boolean> => {
      const [folders, user] = await Promise.all([
        options.listFolders(),
        options.findUserByEmail(ownerEmail),
      ]);
      const folder = folders.find((folder) => folder.id === id);
      if (!folder || folder.archived === true || !user) return false;
      const access = normalizeAccess(
        user.isAdmin || user.allowedFolderIds.length === 0
          ? { restricted: false }
          : { restricted: true, allowedFolderIds: user.allowedFolderIds },
      );
      return isFolderAllowed(access, folders, id);
    },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
