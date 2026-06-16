import fs from "node:fs";

import type { McpRuntime } from "../runtime.js";

import { SELF_IDENTITY } from "./identity.js";
import type { ProbeStatus } from "./types.js";

interface ConfigReflectionEntry {
  key: string;
  status: ProbeStatus;
  source: "runtime" | "env" | "default" | "derived";
  required: boolean;
  sensitive: boolean;
  value?: string | number | boolean | string[];
  redacted?: boolean;
  reason?: string;
}

export function buildConfigReflection(runtime: McpRuntime): ConfigReflectionEntry[] {
  const agentsConfigExists = fs.existsSync(runtime.agentsConfigPath);
  return [
    {
      key: "SOULSTREAM_NODE_ID",
      status: runtime.nodeId ? "present" : "missing",
      source: "runtime",
      required: true,
      sensitive: false,
      value: runtime.nodeId,
    },
    {
      key: "AGENTS_CONFIG_PATH",
      status: agentsConfigExists ? "present" : "unavailable",
      source: "runtime",
      required: false,
      sensitive: false,
      value: runtime.agentsConfigPath,
      reason: agentsConfigExists ? undefined : "configured file is not readable from this process",
    },
    envEntry("DATABASE_URL", { required: true, sensitive: true }),
    envEntry("SOULSTREAM_UPSTREAM_URL", { required: true, sensitive: false }),
    envEntry("MCP_ENABLED", { required: false, sensitive: false, defaultValue: "false" }),
    envEntry("RUNBOOK_ENABLED", { required: false, sensitive: false, defaultValue: "false" }),
    envEntry("MCP_PATH", { required: false, sensitive: false, defaultValue: "/mcp" }),
    envEntry("MCP_REQUIRE_AUTH", {
      required: false,
      sensitive: false,
      defaultValue: "false",
    }),
    {
      key: "orch_http_base_url",
      status: runtime.orch ? "present" : "not_configured",
      source: "derived",
      required: false,
      sensitive: false,
      value: runtime.orch?.baseUrl,
      reason: runtime.orch
        ? "derived from SOULSTREAM_UPSTREAM_URL"
        : "orchestrator proxy config was not injected into McpRuntime",
    },
    {
      key: "mcp_capability_count",
      status: "present",
      source: "runtime",
      required: true,
      sensitive: false,
      value: SELF_IDENTITY.capabilities.length,
    },
  ];
}

function envEntry(
  key: string,
  params: { required: boolean; sensitive: boolean; defaultValue?: string },
): ConfigReflectionEntry {
  const value = process.env[key];
  if (value && value.length > 0) {
    return {
      key,
      status: "present",
      source: "env",
      required: params.required,
      sensitive: params.sensitive,
      value: params.sensitive ? undefined : value,
      redacted: params.sensitive,
    };
  }
  if (params.defaultValue !== undefined) {
    return {
      key,
      status: "present",
      source: "default",
      required: params.required,
      sensitive: params.sensitive,
      value: params.defaultValue,
    };
  }
  return {
    key,
    status: params.required ? "missing" : "not_configured",
    source: "env",
    required: params.required,
    sensitive: params.sensitive,
  };
}
