import type { CatalogState, SessionSummary } from "../shared/types";

export function applyCatalogDisplayNames(
  sessions: SessionSummary[],
  catalog: CatalogState | null,
): SessionSummary[] {
  if (!catalog?.sessions) return sessions;
  return sessions.map((s) => {
    const assignment = catalog.sessions[s.agentSessionId];
    if (assignment?.displayName) {
      return { ...s, displayName: assignment.displayName };
    }
    return s;
  });
}

export function applyCatalogDisplayName(
  session: SessionSummary,
  catalog: CatalogState,
): SessionSummary {
  const assignment = catalog.sessions[session.agentSessionId];
  if (assignment?.displayName) {
    return { ...session, displayName: assignment.displayName };
  }
  return session;
}

function shallowSessionSummaryEqual(left: SessionSummary, right: SessionSummary): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const typedKey = key as keyof SessionSummary;
    if (left[typedKey] !== right[typedKey]) return false;
  }
  return true;
}

export function mergeSessionCreatedSummary(
  current: SessionSummary,
  incoming: SessionSummary,
): SessionSummary {
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined),
  ) as Partial<SessionSummary>;
  return { ...current, ...definedIncoming };
}

export function mergeSessionAssignmentsFromSummaries(
  catalog: CatalogState,
  sessions: readonly SessionSummary[],
): CatalogState {
  let changed = false;
  const updatedSessions = { ...catalog.sessions };
  let updatedSessionList = catalog.sessionList;

  for (const session of sessions) {
    if (updatedSessionList) {
      const index = updatedSessionList.findIndex(
        (entry) => entry.agentSessionId === session.agentSessionId,
      );
      if (index === -1) {
        updatedSessionList = [...updatedSessionList, session];
        changed = true;
      } else {
        const current = updatedSessionList[index];
        const merged = mergeSessionCreatedSummary(current, session);
        if (!shallowSessionSummaryEqual(current, merged)) {
          updatedSessionList = updatedSessionList.map((entry, entryIndex) =>
            entryIndex === index ? merged : entry,
          );
          changed = true;
        }
      }
    } else {
      updatedSessionList = [session];
      changed = true;
    }

    if (session.folderId === undefined && session.displayName === undefined) continue;
    const current = updatedSessions[session.agentSessionId];
    const next = {
      folderId: session.folderId !== undefined ? session.folderId : current?.folderId ?? null,
      displayName:
        session.displayName !== undefined
          ? session.displayName ?? null
          : current?.displayName ?? null,
    };
    if (
      !current ||
      current.folderId !== next.folderId ||
      current.displayName !== next.displayName
    ) {
      updatedSessions[session.agentSessionId] = next;
      changed = true;
    }
  }

  return changed ? { ...catalog, sessions: updatedSessions, sessionList: updatedSessionList } : catalog;
}

export function upsertSessionAssignmentInCatalog(
  catalog: CatalogState,
  agentSessionId: string,
  folderId: string | null,
  session?: SessionSummary,
): CatalogState {
  const nextCatalog = session
    ? upsertSessionInCatalogSessionList(catalog, session)
    : catalog;
  return {
    ...nextCatalog,
    sessions: {
      ...nextCatalog.sessions,
      [agentSessionId]: { folderId, displayName: null },
    },
  };
}

export function upsertSessionInCatalogSessionList(
  catalog: CatalogState,
  session: SessionSummary,
): CatalogState {
  const current = catalog.sessionList ?? [];
  const exists = current.some((item) => item.agentSessionId === session.agentSessionId);
  return {
    ...catalog,
    sessionList: exists
      ? current.map((item) =>
          item.agentSessionId === session.agentSessionId
            ? mergeSessionCreatedSummary(item, session)
            : item,
        )
      : [session, ...current],
  };
}

export function updateSessionInCatalogSessionList(
  catalog: CatalogState,
  agentSessionId: string,
  updates: Partial<SessionSummary>,
): CatalogState {
  if (!catalog.sessionList) return catalog;
  return {
    ...catalog,
    sessionList: catalog.sessionList.map((session) =>
      session.agentSessionId === agentSessionId ? { ...session, ...updates } : session,
    ),
  };
}

export function removeSessionFromCatalogSessionList(
  catalog: CatalogState,
  agentSessionId: string,
): CatalogState {
  if (!catalog.sessionList) return catalog;
  return {
    ...catalog,
    sessionList: catalog.sessionList.filter((session) => session.agentSessionId !== agentSessionId),
  };
}

export function preserveCatalogSessionList(
  incoming: CatalogState,
  current: CatalogState | null,
): CatalogState {
  if (incoming.sessionList) return incoming;
  if (!current?.sessionList) return incoming;
  return { ...incoming, sessionList: current.sessionList };
}
