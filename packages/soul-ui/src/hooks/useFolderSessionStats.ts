/**
 * useFolderSessionStats — 폴더별 세션 통계 훅
 *
 * react-query 캐시에 적재된 모든 sessions를 수집하여
 * 폴더별 세션 수 / 미읽음 수 / running 여부를 계산한다.
 *
 * folderCounts(서버 집계값)가 주어지면 세션 수에 한해 서버 값을 우선한다.
 * 미읽음/running은 항상 클라이언트 sessions로 계산한다.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useDashboardStore, isSessionUnread } from "../stores/dashboard-store";
import type { SessionPage } from "./session-stream-helpers";
import type { SessionSummary } from "../shared/types";

export interface UseFolderSessionStatsResult {
  getSessionCount: (folderId: string | null) => number;
  getDirectChildCount: (folderId: string) => number;
  getUnreadCount: (folderId: string | null) => number;
  runningFolderIds: Set<string>;
}

export function useFolderSessionStats(
  folderCounts?: Record<string, number>,
): UseFolderSessionStatsResult {
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);

  const queryClient = useQueryClient();
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      setCacheVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [queryClient]);

  const sessions = useMemo<SessionSummary[]>(() => {
    const allData = queryClient.getQueriesData<InfiniteData<SessionPage>>({
      queryKey: ["sessions"],
      exact: false,
    });
    const all: SessionSummary[] = [];
    for (const [, data] of allData) {
      if (!data) continue;
      for (const page of data.pages) all.push(...page.sessions);
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, queryClient]);

  const getSessionCount = useCallback(
    (folderId: string | null) => {
      if (folderCounts) {
        const key = folderId === null ? "null" : folderId;
        return folderCounts[key] ?? 0;
      }
      if (!catalog) return 0;
      return sessions.filter((s) => {
        const assignment = catalog.sessions[s.agentSessionId];
        if (folderId === null) {
          return !assignment || assignment.folderId === null;
        }
        return assignment?.folderId === folderId;
      }).length;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [catalog, sessions, catalogVersion, folderCounts],
  );

  const getUnreadCount = useCallback(
    (folderId: string | null) => {
      if (!catalog) return 0;
      return sessions.filter((s) => {
        const assignment = catalog.sessions[s.agentSessionId];
        if (folderId === null) {
          return (!assignment || assignment.folderId === null) && isSessionUnread(s);
        }
        return assignment?.folderId === folderId && isSessionUnread(s);
      }).length;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [catalog, sessions, catalogVersion],
  );

  const getDirectChildCount = useCallback(
    (folderId: string) => {
      const sessionCount = getSessionCount(folderId);
      const folderCount = catalog?.folders.filter((f) => f.parentFolderId === folderId).length ?? 0;
      return sessionCount + folderCount;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [catalog, catalogVersion, getSessionCount],
  );

  const runningFolderIds = useMemo(() => {
    if (!catalog) return new Set<string>();
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.status === "running") {
        const fid = catalog.sessions[s.agentSessionId]?.folderId;
        if (fid) set.add(fid);
      }
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, sessions, catalogVersion]);

  return { getSessionCount, getDirectChildCount, getUnreadCount, runningFolderIds };
}
