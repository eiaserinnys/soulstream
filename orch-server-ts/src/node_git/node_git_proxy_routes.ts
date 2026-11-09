import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  NodeCredentialResolver,
  NodePrincipal,
} from "../node_credentials/types.js";

const ALLOWED_REPOSITORY_KEYS = new Set<string>([
  "seosoyoung_workspace",
  "seosoyoung-common",
]);
const DEFAULT_UPSTREAM_BASE_URL = "https://github.com/eiaserinnys";
const NODE_GIT_USERNAME = "soulstream-node";
const UPSTREAM_USER_AGENT = "soulstream-node-git-proxy";
const UPSTREAM_REQUEST_TIMEOUT_MS = 3_600_000;
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "git-protocol",
  "content-encoding",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "expires",
  "pragma",
] as const;
const GIT_REQUEST_CONTENT_TYPES = [
  "application/x-git-upload-pack-request",
  "application/x-git-receive-pack-request",
];

export type NodeGitProxyRouteOptions = {
  readonly nodeCredentials: NodeCredentialResolver;
  readonly githubReadToken: string | null;
  /** Test-only override; production always reads from the fixed GitHub origin. */
  readonly upstreamBaseUrl?: string;
};

// Git clients authenticate here with the node credential itself (HTTP Basic
// username "soulstream-node"), so these routes sit outside the platform bearer
// guard and the handler is the only authority check.
export const nodeGitProxyRouteAuthRequirements = {
  "GET /api/node/git/{repo}/info/refs": false,
  "POST /api/node/git/{repo}/git-upload-pack": false,
  "POST /api/node/git/{repo}/git-receive-pack": false,
} as const;

export function registerNodeGitProxyRoutes(
  app: FastifyInstance,
  options: NodeGitProxyRouteOptions,
): void {
  const upstreamBaseUrl = (
    options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL
  ).replace(/\/+$/, "");
  const githubReadToken =
    options.githubReadToken !== null && options.githubReadToken.length > 0
      ? options.githubReadToken
      : null;
  const context: ProxyContext = {
    nodeCredentials: options.nodeCredentials,
    githubReadToken,
    upstreamBaseUrl,
  };

  void app.register(async (instance) => {
    // Git sends the smart HTTP body uncompressed or gzip-compressed and expects
    // it relayed byte for byte; buffering would break streaming and memory use.
    instance.addContentTypeParser(
      GIT_REQUEST_CONTENT_TYPES,
      (_request, payload, done) => {
        done(null, payload);
      },
    );

    instance.get("/api/node/git/:repo/info/refs", async (request, reply) => {
      return await handleInfoRefs(request, reply, context);
    });

    instance.post("/api/node/git/:repo/git-upload-pack", async (request, reply) => {
      return await handleUploadPack(request, reply, context);
    });

    instance.post("/api/node/git/:repo/git-receive-pack", async (request, reply) => {
      const repo = readRepositoryKey(request);
      if (repo === null) {
        return sendProxyError(reply, 404, { error: "UNKNOWN_REPOSITORY" });
      }
      logProxyResult(request, { repo, service: "git-receive-pack" }, "rejected_write");
      return sendProxyError(reply, 403, { error: "READ_ONLY_PROXY" });
    });
  });
}

type ProxyContext = {
  readonly nodeCredentials: NodeCredentialResolver;
  readonly githubReadToken: string | null;
  readonly upstreamBaseUrl: string;
};

async function handleInfoRefs(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ProxyContext,
): Promise<FastifyReply> {
  const repo = readRepositoryKey(request);
  if (repo === null) {
    return sendProxyError(reply, 404, { error: "UNKNOWN_REPOSITORY" });
  }
  const service = readUploadPackService(request);
  if (service === null) {
    logProxyResult(request, { repo, service: "git-receive-pack" }, "rejected_write");
    return sendProxyError(reply, 403, { error: "READ_ONLY_PROXY" });
  }
  if (context.githubReadToken === null) {
    logProxyResult(request, { repo, service }, "disabled");
    return sendProxyError(reply, 503, { error: "PORTABLE_NODE_GIT_DISABLED" });
  }
  const principal = resolveNodePrincipal(request, context.nodeCredentials);
  if (principal === null) {
    logProxyResult(request, { repo, service }, "unauthorized");
    return sendProxyError(reply, 401, { error: "NODE_CREDENTIAL_REQUIRED" });
  }
  return await forwardUpstream(request, reply, context, {
    repo,
    service,
    principal,
    upstreamPath: `${repo}.git/info/refs?service=git-upload-pack`,
    hasBody: false,
  });
}

