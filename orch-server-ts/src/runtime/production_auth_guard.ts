import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthTokenResolver } from "../auth/auth_routes.js";
import { extractBearerToken } from "../auth/service_bearer.js";
import { normalizeRouteKey } from "../contract/route_coverage.js";
import { routeCoverageOwners } from "../contract/route_coverage_matrix.js";
import { classifyRouteFamily, isLowRiskRouteEntry } from "../contract/route_registry.js";
import { isDashboardFallbackRequest } from "../dashboard/dashboard_serving.js";
import type { NodeCredentialResolver, NodePrincipal } from "../node_credentials/types.js";
import { oauthScopeForRoute, requireOAuthScope, type OAuthResourceAccess } from "../oauth/oauth_access.js";
import { isExternalAccessRequestPath } from "../external_access/external_access_paths.js";
import { isNodeCredentialRouteAllowed } from "./node_credential_route_allowlist.js";
import { requestLogPath, setAuthenticatedLogNodeId } from "./production_logging.js";

export type ProductionAuthGuardOptions = {
  readonly resolveTokenAccess: AuthTokenResolver;
  readonly resolveOAuthAccess?: (request: FastifyRequest) => Promise<OAuthResourceAccess | null>;
  /** This dedicated route authenticates its own credential and Host. */
  readonly externalMcpPath?: string;
  /**
   * Node pairing credentials. Their principal decides whether the route is on
   * the portable-node allowlist; `null` is explicit outside production
   * composition.
   */
  readonly nodeCredentials?: NodeCredentialResolver | null;
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
    if (options.externalMcpPath !== undefined && routeUrl === options.externalMcpPath) return;
    const requestPath = request.url.split("?", 1)[0] ?? "/";
    if (isExternalAccessRequestPath(requestPath)) {
      // The public link surface sets these for matched routes; the guard sets
      // them too so its own 401 and the dashboard fallback never leave `/x`
      // without them.
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
    }
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
    // A node pairing credential is narrower than the shared service token. This
    // runs before the auth matrix short-circuit so routes that authenticate
    // inline (card orchestration, MCP host, attachments, host transports) are
    // covered too.
    const nodePrincipal = resolveNodeCredentialPrincipal(request, options);
    if (nodePrincipal !== null) setAuthenticatedLogNodeId(request, nodePrincipal.node_id);
    if (
      nodePrincipal !== null &&
      !isNodeCredentialRouteAllowed(requestRouteIdentity(request))
    ) {
      request.log.warn({
        method: request.method,
        route: routeUrl,
        nodeId: nodePrincipal.node_id,
      }, "node credential route denied");
      return reply.code(403).send({ code: "NODE_CREDENTIAL_ROUTE_DENIED" });
    }
    const authRequired = resolveProductionRouteAuthRequirement(
      requestRouteIdentity(request),
    );
    if (authRequired === false) return;

    const access = await options.resolveTokenAccess(request);
    if (access.ok) return;

    const oauthAccess = await options.resolveOAuthAccess?.(request);
    if (oauthAccess !== null && oauthAccess !== undefined) {
      const scope = oauthScopeForRoute(request.method, request.url);
      const result = scope === null
        ? { ok: false as const, statusCode: 403, detail: "OAuth token is not allowed for this resource" }
        : requireOAuthScope(oauthAccess, scope);
      if (!result.ok) {
        request.log.warn({ method: request.method, path: requestLogPath(request), statusCode: result.statusCode }, "HTTP authentication rejected");
        return reply.code(result.statusCode).send(requestPath.startsWith("/api/conversations/v1/")
          ? { error: { code: "forbidden", message: result.detail } }
          : { detail: result.detail });
      }
      return;
    }

    const statusCode = access.statusCode ?? 401;
    request.log.warn({
      method: request.method,
      path: requestLogPath(request),
      statusCode,
    }, "HTTP authentication rejected");
    return reply.code(statusCode).send(requestPath.startsWith("/api/conversations/v1/")
      ? { error: { code: statusCode === 401 ? "login_required" : statusCode === 403 ? "forbidden" : "unavailable", message: access.detail } }
      : { detail: access.detail });
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

function resolveNodeCredentialPrincipal(
  request: FastifyRequest,
  options: ProductionAuthGuardOptions,
): NodePrincipal | null {
  if (options.nodeCredentials === undefined || options.nodeCredentials === null) {
    return null;
  }
  const token = extractBearerToken(request.headers.authorization);
  return token === undefined ? null : options.nodeCredentials.resolve(token);
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
