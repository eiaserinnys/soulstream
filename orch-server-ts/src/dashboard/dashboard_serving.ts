import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ifNoneMatchHit } from "../http/conditional_cache.js";

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
  const warn = options.warn ?? ((message: string) => app.log.warn(message));
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
  const iosComponentsIndex = resolve(assetsRoot, "ios-components", "index.html");
  if (await isDirectory(assetsRoot)) {
    app.get("/assets/*", async (request, reply) => {
      const filePath = safeFilePath(assetsRoot, wildcardPath(request));
      if (filePath === undefined || !(await isFile(filePath))) {
        return sendNotFound(reply);
      }
      return sendFile(reply, filePath, filePath === iosComponentsIndex
        ? DASHBOARD_INDEX_CACHE_CONTROL
        : DASHBOARD_ASSET_CACHE_CONTROL);
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const requestPath = requestPathname(request);
    if (
      requestPath === undefined ||
      !isDashboardFallbackRequest(request.method, requestPath)
    ) {
      return sendNotFound(reply);
    }

    const rootFile = safeFilePath(dashboardRoot, requestPath.replace(/^\/+/, ""));
    if (rootFile !== undefined && await isFile(rootFile)) {
      const cacheControl = dashboardRootCacheControl(rootFile, indexPath);
      if (cacheControl === undefined) return sendRevalidatedFile(request, reply, rootFile);
      return sendFile(reply, rootFile, cacheControl);
    }
    return sendFile(reply, indexPath, DASHBOARD_INDEX_CACHE_CONTROL);
  });
  return true;
}

export function isDashboardFallbackRequest(method: string, pathname: string): boolean {
  return method === "GET" && !isReservedPath(pathname);
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

/** 해시 없는 정적 파일(/characters/... 등)은 크기와 mtime으로 매번 검증한다. */
async function sendRevalidatedFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
): Promise<FastifyReply> {
  const info = await stat(filePath);
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const lastModified = info.mtime.toUTCString();
  reply.header("etag", etag).header("last-modified", lastModified);
  const since = request.headers["if-modified-since"];
  const notModified = request.headers["if-none-match"] !== undefined
    ? ifNoneMatchHit(request.headers["if-none-match"], etag)
    : typeof since === "string" && Date.parse(since) >= Math.floor(info.mtimeMs / 1000) * 1000;
  if (notModified) return reply.header("cache-control", "public, no-cache").code(304).send();
  return sendFile(reply, filePath, "public, no-cache");
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
  return ["/api/", "/ws/", "/assets/", "/.well-known/"].some((prefix) =>
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
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};
