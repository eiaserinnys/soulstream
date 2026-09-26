import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthTokenResolver } from "../auth/auth_routes.js";
import { normalizeRouteKey } from "../contract/route_coverage.js";
import { routeCoverageOwners } from "../contract/route_coverage_matrix.js";
import { classifyRouteFamily, isLowRiskRouteEntry } from "../contract/route_registry.js";
import { isDashboardFallbackRequest } from "../dashboard/dashboard_serving.js";
import { requestLogPath } from "./production_logging.js";

export type ProductionAuthGuardOptions = {
  readonly resolveTokenAccess: AuthTokenResolver;
};

export type ProductionRouteAuthIdentity = {
  readonly method: string;
  readonly routeUrl?: string;
  readonly websocket?: boolean;
};

const routeAuthRequirementIndex = buildRouteAuthRequirementIndex();

export function registerProductionAuthGuard(
  app: FastifyInstance,
  options: ProductionAuthGuardOptions,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const routeUrl = request.routeOptions.url;
    const requestPath = request.url.split("?", 1)[0] ?? "/";
    if (
      routeUrl === undefined &&
      isDashboardFallbackRequest(request.method, requestPath)
    ) {
      return;
    }
    if (
      routeUrl !== undefined &&
      isLowRiskRouteEntry({ family: classifyRouteFamily(routeUrl) })
    ) {
      return;
    }
    const authRequired = resolveProductionRouteAuthRequirement(
      requestRouteIdentity(request),
    );
    if (authRequired === false) return;

    const access = await options.resolveTokenAccess(request);
    if (!access.ok) {
      const statusCode = access.statusCode ?? 401;
      request.log.warn({
        method: request.method,
        path: requestLogPath(request),
        statusCode,
      }, "HTTP authentication rejected");
      return reply.code(statusCode).send({ detail: access.detail });
    }
  });
}

export function resolveProductionRouteAuthRequirement(
  identity: ProductionRouteAuthIdentity,
): boolean | undefined {
  if (identity.routeUrl === undefined) return undefined;
  const method = identity.websocket === true ? "WEBSOCKET" : identity.method;
  const requirement = routeAuthRequirementIndex.get(
    normalizeRouteKey(`${method} ${identity.routeUrl}`),
  );
  if (requirement !== undefined || method.toUpperCase() !== "HEAD") {
    return requirement;
  }
  return routeAuthRequirementIndex.get(
    normalizeRouteKey(`GET ${identity.routeUrl}`),
  );
}

function requestRouteIdentity(
  request: FastifyRequest,
): ProductionRouteAuthIdentity {
  return {
    method: request.method,
    routeUrl: request.routeOptions.url,
    websocket: singleHeader(request.headers.upgrade)?.toLowerCase() === "websocket",
  };
}

function buildRouteAuthRequirementIndex(): ReadonlyMap<string, boolean> {
  const index = new Map<string, boolean>();
  for (const owner of routeCoverageOwners) {
    for (const [rawKey, authRequired] of Object.entries(owner.authRequirements)) {
      const key = normalizeRouteKey(rawKey);
      if (index.has(key)) {
        throw new Error(`duplicate route auth requirement: ${key}`);
      }
      index.set(key, authRequired);
    }
  }
  return index;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
