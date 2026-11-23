import { isRecord } from "@soulstream/wire-schema/json-record";
import { z } from "zod";

import { invalidInput } from "./errors.js";
import { assertSecretName } from "./secret_refs.js";
import type {
  McpBindingInput,
  McpProfileInput,
  McpServerDefinition,
  McpServerInput,
  McpServerType,
  McpWriteOptions,
} from "./types.js";

/** mcp-registry.yaml과 같은 꼴: env/headers 값은 문자열 또는 `{ env: VAR }`다. */
const SecretValueSchema = z.union([z.string(), z.object({ env: z.string().min(1) })]);
const SecretRecordSchema = z.record(z.string(), SecretValueSchema);

const StdioConfigSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  full_command: z.string().min(1).optional(),
  env: SecretRecordSchema.optional(),
  cwd: z.string().optional(),
  cache_tools_list: z.boolean().optional(),
  timeout: z.number().positive().optional(),
  headers: SecretRecordSchema.optional(),
}).superRefine((config, context) => {
  if (!config.command && !config.full_command) {
    context.addIssue({
      code: "custom",
      path: ["command"],
      message: "stdio server requires command or full_command",
    });
  }
});

const StreamableHttpConfigSchema = z.object({
  url: z.string().min(1, "streamable_http server requires a url"),
  headers: SecretRecordSchema.optional(),
  cache_tools_list: z.boolean().optional(),
  timeout: z.number().positive().optional(),
  session_id: z.string().min(1).optional(),
});

const SseConfigSchema = z.object({
  url: z.string().min(1, "sse server requires a url"),
  headers: SecretRecordSchema.optional(),
  cache_tools_list: z.boolean().optional(),
  timeout: z.number().positive().optional(),
});

const SERVER_TYPES: readonly McpServerType[] = ["stdio", "streamable_http", "sse"];

function configSchema(type: McpServerType) {
  switch (type) {
    case "stdio":
      return StdioConfigSchema;
    case "streamable_http":
      return StreamableHttpConfigSchema;
    case "sse":
      return SseConfigSchema;
  }
}

export function parseServerType(value: unknown, label: string): McpServerType {
  if (typeof value !== "string" || !(SERVER_TYPES as readonly string[]).includes(value)) {
    throw invalidInput(`${label} must be one of stdio, streamable_http, sse`);
  }
  return value as McpServerType;
}

/** 서버 정의 전체(name?, type, config)를 검사한다. node_overrides의 값도 같은 꼴이다. */
export function parseServerDefinition(value: unknown, label: string): McpServerDefinition {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object`);
  const type = parseServerType(value.type, `${label}.type`);
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length === 0)) {
    throw invalidInput(`${label}.name must be a non-empty string`);
  }
  if (!isRecord(value.config)) throw invalidInput(`${label}.config must be an object`);
  const parsed = configSchema(type).safeParse(value.config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidInput(`${label}.config is invalid: ${issue?.message ?? "unknown error"}`);
  }
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    type,
    config: value.config,
  };
}

export function parseServerInput(value: unknown): Omit<McpServerInput, "icon"> {
  if (!isRecord(value)) throw invalidInput("server must be an object");
  const definition = parseServerDefinition(value, "server");
  if (!Array.isArray(value.node_scope)) {
    throw invalidInput("server.node_scope must be an array");
  }
  const nodeScope: string[] = [];
  for (const nodeId of value.node_scope) {
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      throw invalidInput("server.node_scope must contain node ids");
    }
    if (!nodeScope.includes(nodeId)) nodeScope.push(nodeId);
  }
  const nodeOverrides: Record<string, McpServerDefinition> = {};
  if (value.node_overrides !== undefined) {
    if (!isRecord(value.node_overrides)) {
      throw invalidInput("server.node_overrides must be an object");
    }
    for (const [nodeId, override] of Object.entries(value.node_overrides)) {
      if (!nodeScope.includes(nodeId)) {
        throw invalidInput(`server.node_overrides key is not in node_scope: ${nodeId}`);
      }
      nodeOverrides[nodeId] = parseServerDefinition(override, `server.node_overrides.${nodeId}`);
    }
  }
  const inlineSecrets: Record<string, string> = {};
  if (value.inline_secrets !== undefined) {
    if (!isRecord(value.inline_secrets)) {
      throw invalidInput("server.inline_secrets must be an object");
    }
    for (const [name, secret] of Object.entries(value.inline_secrets)) {
      assertSecretName(name);
      if (typeof secret !== "string") {
        throw invalidInput("server.inline_secrets values must be strings");
      }
      inlineSecrets[name] = secret;
    }
  }
  return {
    ...definition,
    node_scope: nodeScope,
    ...(value.node_overrides === undefined ? {} : { node_overrides: nodeOverrides }),
    ...(value.inline_secrets === undefined ? {} : { inline_secrets: inlineSecrets }),
  };
}

export function parseProfileInput(value: unknown): McpProfileInput {
  if (!isRecord(value)) throw invalidInput("profile must be an object");
  if (value.name !== undefined && typeof value.name !== "string") {
    throw invalidInput("profile.name must be a string");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw invalidInput("profile.description must be a string");
  }
  const servers: string[] = [];
  if (value.mcp_servers !== undefined) {
    if (!Array.isArray(value.mcp_servers)) {
      throw invalidInput("profile.mcp_servers must be an array");
    }
    for (const serverId of value.mcp_servers) {
      if (typeof serverId !== "string" || serverId.length === 0) {
        throw invalidInput("profile.mcp_servers must contain server ids");
      }
      if (!servers.includes(serverId)) servers.push(serverId);
    }
  }
  if (value.hosted_tools !== undefined && !Array.isArray(value.hosted_tools)) {
    throw invalidInput("profile.hosted_tools must be an array");
  }
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.description === undefined ? {} : { description: value.description }),
    mcp_servers: servers,
    hosted_tools: Array.isArray(value.hosted_tools) ? value.hosted_tools : [],
  };
}

export function parseBindingInput(value: unknown): McpBindingInput {
  if (!isRecord(value)) throw invalidInput("binding must be an object");
  if (!Array.isArray(value.node_ids) || value.node_ids.length === 0) {
    throw invalidInput("binding.node_ids must be a non-empty array");
  }
  const nodeIds: string[] = [];
  for (const nodeId of value.node_ids) {
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      throw invalidInput("binding.node_ids must contain node ids");
    }
    if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
  }
  const profileId = value.mcp_profile_id;
  if (profileId !== null && (typeof profileId !== "string" || profileId.length === 0)) {
    throw invalidInput("binding.mcp_profile_id must be a profile id or null");
  }
  if (value.fork !== undefined && typeof value.fork !== "boolean") {
    throw invalidInput("binding.fork must be a boolean");
  }
  return {
    node_ids: nodeIds,
    mcp_profile_id: profileId as string | null,
    ...(value.fork === undefined ? {} : { fork: value.fork }),
  };
}

export function parseWriteOptions(value: unknown): McpWriteOptions {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalidInput("write options must be an object");
  const positiveInteger = (input: unknown, label: string): number | undefined => {
    if (input === undefined) return undefined;
    if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
      throw invalidInput(`${label} must be a non-negative integer`);
    }
    return input;
  };
  const expectedRevision = positiveInteger(value.expectedRevision, "expectedRevision");
  const expectedVersion = positiveInteger(value.expectedVersion, "expectedVersion");
  return {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}
