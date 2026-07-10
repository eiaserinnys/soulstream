import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthTokenResolver } from "../auth/auth_routes.js";
import { normalizeRouteKey } from "../contract/route_coverage.js";
import { routeCoverageOwners } from "../contract/route_coverage_matrix.js";

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
    const authRequired = resolveProductionRouteAuthRequirement(
      requestRouteIdentity(request),
    );
    if (authRequired !== true) return;

    const access = await options.resolveTokenAccess(request);
    if (!access.ok) {
      return reply.code(access.statusCode ?? 401).send({ detail: access.detail });
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
