import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { NodeCredentialResolver } from "../src/node_credentials/types.js";
import { registerNodeReleaseRoutes } from "../src/node_releases/node_release_routes.js";

const SERVICE_TOKEN = "service-token";
const NODE_TOKEN = "node-token";
const SOURCE_COMMIT = "a".repeat(40);
const UNKNOWN_COMMIT = "b".repeat(40);
const RELEASE_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
const SHA256_HEX = "c".repeat(64);
const CURRENT_PATH = "/api/node/releases/current";
const DOWNLOAD_PATH = `/api/node/releases/${SOURCE_COMMIT}`;

const nodeCredentials: NodeCredentialResolver = {
  resolve: (token) =>
    token === NODE_TOKEN
      ? { credential_id: "credential-a", node_id: "node-a", company_pc: false }
      : null,
  onRevoked: () => () => undefined,
};

type HarnessOptions = {
  readonly releasesDir?: string | null;
  readonly currentSourceCommit?: string;
};

const apps: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeReleasesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "node-releases-"));
  tempDirs.push(dir);
  return dir;
}

async function writeRelease(releasesDir: string, sourceCommit: string): Promise<void> {
  const releaseDir = join(releasesDir, sourceCommit);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, "node.tar.gz"), RELEASE_BYTES);
  await writeFile(
    join(releaseDir, "node.tar.gz.sha256"),
    `${SHA256_HEX}  node.tar.gz\n`,
  );
}

function harness(releasesDir: string | null, currentSourceCommit = SOURCE_COMMIT) {
  const app = Fastify({ logger: false });
  registerNodeReleaseRoutes(app, {
    authBearerToken: SERVICE_TOKEN,
    environment: "production",
    nodeCredentials,
    releasesDir,
    currentSourceCommit,
  });
  apps.push(app);
  return app;
}

function nodeHeaders() {
  return { authorization: `Bearer ${NODE_TOKEN}` };
}

describe("node release routes", () => {
  it("serves the current release metadata with the serving commit and sha256 format", async () => {
    const releasesDir = await makeReleasesDir();
    await writeRelease(releasesDir, SOURCE_COMMIT);
    const app = harness(releasesDir);

    const response = await app.inject({
      method: "GET",
      url: CURRENT_PATH,
      headers: nodeHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      contract_version: 1,
      source_commit: SOURCE_COMMIT,
      size: RELEASE_BYTES.byteLength,
      download_path: DOWNLOAD_PATH,
    });
    expect(body.sha256).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(body.sha256).toBe(`sha256-${SHA256_HEX}`);
  });

  it("returns NOT_READY when the serving commit has no release files", async () => {
    const releasesDir = await makeReleasesDir();
    await writeRelease(releasesDir, UNKNOWN_COMMIT);
    const app = harness(releasesDir);

    const response = await app.inject({
      method: "GET",
      url: CURRENT_PATH,
      headers: nodeHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "PORTABLE_RELEASE_NOT_READY" });
  });

  it("returns DISABLED on both routes when the releases directory is not configured", async () => {
    const app = harness(null);

    for (const url of [CURRENT_PATH, DOWNLOAD_PATH]) {
      const response = await app.inject({ method: "GET", url, headers: nodeHeaders() });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "PORTABLE_RELEASES_DISABLED" });
    }
  });

  it("downloads the release bytes with content length and no-store caching", async () => {
    const releasesDir = await makeReleasesDir();
    await writeRelease(releasesDir, SOURCE_COMMIT);
    const app = harness(releasesDir);

    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD_PATH,
      headers: nodeHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/gzip");
    expect(response.headers["content-length"]).toBe(String(RELEASE_BYTES.byteLength));
    expect(response.headers["cache-control"]).toBe("no-store");
    expect([...response.rawPayload]).toEqual([...RELEASE_BYTES]);
  });

  it("rejects a malformed source commit with 400", async () => {
    const releasesDir = await makeReleasesDir();
    const app = harness(releasesDir);

    const response = await app.inject({
      method: "GET",
      url: "/api/node/releases/not-a-commit",
      headers: nodeHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for an unknown source commit", async () => {
    const releasesDir = await makeReleasesDir();
    const app = harness(releasesDir);

    const response = await app.inject({
      method: "GET",
      url: `/api/node/releases/${UNKNOWN_COMMIT}`,
      headers: nodeHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects the shared service bearer without a node credential", async () => {
    const releasesDir = await makeReleasesDir();
    await writeRelease(releasesDir, SOURCE_COMMIT);
    const app = harness(releasesDir);

    for (const url of [CURRENT_PATH, DOWNLOAD_PATH]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "NODE_CREDENTIAL_REQUIRED" });
    }
  });

  it("rejects missing and invalid bearer tokens with 401", async () => {
    const releasesDir = await makeReleasesDir();
    const app = harness(releasesDir);

    const missing = await app.inject({ method: "GET", url: CURRENT_PATH });
    expect(missing.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "GET",
      url: CURRENT_PATH,
      headers: { authorization: "Bearer not-a-known-token" },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("accepts a node credential and serves the release", async () => {
    const releasesDir = await makeReleasesDir();
    await writeRelease(releasesDir, SOURCE_COMMIT);
    const app = harness(releasesDir);

    const response = await app.inject({
      method: "GET",
      url: CURRENT_PATH,
      headers: nodeHeaders(),
    });

    expect(response.statusCode).toBe(200);
  });
});
