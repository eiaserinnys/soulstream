/**
 * Orchestrator Dashboard API Config
 *
 * soul-ui의 CatalogApiConfig 프리셋. orchestrator-dashboard 전용 API 경로와 동작을 정의한다.
 */

import type { CatalogApiConfig } from "@seosoyoung/soul-ui";

export const ORCHESTRATOR_API: CatalogApiConfig = {
  folderBasePath: "/api/folders",
  sessionBatchMovePath: "/api/sessions/folder",
  sessionBatchMoveMethod: "PATCH",
  sessionBatchMoveBody: (ids, folderId) => ({ sessionIds: ids, folderId }),
  deleteFallbackFolderId: (folders, deletedId) =>
    folders.find((f) => f.id !== deletedId)?.id ?? null,
};
