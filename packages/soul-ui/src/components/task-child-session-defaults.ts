import type { CatalogState, SessionSummary, TaskItem } from "../shared";
import type { NewSessionDefaults } from "../stores/dashboard-store-types";

export function resolveTaskChildSessionDefaults(
  task: TaskItem,
  sessionById: Map<string, SessionSummary>,
  catalog: CatalogState | null,
): NewSessionDefaults | null {
  const parentSessionId = resolveParentSessionId(task);
  if (!parentSessionId) return null;

  const parentSession = sessionById.get(parentSessionId);
  const folderId = catalog?.sessions[parentSessionId]?.folderId ?? null;
  const nodeId =
    parentSession?.nodeId ??
    task.navigationNodeId ??
    task.linkedNodeId ??
    undefined;
  const agentId = parentSession?.agentId ?? null;

  const defaults: NewSessionDefaults = {};
  if (folderId) defaults.folderId = folderId;
  if (nodeId) defaults.nodeId = nodeId;
  if (agentId) defaults.agentId = agentId;

  return Object.keys(defaults).length > 0 ? defaults : null;
}

function resolveParentSessionId(task: TaskItem): string | null {
  return (
    task.navigationSessionId ??
    task.linkedSessionId ??
    task.activeForSessionId ??
    task.createdFromSessionId ??
    null
  );
}
