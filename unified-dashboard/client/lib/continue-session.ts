import { adminTranslation, type AdminTranslate } from "../components/config/admin-translation";
import type {
  CatalogState,
  SessionSummary,
} from "@seosoyoung/soul-ui";

export interface ResolveContinueSessionTargetInput {
  session: SessionSummary | null | undefined;
  catalog: CatalogState | null;
}

export interface ContinueSessionTarget {
  disabledReason: string | null;
  nodeId?: string;
  agentId?: string | null;
  agentName?: string | null;
  agentPortraitUrl?: string | null;
  backend?: string | null;
  folderId?: string | null;
}

export function resolveContinueSessionTarget({
  session,
  catalog,
}: ResolveContinueSessionTargetInput, t: AdminTranslate = adminTranslation()): ContinueSessionTarget {
  if (!session) {
    return { disabledReason: t("admin.session.notFound") };
  }

  const nodeId = session.nodeId;
  if (!nodeId) {
    return { disabledReason: t("admin.session.nodeMissing") };
  }

  if (!session.agentId) {
    return { disabledReason: t("admin.session.agentMissing") };
  }

  return {
    disabledReason: null,
    nodeId,
    agentId: session.agentId,
    agentName: session.agentName ?? null,
    agentPortraitUrl: session.agentPortraitUrl ?? null,
    backend: session.backend ?? null,
    folderId: session.folderId ?? catalog?.sessions?.[session.agentSessionId]?.folderId ?? null,
  };
}
