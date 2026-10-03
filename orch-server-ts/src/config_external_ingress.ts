import { isAbsolute } from "node:path";
import { z } from "zod";

export const EXTERNAL_INGRESS_ENVIRONMENT_VARIABLES = [
  "MCP_EXTERNAL_INGRESS_ENABLED", "MCP_EXTERNAL_INGRESS_PATH", "MCP_EXTERNAL_INGRESS_SOURCE",
  "MCP_EXTERNAL_INGRESS_DISPLAY_NAME", "MCP_EXTERNAL_INGRESS_BEARER_TOKEN",
  "MCP_EXTERNAL_EVENTS_STATE_FILE", "MCP_ALLOWED_HOSTS",
] as const;
type ExternalEnvironment = Partial<Record<(typeof EXTERNAL_INGRESS_ENVIRONMENT_VARIABLES)[number] | "NODE_NAME" | "AUTH_BEARER_TOKEN", string>>;
const schema = z.object({
  MCP_EXTERNAL_INGRESS_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  MCP_EXTERNAL_INGRESS_PATH: z.string().regex(/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/,
    "MCP_EXTERNAL_INGRESS_PATH must be a normalized absolute HTTP path").optional(),
  MCP_EXTERNAL_INGRESS_SOURCE: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/,
    "MCP_EXTERNAL_INGRESS_SOURCE must be a lowercase source ID").optional(),
  MCP_EXTERNAL_INGRESS_DISPLAY_NAME: z.string().trim().min(1).max(120).optional(),
  MCP_EXTERNAL_INGRESS_BEARER_TOKEN: z.string().min(1).optional(),
  MCP_EXTERNAL_EVENTS_STATE_FILE: z.string().min(1).refine(isAbsolute,
    "MCP_EXTERNAL_EVENTS_STATE_FILE must be absolute").optional(),
  MCP_ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1").transform(v => v.split(",").map(s => s.trim()).filter(Boolean)),
});
export function loadExternalIngressEnvironment(env: ExternalEnvironment) {
  const parsed = schema.parse(env);
  if (parsed.MCP_EXTERNAL_EVENTS_STATE_FILE && !parsed.MCP_EXTERNAL_INGRESS_ENABLED) {
    throw new Error("MCP_EXTERNAL_INGRESS_ENABLED must be true when MCP_EXTERNAL_EVENTS_STATE_FILE is set");
  }
  if (parsed.MCP_EXTERNAL_INGRESS_ENABLED) {
    for (const key of ["NODE_NAME", "MCP_EXTERNAL_INGRESS_PATH", "MCP_EXTERNAL_INGRESS_SOURCE",
      "MCP_EXTERNAL_INGRESS_DISPLAY_NAME", "MCP_EXTERNAL_INGRESS_BEARER_TOKEN"] as const) {
      const value = key === "NODE_NAME" ? env.NODE_NAME : parsed[key];
      if (!value?.trim()) throw new Error(`${key} is required when MCP_EXTERNAL_INGRESS_ENABLED=true`);
    }
    if (["internal", "browser"].includes(parsed.MCP_EXTERNAL_INGRESS_SOURCE!)) {
      throw new Error("MCP_EXTERNAL_INGRESS_SOURCE cannot use the reserved internal or browser source");
    }
    if (["/mcp", "/mcp/internal"].includes(parsed.MCP_EXTERNAL_INGRESS_PATH!)) {
      throw new Error("MCP_EXTERNAL_INGRESS_PATH must differ from the public and internal MCP paths");
    }
    if (parsed.MCP_EXTERNAL_INGRESS_BEARER_TOKEN === env.AUTH_BEARER_TOKEN) {
      throw new Error("MCP_EXTERNAL_INGRESS_BEARER_TOKEN must differ from AUTH_BEARER_TOKEN");
    }
  }
  return {
    mcp_external_ingress_enabled: parsed.MCP_EXTERNAL_INGRESS_ENABLED,
    mcp_external_ingress_path: parsed.MCP_EXTERNAL_INGRESS_PATH,
    mcp_external_ingress_source: parsed.MCP_EXTERNAL_INGRESS_SOURCE,
    mcp_external_ingress_display_name: parsed.MCP_EXTERNAL_INGRESS_DISPLAY_NAME,
    mcp_external_ingress_bearer_token: parsed.MCP_EXTERNAL_INGRESS_BEARER_TOKEN,
    mcp_external_events_state_file: parsed.MCP_EXTERNAL_EVENTS_STATE_FILE,
    mcp_allowed_hosts: parsed.MCP_ALLOWED_HOSTS,
  };
}
export type ExternalIngressEnvironmentConfig = ReturnType<typeof loadExternalIngressEnvironment>;
