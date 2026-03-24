/**
 * catalog API — GET /api/catalog : folders + sessions 통합 조회.
 *
 * 클라이언트(orchestrator-dashboard)가 최초 로드 시 한 번에 폴더 목록과
 * 세션 목록을 가져올 수 있도록 두 쿼리를 병렬로 실행하여 반환한다.
 */

import { Router } from "express";
import type { SessionDB } from "../db/session-db";

export function createCatalogRouter(sessionDB: SessionDB): Router {
  const router = Router();

  /** GET /api/catalog → { folders, sessions, total } */
  router.get("/catalog", async (_req, res) => {
    try {
      const [folders, sessionsResult] = await Promise.all([
        sessionDB.listFolders(),
        sessionDB.listSessions({ limit: 100 }),
      ]);
      res.json({
        folders,
        sessions: sessionsResult.sessions,
        total: sessionsResult.total,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
