import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const DASHBOARD_INDEX_CACHE_CONTROL = "no-cache";
export const DASHBOARD_MUTABLE_ROOT_CACHE_CONTROL = "no-cache";
export const DASHBOARD_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

const DASHBOARD_MUTABLE_ROOT_FILES = new Set([
  "index.html",
  "manifest.webmanifest",
  "registerSW.js",
  "sw-update-migration.js",
  "sw.js",
]);

export type RegisterDashboardServingOptions = {
  readonly dashboardDir: string;
  readonly warn?: (message: string) => void;
};

export async function registerDashboardServing(
  app: FastifyInstance,
  options: RegisterDashboardServingOptions,
): Promise<boolean> {
  const warn = options.warn ?? console.warn;
  if (options.dashboardDir.trim().length === 0) {
    warn("DASHBOARD_DIR is not configured; dashboard static serving is disabled");
    return false;
  }

  const dashboardRoot = resolve(options.dashboardDir);
  const indexPath = resolve(dashboardRoot, "index.html");
  if (!(await isDirectory(dashboardRoot))) {
    warn(`DASHBOARD_DIR does not exist: ${options.dashboardDir}`);
    return false;
  }
  if (!(await isFile(indexPath))) {
    warn(`DASHBOARD_DIR does not contain index.html: ${options.dashboardDir}`);
    return false;
  }

  const assetsRoot = resolve(dashboardRoot, "assets");
  if (await isDirectory(assetsRoot)) {
    app.get("/assets/*", async (request, reply) => {
      const filePath = safeFilePath(assetsRoot, wildcardPath(request));
      if (filePath === undefined || !(await isFile(filePath))) {
        return sendNotFound(reply);
      }
      return sendFile(reply, filePath, DASHBOARD_ASSET_CACHE_CONTROL);
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const requestPath = requestPathname(request);
    if (
      request.method !== "GET" ||
      requestPath === undefined ||
      isReservedPath(requestPath)
    ) {
      return sendNotFound(reply);
    }

    const rootFile = safeFilePath(dashboardRoot, requestPath.replace(/^\/+/, ""));
    if (rootFile !== undefined && await isFile(rootFile)) {
      return sendFile(
        reply,
        rootFile,
        dashboardRootCacheControl(rootFile, indexPath),
      );
    }
    return sendFile(reply, indexPath, DASHBOARD_INDEX_CACHE_CONTROL);
  });
  return true;
}

function dashboardRootCacheControl(
  filePath: string,
  indexPath: string,
): string | undefined {
  return filePath === indexPath || DASHBOARD_MUTABLE_ROOT_FILES.has(basename(filePath))
    ? DASHBOARD_MUTABLE_ROOT_CACHE_CONTROL
    : undefined;
}

async function sendFile(
  reply: FastifyReply,
  filePath: string,
  cacheControl: string | undefined,
): Promise<FastifyReply> {
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()];
  if (contentType !== undefined) reply.type(contentType);
  if (cacheControl !== undefined) reply.header("cache-control", cacheControl);
  return reply.send(createReadStream(filePath));
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ detail: "Not Found" });
}

function wildcardPath(request: FastifyRequest): string {
  const params = request.params as Record<string, unknown>;
  return typeof params["*"] === "string" ? params["*"] : "";
}

function requestPathname(request: FastifyRequest): string | undefined {
  const rawPath = request.url.split("?", 1)[0] ?? "/";
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
}

function isReservedPath(pathname: string): boolean {
  return ["/api/", "/ws/", "/assets/"].some((prefix) =>
    pathname.startsWith(prefix)
  );
}

function safeFilePath(root: string, relativePath: string): string | undefined {
  if (relativePath.includes("\0")) return undefined;
  const candidate = resolve(root, relativePath);
  return candidate === root || candidate.startsWith(`${root}${sep}`)
    ? candidate
    : undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};
