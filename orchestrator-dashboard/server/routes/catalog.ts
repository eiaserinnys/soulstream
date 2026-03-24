/**
 * catalog 라우트 — DB 직접 쿼리: folders + sessions.
 *
 * GET /api/catalog → { folders, sessions }
 *
 * 이 라우트는 soul-stream 투명 프록시 앞에 등록되므로,
 * soul-stream의 /api/catalog 응답을 의도적으로 오버라이드한다.
 * Phase 3 클라이언트(useSessions, useCatalog)는 이 형식을 기대한다.
 */

import { Router } from 'express';
import type { OrchestratorSessionDB } from '../db/session-db.js';

export function createCatalogRouter(db: OrchestratorSessionDB): Router {
  const router = Router();

  router.get('/catalog', async (_req, res) => {
    try {
      const [folders, sessions] = await Promise.all([
        db.listFolders(),
        db.listSessions(),
      ]);
      res.json({ folders, sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
