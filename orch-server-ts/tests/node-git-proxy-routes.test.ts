import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeCredentialStore,
  createApp,
  nodeGitProxyRouteAuthRequirements,
  parseOrchServerConfig,
} from "../src/index.js";
import { InMemoryNodeCredentialRepository } from "./node-credentials-test-support.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const UPSTREAM_TOKEN = "upstream-read-token";
const NODE_TOKEN = "node-credential-token-value";

type RecordedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
};

type FakeUpstreamResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
};

type FakeUpstream = {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
};

async function startUpstream(
  respond: (request: RecordedRequest) => FakeUpstreamResponse,
): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk as Buffer)));
    request.on("end", () => {
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      const result = respond(recorded);
      response.writeHead(result.status, { ...result.headers });
      response.end(result.body ?? "");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    }),
  };
}

function basicAuthorization(token: string): string {
  return `Basic ${Buffer.from(`soulstream-node:${token}`, "utf8").toString("base64")}`;
}

async function createHarness(options: {
  githubReadToken?: string | null;
  upstreamBaseUrl?: string;
  nodeToken?: string;
} = {}) {
  const repository = new InMemoryNodeCredentialRepository();
  const store = new NodeCredentialStore({ repository });
  await store.initialize();
  const created = await store.createCredential({ node_id: "portable-test-node", company_pc: false });
  const nodeToken = options.nodeToken ?? created.token;
  const upstream = await startUpstream((request): FakeUpstreamResponse => {
    if (request.url.includes("/info/refs")) {
      return {
        status: 200,
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
          "cache-control": "no-cache",
        },
        body: Buffer.from("001e# service=git-upload-pack\n0000advertisement", "utf8"),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/x-git-upload-pack-result" },
      body: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
    };
  });
  const app = createApp({
    config,
    nodeGitProxyRoutes: {
      nodeCredentials: store,
      githubReadToken: options.githubReadToken === undefined ? UPSTREAM_TOKEN : options.githubReadToken,
      upstreamBaseUrl: options.upstreamBaseUrl ?? upstream.baseUrl,
    },
  });
  return {
    app,
    store,
    repository,
    created,
    nodeToken: options.nodeToken ?? created.token,
    upstream,
    async close() {
      await app.close();
      await upstream.close();
    },
  };
}