async function handleUploadPack(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ProxyContext,
): Promise<FastifyReply> {
  const repo = readRepositoryKey(request);
  if (repo === null) {
    return sendProxyError(reply, 404, { error: "UNKNOWN_REPOSITORY" });
  }
  const service = "git-upload-pack";
  if (context.githubReadToken === null) {
    logProxyResult(request, { repo, service }, "disabled");
    return sendProxyError(reply, 503, { error: "PORTABLE_NODE_GIT_DISABLED" });
  }
  const principal = resolveNodePrincipal(request, context.nodeCredentials);
  if (principal === null) {
    logProxyResult(request, { repo, service }, "unauthorized");
    return sendProxyError(reply, 401, { error: "NODE_CREDENTIAL_REQUIRED" });
  }
  return await forwardUpstream(request, reply, context, {
    repo,
    service,
    principal,
    upstreamPath: `${repo}.git/git-upload-pack`,
    hasBody: true,
  });
}

type ForwardInput = {
  readonly repo: string;
  readonly service: string;
  readonly principal: NodePrincipal;
  readonly upstreamPath: string;
  readonly hasBody: boolean;
};

async function forwardUpstream(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ProxyContext,
  input: ForwardInput,
): Promise<FastifyReply> {
  const githubReadToken = context.githubReadToken;
  if (githubReadToken === null) {
    return sendProxyError(reply, 503, { error: "PORTABLE_NODE_GIT_DISABLED" });
  }
  const clientAbort = bindClientAbort(request, reply);
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(
      `x-access-token:${githubReadToken}`,
      "utf8",
    ).toString("base64")}`,
    "user-agent": UPSTREAM_USER_AGENT,
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length > 0) {
      headers[name] = value;
    }
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.any([
      clientAbort.abort.signal,
      AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
    ]),
  };
  if (input.hasBody) {
    init.body = request.body as NonNullable<RequestInit["body"]>;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${context.upstreamBaseUrl}/${input.upstreamPath}`, init);
  } catch {
    clientAbort.cleanup();
    logProxyResult(request, input, "upstream_unavailable", input.principal);
    return sendProxyError(reply, 502, { error: "UPSTREAM_UNAVAILABLE" });
  }

  if (upstream.status < 200 || upstream.status >= 300) {
    await cancelUpstreamBody(upstream);
    clientAbort.cleanup();
    logProxyResult(request, input, "upstream_rejected", input.principal);
    return sendProxyError(reply, 502, {
      error: "UPSTREAM_REJECTED",
      status: upstream.status,
    });
  }

  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      reply.header(name, value);
    }
  }
  reply.code(upstream.status);

  if (upstream.body === null) {
    clientAbort.cleanup();
    logProxyResult(request, input, "ok", input.principal);
    return reply.send();
  }

  const stream = Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>);
  stream.once("error", () => {
    request.log.warn(
      {
        repo: input.repo,
        service: input.service,
        result: "stream_failed",
        credential_id: input.principal.credential_id,
      },
      "node git proxy stream failed",
    );
    clientAbort.cleanup();
  });
  stream.once("close", clientAbort.cleanup);
  stream.once("end", clientAbort.cleanup);
  logProxyResult(request, input, "ok", input.principal);
  return reply.send(stream);
}

async function cancelUpstreamBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The upstream connection is already failing; nothing left to cancel.
  }
}

function readRepositoryKey(request: FastifyRequest): string | null {
  const params = request.params as { repo?: unknown };
  const repo = params.repo;
  if (typeof repo !== "string" || !ALLOWED_REPOSITORY_KEYS.has(repo)) {
    return null;
  }
  return repo;
}

function readUploadPackService(request: FastifyRequest): string | null {
  const query = request.query as { service?: unknown };
  return query.service === "git-upload-pack" ? "git-upload-pack" : null;
}

function resolveNodePrincipal(
  request: FastifyRequest,
  nodeCredentials: NodeCredentialResolver,
): NodePrincipal | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (match === null) {
    return null;
  }
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (username !== NODE_GIT_USERNAME || password.length === 0) {
    return null;
  }
  return nodeCredentials.resolve(password);
}

function bindClientAbort(
  request: FastifyRequest,
  reply: FastifyReply,
): { readonly abort: AbortController; readonly cleanup: () => void } {
  const abort = new AbortController();
  const onAborted = () => abort.abort();
  const onClose = () => {
    if (!reply.raw.writableFinished) abort.abort();
  };
  request.raw.once("aborted", onAborted);
  reply.raw.once("close", onClose);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.raw.off("aborted", onAborted);
    reply.raw.off("close", onClose);
  };
  return { abort, cleanup };
}

function sendProxyError(
  reply: FastifyReply,
  statusCode: number,
  payload: Record<string, unknown>,
): FastifyReply {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    reply.hijack();
    return reply;
  }
  if (statusCode === 401) {
    reply.header("WWW-Authenticate", 'Basic realm="soulstream-node-git"');
  }
  return reply.code(statusCode).send(payload);
}

function logProxyResult(
  request: FastifyRequest,
  input: { readonly repo: string; readonly service: string },
  result: string,
  principal?: NodePrincipal,
): void {
  request.log.info(
    {
      repo: input.repo,
      service: input.service,
      result,
      ...(principal === undefined ? {} : { credential_id: principal.credential_id }),
    },
    "node git proxy request",
  );
}
