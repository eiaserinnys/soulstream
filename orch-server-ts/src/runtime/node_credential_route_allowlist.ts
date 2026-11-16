import type { RouteMethod } from "../contract/route_registry.js";

/**
 * Routes a portable node may call with its pairing credential. Everything the
 * node does with the orchestrator (`/ws/node`, host transports, attachments,
 * release delivery) has a row here; every other route belongs to the shared
 * service token or a user identity.
 *
 * Patterns are the Fastify `routeOptions.url` values of the registered route,
 * so an entry that no route registers fails the route allowlist test.
 */
export type NodeCredentialRouteAllowlistEntry = {
  readonly method: RouteMethod;
  readonly routeUrl: string;
};

export const nodeCredentialRouteAllowlist: readonly NodeCredentialRouteAllowlistEntry[] = [
  { method: "WEBSOCKET", routeUrl: "/ws/node" },
  { method: "WEBSOCKET", routeUrl: "/ws/node/control" },
  { method: "POST", routeUrl: "/api/node-pair/start" },
  { method: "POST", routeUrl: "/api/node-pair/poll" },
  { method: "GET", routeUrl: "/api/node/releases/current" },
  { method: "GET", routeUrl: "/api/node/releases/:source_commit" },
  { method: "POST", routeUrl: "/api/mcp/host/:tool" },
  { method: "POST", routeUrl: "/api/sessions/:session_id/intervene" },
  { method: "POST", routeUrl: "/api/session-deliveries/host/:operation" },
  { method: "POST", routeUrl: "/api/session-data/host/:operation" },
  { method: "POST", routeUrl: "/api/session-page-bindings/host/:operation" },
  { method: "POST", routeUrl: "/api/claude-runtime/host/:operation" },
  { method: "POST", routeUrl: "/api/worktrees/host/:operation" },
  { method: "POST", routeUrl: "/api/folders/host/:operation" },
  { method: "POST", routeUrl: "/internal/folder-content/:operation" },
  { method: "POST", routeUrl: "/api/page-yjs/host/:operation" },
  { method: "POST", routeUrl: "/api/schedules/host/:operation" },
  { method: "POST", routeUrl: "/api/attachments/agent-register" },
  { method: "POST", routeUrl: "/api/attachments/agent-output/validate" },
  { method: "GET", routeUrl: "/api/attachments/worker/:attachment_id/metadata" },
  { method: "GET", routeUrl: "/api/attachments/worker/:attachment_id/content" },
  { method: "GET", routeUrl: "/api/nodes/:node_id/model-presets" },
  { method: "POST", routeUrl: "/api/persistent-context/host/evaluate" },
  { method: "POST", routeUrl: "/api/card-orchestration/decision/authorize" },
  { method: "POST", routeUrl: "/api/card-orchestration/worker/authorize" },
  { method: "GET", routeUrl: "/api/cards/:id" },
];

export type NodeCredentialRouteIdentity = {
  readonly method: string;
  readonly routeUrl?: string;
  readonly websocket?: boolean;
};

const allowlistKeys = new Set(
  nodeCredentialRouteAllowlist.map((entry) => `${entry.method} ${entry.routeUrl}`),
);

export function isNodeCredentialRouteAllowed(
  identity: NodeCredentialRouteIdentity,
): boolean {
  if (identity.routeUrl === undefined) return false;
  const method = identity.websocket === true
    ? "WEBSOCKET"
    : identity.method.toUpperCase();
  return allowlistKeys.has(`${method} ${identity.routeUrl}`);
}
