/**
 * Catalog Proxy Routes - Soul Server의 카탈로그 API를 프록시
 *
 * GET    /api/catalog              → Soul GET /catalog
 * POST   /api/catalog/folders      → Soul POST /catalog/folders
 * PUT    /api/catalog/folders/:id  → Soul PUT /catalog/folders/:id
 * DELETE /api/catalog/folders/:id  → Soul DELETE /catalog/folders/:id
 * PUT    /api/catalog/sessions/:id → Soul PUT /catalog/sessions/:id
 * PUT    /api/catalog/sessions/batch → Soul PUT /catalog/sessions/batch
 */

import { Router, type Request, type Response } from "express";

export interface CatalogProxyRouterOptions {
  soulBaseUrl: string;
  authToken?: string;
}

const SOUL_REQUEST_TIMEOUT_MS = 30_000;

export function createCatalogProxyRouter(
  options: CatalogProxyRouterOptions,
): Router {
  const { soulBaseUrl, authToken } = options;
  const router = Router();

  const proxyHeaders = (contentType?: string) => {
    const h: Record<string, string> = {};
    if (authToken) h["Authorization"] = `Bearer ${authToken}`;
    if (contentType) h["Content-Type"] = contentType;
    return h;
  };

  /** Generic proxy for all catalog routes */
  router.all("/*", async (req: Request, res: Response) => {
    const targetPath = req.path === "/" ? "" : req.path;
    const queryString = new URLSearchParams(
      req.query as Record<string, string>,
    ).toString();
    const url = queryString
      ? `${soulBaseUrl}/catalog${targetPath}?${queryString}`
      : `${soulBaseUrl}/catalog${targetPath}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      SOUL_REQUEST_TIMEOUT_MS,
    );

    try {
      const fetchOptions: RequestInit = {
        method: req.method,
        headers: proxyHeaders(
          req.method !== "GET" && req.method !== "DELETE"
            ? "application/json"
            : undefined,
        ),
        signal: controller.signal,
      };

      if (
        req.method !== "GET" &&
        req.method !== "DELETE" &&
        req.method !== "HEAD"
      ) {
        fetchOptions.body = JSON.stringify(req.body);
      }

      const soulResponse = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      const contentType = soulResponse.headers.get("content-type") ?? "";

      if (soulResponse.status === 204) {
        res.status(204).end();
        return;
      }

      if (contentType.includes("application/json")) {
        const data = await soulResponse.json();
        res.status(soulResponse.status).json(data);
      } else {
        const text = await soulResponse.text();
        res.status(soulResponse.status).send(text);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ error: `Catalog proxy error: ${msg}` });
    }
  });

  return router;
}
