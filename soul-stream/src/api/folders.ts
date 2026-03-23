/**
 * 폴더 API.
 */

import { Router } from "express";
import type { SessionDB } from "../db/session-db";

export function createFoldersRouter(sessionDB: SessionDB): Router {
  const router = Router();

  /** GET /api/folders — 폴더 목록 전체 반환. */
  router.get("/", async (_req, res) => {
    try {
      const folders = await sessionDB.listFolders();
      res.json({ folders });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
