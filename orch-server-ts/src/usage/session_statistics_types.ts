import type {
  UsageStatsOverview,
  UsageStatsQuery,
  UsageStatsRange,
} from "@soulstream/wire-schema/session-statistics";
import type { FolderAccess, FolderRecord } from "../folders/folder_route_access.js";
import type { CanonicalSessionStatisticsRow } from "./session_statistics_canonical_sql.js";

export type SessionStatisticsReadRequest = {
  query: UsageStatsQuery;
  timezone: "Asia/Seoul";
  asOf: string;
  access: Required<FolderAccess>;
  visibleFolders: readonly FolderRecord[];
  day: string | null;
};

export type SessionStatisticsScopeSession = {
  sessionId: string;
  folderId: string | null;
  cardFolderId: string | null;
  projectId: string | null;
  projectLabel: string;
};

export type SessionStatisticsReadResult = {
  query: UsageStatsQuery;
  asOf: string;
  range: UsageStatsRange;
  projectionStatus: UsageStatsOverview["projection_status"];
  collectionCoverage: "unknown";
  visibleFolders?: SessionStatisticsReadRequest["visibleFolders"];
  sessions: readonly SessionStatisticsScopeSession[];
  rows: readonly CanonicalSessionStatisticsRow[];
  costDecimals: ReadonlyMap<string, string>;
};

export type SessionStatisticsRepositoryPort = {
  daily?: import("./session_statistics_daily_repository.js").SessionStatisticsDailyRepositoryPort;
  readMetadata?(input: SessionStatisticsReadRequest): Promise<SessionStatisticsReadResult>;
  readSlice?(input: SessionStatisticsReadRequest, day: string): Promise<SessionStatisticsReadResult>;
  readOverviewSlice?(input: SessionStatisticsReadRequest, day: string): Promise<SessionStatisticsReadResult>;
  read(input: SessionStatisticsReadRequest): Promise<SessionStatisticsReadResult>;
};
