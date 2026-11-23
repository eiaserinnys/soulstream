import type { AgentsSdkHostedTool } from "@soulstream/agent-profile-contract";
import { isRecord } from "@soulstream/wire-schema/json-record";
import type { McpRegistryServer } from "../mcp_config_service.js";

export function sanitizeServer(
  server: McpRegistryServer,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  const { id, ...rest } = server;
  return {
    id,
    ...rest,
    ...("url" in server ? { url: sanitizeUrlQuerySecrets(server.url) } : {}),
    ...("env" in server && server.env
      ? { env: sanitizeSecretRecord(server.env, processEnv) }
      : {}),
    ...(server.headers ? { headers: sanitizeSecretRecord(server.headers, processEnv) } : {}),
  };
}

function sanitizeUrlQuerySecrets(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;

  const fragmentStart = url.indexOf("#", queryStart + 1);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  const query = url.slice(queryStart + 1, queryEnd);
  if (!query) return url;

  let changed = false;
  const sanitizedQuery = query
    .split("&")
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      const rawName = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
      if (!isSensitiveUrlQueryParam(rawName)) return entry;

      changed = true;
      return `${rawName}=<redacted>`;
    })
    .join("&");

  if (!changed) return url;
  return `${url.slice(0, queryStart + 1)}${sanitizedQuery}${url.slice(queryEnd)}`;
}

function sanitizeSecretRecord(
  record: Record<string, unknown>,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (isSecretRef(value)) {
        return [key, { env: value.env, resolved: Boolean(processEnv[value.env]) }];
      }
      if (isSensitiveKey(key)) return [key, { redacted: true }];
      return [key, value];
    }),
  );
}

export function sanitizeHostedTool(
  tool: AgentsSdkHostedTool,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  if (tool.type !== "hosted_mcp") return tool;
  return {
    ...tool,
    ...(tool.server_url ? { server_url: sanitizeUrlQuerySecrets(tool.server_url) } : {}),
    ...(tool.authorization ? { authorization: { redacted: true } } : {}),
    ...(tool.headers ? { headers: sanitizeSecretRecord(tool.headers, processEnv) } : {}),
  };
}

function isSensitiveKey(key: string): boolean {
  return /authorization|api[_-]?key|token|secret|password|cookie/i.test(key);
}

function isSensitiveUrlQueryParam(rawName: string): boolean {
  const decodedName = decodeUrlQueryParamName(rawName);
  const segments = decodedName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (
    segments.some((segment) =>
      [
        "auth",
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "key",
        "password",
        "passwd",
        "secret",
        "sig",
        "signature",
        "token",
      ].includes(segment)
    )
  ) {
    return true;
  }

  const collapsed = segments.join("");
  return /apikey|accesskey|clientkey|privatekey|secretkey|signingkey|accesstoken|authtoken|refreshtoken|clientsecret/.test(
    collapsed,
  );
}

function decodeUrlQueryParamName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    return rawName;
  }
}

function isSecretRef(value: unknown): value is { env: string } {
  return isRecord(value) && typeof value.env === "string";
}
