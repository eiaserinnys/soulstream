import type { Env } from "../config.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ServerParams } from "../server.js";

export function buildMcpServerOptions(
  env: Env,
  runtime: McpRuntime,
): NonNullable<ServerParams["mcp"]> | undefined {
  if (!env.MCP_ENABLED) return undefined;
  return {
    runtime,
    path: env.MCP_PATH,
    statelessTransport: env.MCP_STATELESS_TRANSPORT_ENABLED,
    auth: {
      requireAuth: env.MCP_REQUIRE_AUTH,
      bearerToken: env.AUTH_BEARER_TOKEN,
      allowedHosts: env.MCP_ALLOWED_HOSTS,
    },
    ...(env.MCP_EXTERNAL_INGRESS_ENABLED
      ? {
          externalIngress: {
            path: env.MCP_EXTERNAL_INGRESS_PATH!,
            source: env.MCP_EXTERNAL_INGRESS_SOURCE!,
            displayName: env.MCP_EXTERNAL_INGRESS_DISPLAY_NAME!,
            auth: {
              requireAuth: true,
              bearerToken: env.MCP_EXTERNAL_INGRESS_BEARER_TOKEN!,
              allowedHosts: env.MCP_ALLOWED_HOSTS,
            },
          },
        }
      : {}),
  };
}
