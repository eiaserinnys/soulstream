/**
 * 폴더 API — CRUD.
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

  /** POST /api/folders — 폴더 생성. */
  router.post("/", async (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name || typeof name !== "string" || name.trim() === "") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const folder = await sessionDB.createFolder(name.trim());
      res.status(201).json(folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  /** PUT /api/folders/:id — 폴더 이름 변경. */
  router.put("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name } = req.body as { name?: string };
      if (!name || typeof name !== "string" || name.trim() === "") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const folder = await sessionDB.updateFolder(id, name.trim());
      if (!folder) {
        res.status(404).json({ error: "folder_not_found" });
        return;
      }
      res.json(folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  /** DELETE /api/folders/:id — 폴더 삭제. */
  router.delete("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await sessionDB.deleteFolder(id);
      res.status(204).end();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