describe("node git proxy routes", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  it("does not register the proxy routes on the default app", async () => {
    const app = createApp({ config });
    for (const request of [
      { method: "GET" as const, url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack" },
      { method: "POST" as const, url: "/api/node/git/seosoyoung_workspace/git-upload-pack" },
      { method: "POST" as const, url: "/api/node/git/seosoyoung_workspace/git-receive-pack" },
    ]) {
      expect(await app.inject(request)).toMatchObject({ statusCode: 404 });
    }
    await app.close();
  });

  it("declares the three proxy routes as node-credential routes outside the platform bearer guard", () => {
    expect(nodeGitProxyRouteAuthRequirements).toEqual({
      "GET /api/node/git/{repo}/info/refs": false,
      "POST /api/node/git/{repo}/git-upload-pack": false,
      "POST /api/node/git/{repo}/git-receive-pack": false,
    });
  });

  it("proxies info/refs with the orch token upstream and the node token nowhere", async () => {
    const harness = await createHarness();
    cleanups.push(() => harness.close());

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: {
        authorization: basicAuthorization(harness.nodeToken),
        accept: "application/x-git-upload-pack-advertisement",
        "git-protocol": "version=2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toContain("advertisement");

    expect(harness.upstream.requests).toHaveLength(1);
    const upstreamRequest = harness.upstream.requests[0]!;
    expect(upstreamRequest.method).toBe("GET");
    expect(upstreamRequest.url).toBe("/seosoyoung_workspace.git/info/refs?service=git-upload-pack");
    expect(upstreamRequest.headers.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${UPSTREAM_TOKEN}`, "utf8").toString("base64")}`,
    );
    expect(JSON.stringify(upstreamRequest.headers)).not.toContain(harness.nodeToken);
    expect(upstreamRequest.headers["user-agent"]).toBe("soulstream-node-git-proxy");
    expect(upstreamRequest.headers["git-protocol"]).toBe("version=2");
  });

  it("streams the upload-pack request and response bytes untouched", async () => {
    const harness = await createHarness();
    cleanups.push(() => harness.close());

    const requestBody = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/node/git/seosoyoung_workspace/git-upload-pack",
      headers: {
        authorization: basicAuthorization(harness.nodeToken),
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
        accept: "application/x-git-upload-pack-result",
        "git-protocol": "version=2",
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-result");
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    expect(Buffer.from(response.rawPayload)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

    const upstreamRequest = harness.upstream.requests[0]!;
    expect(upstreamRequest.method).toBe("POST");
    expect(upstreamRequest.url).toBe("/seosoyoung_workspace.git/git-upload-pack");
    expect(upstreamRequest.headers["content-type"]).toBe("application/x-git-upload-pack-request");
    expect(upstreamRequest.headers["content-encoding"]).toBe("gzip");
    expect(upstreamRequest.headers["git-protocol"]).toBe("version=2");
    expect(upstreamRequest.body).toEqual(requestBody);
    expect(upstreamRequest.headers.authorization).not.toContain(harness.nodeToken);
  });

  it("rejects requests without a node credential", async () => {
    const harness = await createHarness();
    cleanups.push(() => harness.close());

    const missing = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe('Basic realm="soulstream-node-git"');

    const wrongUsername = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: {
        authorization: `Basic ${Buffer.from(`someone-else:${harness.nodeToken}`, "utf8").toString("base64")}`,
      },
    });
    expect(wrongUsername.statusCode).toBe(401);

    const bearer = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: { authorization: `Bearer ${harness.nodeToken}` },
    });
    expect(bearer.statusCode).toBe(401);

    const unknownToken = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: { authorization: basicAuthorization("not-an-issued-token") },
    });
    expect(unknownToken.statusCode).toBe(401);
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it("rejects a revoked node credential", async () => {
    const harness = await createHarness();
    cleanups.push(() => harness.close());

    await harness.store.revokeCredential(harness.created.credential.credential_id);

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: { authorization: basicAuthorization(harness.nodeToken) },
    });
    expect(response.statusCode).toBe(401);
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it("blocks writes, non-upload-pack advertisements, and unknown repositories", async () => {
    const harness = await createHarness();
    cleanups.push(() => harness.close());
    const authorization = basicAuthorization(harness.nodeToken);

    const receivePack = await harness.app.inject({
      method: "POST",
      url: "/api/node/git/seosoyoung_workspace/git-receive-pack",
      headers: { authorization, "content-type": "application/x-git-receive-pack-request" },
      payload: Buffer.from("push"),
    });
    expect(receivePack.statusCode).toBe(403);

    const receiveAdvertisement = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-receive-pack",
      headers: { authorization },
    });
    expect(receiveAdvertisement.statusCode).toBe(403);

    const missingService = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs",
      headers: { authorization },
    });
    expect(missingService.statusCode).toBe(403);

    const unknownRepo = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/some-other-repo/info/refs?service=git-upload-pack",
      headers: { authorization },
    });
    expect(unknownRepo.statusCode).toBe(404);

    const unknownRepoWrite = await harness.app.inject({
      method: "POST",
      url: "/api/node/git/some-other-repo/git-receive-pack",
      headers: { authorization, "content-type": "application/x-git-receive-pack-request" },
      payload: Buffer.from("push"),
    });
    expect(unknownRepoWrite.statusCode).toBe(404);

    expect(harness.upstream.requests).toHaveLength(0);
  });

  it("allows the common repository key", async () => {
    const harness = await createHarness();
    cleanups.push(() => harness.close());

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung-common/info/refs?service=git-upload-pack",
      headers: { authorization: basicAuthorization(harness.nodeToken) },
    });
    expect(response.statusCode).toBe(200);
    expect(harness.upstream.requests[0]?.url).toBe("/seosoyoung-common.git/info/refs?service=git-upload-pack");
  });

  it("serves 503 when the orchestrator has no upstream read token", async () => {
    const harness = await createHarness({ githubReadToken: null });
    cleanups.push(() => harness.close());

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: { authorization: basicAuthorization(harness.nodeToken) },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "PORTABLE_NODE_GIT_DISABLED" });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it("maps upstream rejections to 502 without echoing the upstream body", async () => {
    const upstream = await startUpstream(() => ({
      status: 401,
      headers: { "content-type": "text/plain", "www-authenticate": "Basic realm=\"github\"" },
      body: "upstream-secret-body",
    }));
    const repository = new InMemoryNodeCredentialRepository();
    const store = new NodeCredentialStore({ repository });
    await store.initialize();
    const created = await store.createCredential({ node_id: "portable-test-node", company_pc: false });
    const app = createApp({
      config,
      nodeGitProxyRoutes: {
        nodeCredentials: store,
        githubReadToken: UPSTREAM_TOKEN,
        upstreamBaseUrl: upstream.baseUrl,
      },
    });
    cleanups.push(async () => {
      await app.close();
      await upstream.close();
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: { authorization: basicAuthorization(created.token) },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "UPSTREAM_REJECTED", status: 401 });
    expect(response.body).not.toContain("upstream-secret-body");
  });

  it("maps an unreachable upstream to 502", async () => {
    const harness = await createHarness({ upstreamBaseUrl: "http://127.0.0.1:1" });
    cleanups.push(() => harness.close());

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/node/git/seosoyoung_workspace/info/refs?service=git-upload-pack",
      headers: { authorization: basicAuthorization(harness.nodeToken) },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "UPSTREAM_UNAVAILABLE" });
  });
});
