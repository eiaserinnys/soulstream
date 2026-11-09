import type { FastifyInstance } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { NodeCredentialResolver } from "../node_credentials/types.js";
import type { PortableConfigService } from "./portable_config_service.js";
import { sendPortableConfigError } from "./portable_route_errors.js";

export type NodeBootstrapRouteOptions = {
  readonly service: PortableConfigService;
  readonly authBearerToken: string;
  readonly environment: string;
  readonly nodeCredentials: NodeCredentialResolver | null;
};

export const nodeBootstrapRouteAuthRequirements = {
  "POST /api/node/bootstrap": true,
} as const;

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

export function registerNodeBootstrapRoutes(
  app: FastifyInstance,
  options: NodeBootstrapRouteOptions,
): void {
  app.post("/api/node/bootstrap", async (request, reply) => {
    const authorization = verifyServiceBearerAuthorization(request.headers.authorization, {
      configuredToken: options.authBearerToken,
      environment: options.environment,
      nodeCredentials: options.nodeCredentials,
    });
    if (!authorization.ok) {
      return reply.code(authorization.statusCode).send({
        code: authorization.statusCode === 503
          ? "NODE_BOOTSTRAP_AUTH_UNAVAILABLE"
          : "NODE_BOOTSTRAP_UNAUTHORIZED",
        detail: "노드 bootstrap에는 노드 자격이 필요합니다.",
      });
    }
    const principal = authorization.principal;
    if (principal === undefined) {
      return reply.code(403).send({ code: "NODE_CREDENTIAL_REQUIRED" });
    }
    const body = isRecord(request.body) ? request.body : {};
    const sourceCommit = body.source_commit;
    const platform = body.platform;
    const arch = body.arch;
    if (
      typeof sourceCommit !== "string"
      || sourceCommit.length === 0
      || typeof platform !== "string"
      || !SUPPORTED_PLATFORMS.has(platform)
      || typeof arch !== "string"
      || !SUPPORTED_ARCHES.has(arch)
    ) {
      return reply.code(400).send({ code: "INVALID_BOOTSTRAP_REQUEST" });
    }
    if (sourceCommit !== options.service.servingSourceCommit) {
      return reply.code(409).send({ code: "RELEASE_VERSION_MISMATCH" });
    }
    try {
      const result = await options.service.transform(principal.company_pc);
      const response = result.response;
      request.log.info({
        credential_id: principal.credential_id,
        node_id: principal.node_id,
        company_pc: principal.company_pc,
        config_generation: response.config_generation,
        preset_count: response.model_catalog.presets.length,
        agent_count: response.agents.agents.length,
        mcp_server_count: response.mcp_registry.servers.length,
        mcp_profile_count: response.mcp_profiles.profiles.length,
        env_keys: Object.keys(response.env),
      }, "node bootstrap config served");
      return reply.header("Cache-Control", "no-store").send(response);
    } catch (error) {
      return sendPortableConfigError(request, reply, error);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
