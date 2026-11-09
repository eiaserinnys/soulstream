import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { NodeCredentialResolver } from "../node_credentials/types.js";

export type NodeReleaseRouteOptions = {
  readonly authBearerToken: string;
  readonly environment: string;
  readonly nodeCredentials: NodeCredentialResolver | null;
  /**
   * Root that stores `<source_commit>/node.tar.gz` and
   * `<source_commit>/node.tar.gz.sha256`. `null` disables release delivery.
   */
  readonly releasesDir: string | null;
  /** Commit this orchestrator serves; the health build_id has the same source. */
  readonly currentSourceCommit: string;
};

export const nodeReleaseRouteAuthRequirements = {
  "GET /api/node/releases/current": true,
  "GET /api/node/releases/:source_commit": true,
} as const;

const CURRENT_PATH = "/api/node/releases/current";
const DOWNLOAD_PATH = "/api/node/releases/:source_commit";
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

type DownloadParams = { readonly source_commit: string };

export function registerNodeReleaseRoutes(
  app: FastifyInstance,
  options: NodeReleaseRouteOptions,
): void {
  void app.register(async (instance) => {
    instance.addHook("onRequest", async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        {
          configuredToken: options.authBearerToken,
          environment: options.environment,
          nodeCredentials: options.nodeCredentials,
        },
      );
      if (!authorization.ok) {
        return reply.code(authorization.statusCode).send({
          code: authorization.statusCode === 503
            ? "NODE_RELEASE_AUTH_UNAVAILABLE"
            : "NODE_RELEASE_UNAUTHORIZED",
        });
      }
      if (authorization.principal === undefined) {
        return reply.code(403).send({ code: "NODE_CREDENTIAL_REQUIRED" });
      }
    });

    instance.get(CURRENT_PATH, async (_request, reply) => {
      const releasesDir = configuredReleasesDir(options);
      if (releasesDir === null) {
        return disabled(reply);
      }

      const sourceCommit = options.currentSourceCommit;
      const releaseDir = join(releasesDir, sourceCommit);
      let size: number;
      let sha256Hex: string;
      try {
        size = (await stat(join(releaseDir, "node.tar.gz"))).size;
        sha256Hex = parseSha256File(
          await readFile(join(releaseDir, "node.tar.gz.sha256"), "utf8"),
        );
      } catch (error) {
        if (isMissingFile(error)) return notReady(reply);
        throw error;
      }
      if (sha256Hex.length === 0) return notReady(reply);

      return reply.code(200).send({
        contract_version: 1,
        source_commit: sourceCommit,
        sha256: `sha256-${sha256Hex}`,
        size,
        download_path: `/api/node/releases/${sourceCommit}`,
      });
    });

    instance.get<{ Params: DownloadParams }>(DOWNLOAD_PATH, async (request, reply) => {
      const releasesDir = configuredReleasesDir(options);
      if (releasesDir === null) {
        return disabled(reply);
      }

      const sourceCommit = request.params.source_commit;
      if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
        return reply.code(400).send({ code: "INVALID_SOURCE_COMMIT" });
      }

      const filePath = join(releasesDir, sourceCommit, "node.tar.gz");
      let size: number;
      try {
        size = (await stat(filePath)).size;
      } catch (error) {
        if (isMissingFile(error)) {
          return reply.code(404).send({ code: "RELEASE_NOT_FOUND" });
        }
        throw error;
      }

      return reply
        .code(200)
        .header("content-type", "application/gzip")
        .header("content-length", String(size))
        .header("cache-control", "no-store")
        .send(createReadStream(filePath));
    });
  });
}

function configuredReleasesDir(options: NodeReleaseRouteOptions): string | null {
  const releasesDir = options.releasesDir;
  if (releasesDir === null || releasesDir.trim().length === 0) return null;
  return releasesDir;
}

/** The packer writes one line: `<64 hex>  node.tar.gz`. */
function parseSha256File(source: string): string {
  const token = source.trim().split(/\s+/)[0] ?? "";
  return SHA256_HEX_PATTERN.test(token) ? token : "";
}

function disabled(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ code: "PORTABLE_RELEASES_DISABLED" });
}

function notReady(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ code: "PORTABLE_RELEASE_NOT_READY" });
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
