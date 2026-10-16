import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { createServer as createViteServer } from "vite";

const artifactDirectory = path.resolve("../../../.local/artifacts/20261017-b2-16-attachment-chat");
const tracePath = path.join(artifactDirectory, "download-http-trace.ndjson");
mkdirSync(artifactDirectory, { recursive: true });
writeFileSync(tracePath, "");

const legacyBytes = Buffer.from("Legacy note 1234567\n", "utf8");
const largeTextBytes = Buffer.concat([
  Buffer.alloc(1_048_576, 65),
  Buffer.from("TAIL-END!!"),
]);

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function traceRequest(request, status, responseHeaders, responseBytes, requestStartedAt) {
  appendFileSync(tracePath, JSON.stringify({
    method: request.method,
    url: request.url,
    requestStartedAt,
    responseCompletedAt: Date.now(),
    requestHeaders: {
      cookiePresent: request.headers.cookie !== undefined,
      authorizationPresent: request.headers.authorization !== undefined,
      range: request.headers.range ?? null,
    },
    status,
    responseHeaders,
    responseBytes,
  }) + "\n");
}

function sendAttachment(request, response, input, requestStartedAt) {
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(input.filename),
    "content-length": String(input.bytes.byteLength),
    "content-type": input.contentType,
    "vary": "Cookie, Authorization",
    "x-content-type-options": "nosniff",
  };
  const status = 200;
  response.writeHead(status, headers);
  response.end(request.method === "HEAD" ? undefined : input.bytes, () => {
    traceRequest(request, status, headers, request.method === "HEAD" ? 0 : input.bytes.byteLength, requestStartedAt);
  });
}

const attachmentServer = createHttpServer((request, response) => {
  const requestStartedAt = Date.now();
  const url = new URL(request.url ?? "/", "http://attachment-fixture.local");
  if (url.pathname === "/api/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, ready: true, draining: false, build_id: "dev" }));
    return;
  }
  if (url.pathname === "/api/attachments/files"
      && url.searchParams.get("path") === "/incoming/참고.txt"
      && url.searchParams.get("download") === "true") {
    sendAttachment(request, response, {
      bytes: legacyBytes,
      contentType: "text/plain",
      filename: "참고.txt",
    }, requestStartedAt);
    return;
  }

  const assetMatch = /^\/api\/attachments\/([^/]+)\/content$/.exec(url.pathname);
  if (assetMatch?.[1] === "review-large-text" && url.searchParams.get("download") === "true") {
    sendAttachment(request, response, {
      bytes: largeTextBytes,
      contentType: "text/plain",
      filename: "큰_텍스트.txt",
    }, requestStartedAt);
    return;
  }

  const headers = { "content-length": "0", "content-type": "text/plain" };
  response.writeHead(404, headers);
  response.end(() => traceRequest(request, 404, headers, 0, requestStartedAt));
});

await new Promise((resolve, reject) => {
  attachmentServer.once("error", reject);
  attachmentServer.listen(0, "127.0.0.1", resolve);
});
const address = attachmentServer.address();
if (address === null || typeof address === "string") throw new Error("Attachment fixture server did not bind a TCP port");
process.env.VITE_API_BASE = `http://127.0.0.1:${address.port}`;

const vite = await createViteServer({
  configFile: path.resolve("vite.config.ts"),
  server: { host: "127.0.0.1", port: 4199, strictPort: true },
});
await vite.listen();

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await vite.close();
  await new Promise(resolve => attachmentServer.close(() => resolve()));
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
