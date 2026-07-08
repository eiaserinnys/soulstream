import type { FastifyRequest } from "fastify";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type ExecuteProxyCallerInfo = Record<string, unknown>;
export type ExecuteProxyContextItem = Record<string, unknown>;

export type ExecuteProxyNewProviderRequest = {
  prompt: string;
  nodeId?: string;
  profile: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  claude_permission_mode?: ClaudePermissionMode;
  use_mcp?: boolean;
  folderId?: string;
  system_prompt?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  caller_info: ExecuteProxyCallerInfo;
  extra_context_items?: ExecuteProxyContextItem[];
};

export type ExecuteProxyResumeProviderRequest = {
  agent_session_id: string;
  prompt: string;
  attachment_paths?: string[];
  caller_info?: ExecuteProxyCallerInfo;
  extra_context_items?: ExecuteProxyContextItem[];
};

export type ExecuteProxyPayload =
  | { mode: "new"; value: ExecuteProxyNewProviderRequest }
  | { mode: "resume"; value: ExecuteProxyResumeProviderRequest };

export type ExecuteProxyPayloadValidation =
  | { ok: true; value: ExecuteProxyPayload }
  | { ok: false; statusCode: number; detail: unknown };

export const AGENT_PROFILE_REQUIRED_DETAIL = {
  error: {
    code: "AGENT_PROFILE_REQUIRED",
    message: "New execute requests require profile or agentId",
    details: {
      hint: "Set SEOSOYOUNG_AGENT_ID or send profile/agentId in the request body",
    },
  },
} as const;

const reasoningEfforts = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const claudePermissionModes = new Set<ClaudePermissionMode>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

type JsonObject = Record<string, unknown>;

export function parseExecuteProxyPayload(
  body: unknown,
  request: FastifyRequest,
): ExecuteProxyPayloadValidation {
  const object = parseObjectBody(body);
  if (!object.ok) return object;

  const prompt = optionalStringWithDefault(object.value, "prompt", "");
  if (!prompt.ok) return prompt;
  const agentSessionId = optionalString(object.value, "agent_session_id");
  if (!agentSessionId.ok) return agentSessionId;
  const contextItems = optionalObjectArray(object.value, "context_items");
  if (!contextItems.ok) return contextItems;
  const attachmentPaths = optionalStringArrayAlias(
    object.value,
    "attachmentPaths",
    "attachment_paths",
  );
  if (!attachmentPaths.ok) return attachmentPaths;
  const callerInfo = optionalObject(object.value, "caller_info");
  if (!callerInfo.ok) return callerInfo;

  if (agentSessionId.value !== undefined && agentSessionId.value.length > 0) {
    const resumeValue: ExecuteProxyResumeProviderRequest = {
      agent_session_id: agentSessionId.value,
      prompt: prompt.value,
    };
    if (attachmentPaths.value !== undefined) resumeValue.attachment_paths = attachmentPaths.value;
    if (callerInfo.value !== undefined) resumeValue.caller_info = callerInfo.value;
    if (contextItems.value !== undefined) resumeValue.extra_context_items = contextItems.value;
    return { ok: true, value: { mode: "resume", value: resumeValue } };
  }

  const profile = optionalStringAlias(object.value, "profile", "agentId");
  if (!profile.ok) return profile;
  if (profile.value === undefined || profile.value.length === 0) {
    return { ok: false, statusCode: 422, detail: AGENT_PROFILE_REQUIRED_DETAIL };
  }

  const optionalFields = parseNewExecuteOptionalFields(object.value);
  if (!optionalFields.ok) return optionalFields;

  const newValue: ExecuteProxyNewProviderRequest = {
    prompt: prompt.value,
    profile: profile.value,
    caller_info: callerInfo.value ?? buildExecuteProxyCallerInfo(request),
  };
  if (optionalFields.value.nodeId !== undefined) newValue.nodeId = optionalFields.value.nodeId;
  if (optionalFields.value.allowed_tools !== undefined) {
    newValue.allowed_tools = optionalFields.value.allowed_tools;
  }
  if (optionalFields.value.disallowed_tools !== undefined) {
    newValue.disallowed_tools = optionalFields.value.disallowed_tools;
  }
  if (optionalFields.value.claude_permission_mode !== undefined) {
    newValue.claude_permission_mode = optionalFields.value.claude_permission_mode;
  }
  if (optionalFields.value.use_mcp !== undefined) newValue.use_mcp = optionalFields.value.use_mcp;
  if (optionalFields.value.folderId !== undefined) newValue.folderId = optionalFields.value.folderId;
  if (optionalFields.value.system_prompt !== undefined) {
    newValue.system_prompt = optionalFields.value.system_prompt;
  }
  if (optionalFields.value.model !== undefined) newValue.model = optionalFields.value.model;
  if (optionalFields.value.reasoningEffort !== undefined) {
    newValue.reasoningEffort = optionalFields.value.reasoningEffort;
  }
  if (contextItems.value !== undefined) newValue.extra_context_items = contextItems.value;
  return { ok: true, value: { mode: "new", value: newValue } };
}

type NewExecuteOptionalFields = Omit<
  ExecuteProxyNewProviderRequest,
  "prompt" | "profile" | "caller_info" | "extra_context_items"
>;

function parseNewExecuteOptionalFields(
  body: JsonObject,
): { ok: true; value: NewExecuteOptionalFields } | { ok: false; statusCode: number; detail: string } {
  const nodeId = optionalString(body, "node_id");
  if (!nodeId.ok) return nodeId;
  const allowedTools = optionalStringArray(body, "allowed_tools");
  if (!allowedTools.ok) return allowedTools;
  const disallowedTools = optionalStringArray(body, "disallowed_tools");
  if (!disallowedTools.ok) return disallowedTools;
  const claudePermissionMode = optionalClaudePermissionModeAlias(
    body,
    "claudePermissionMode",
    "claude_permission_mode",
  );
  if (!claudePermissionMode.ok) return claudePermissionMode;
  const useMcp = optionalBoolean(body, "use_mcp");
  if (!useMcp.ok) return useMcp;
  const folderId = optionalString(body, "folder_id");
  if (!folderId.ok) return folderId;
  const systemPrompt = optionalString(body, "system_prompt");
  if (!systemPrompt.ok) return systemPrompt;
  const model = optionalString(body, "model");
  if (!model.ok) return model;
  const reasoningEffort = optionalReasoningEffort(body, "reasoningEffort");
  if (!reasoningEffort.ok) return reasoningEffort;

  return {
    ok: true,
    value: {
      nodeId: nodeId.value,
      allowed_tools: allowedTools.value,
      disallowed_tools: disallowedTools.value,
      claude_permission_mode: claudePermissionMode.value,
      use_mcp: useMcp.value,
      folderId: folderId.value,
      system_prompt: systemPrompt.value,
      model: model.value,
      reasoningEffort: reasoningEffort.value,
    },
  };
}

function buildExecuteProxyCallerInfo(request: FastifyRequest): ExecuteProxyCallerInfo {
  return {
    source: "execute-proxy",
    ip: request.ip ?? null,
    user_agent: headerValue(request.headers["user-agent"]),
  };
}

function parseObjectBody(
  body: unknown,
): { ok: true; value: JsonObject } | { ok: false; statusCode: number; detail: string } {
  if (isJsonObject(body)) return { ok: true, value: body };
  return { ok: false, statusCode: 422, detail: "Request body must be a JSON object" };
}

function optionalStringWithDefault(
  object: JsonObject,
  key: string,
  defaultValue: string,
): { ok: true; value: string } | { ok: false; statusCode: number; detail: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true, value: defaultValue };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, statusCode: 422, detail: `${key} must be a string` };
}

function optionalString(
  object: JsonObject,
  key: string,
): { ok: true; value?: string } | { ok: false; statusCode: number; detail: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, statusCode: 422, detail: `${key} must be a string` };
}

function optionalStringAlias(
  object: JsonObject,
  firstKey: string,
  secondKey: string,
): { ok: true; value?: string } | { ok: false; statusCode: number; detail: string } {
  if (object[firstKey] !== undefined) return optionalString(object, firstKey);
  return optionalString(object, secondKey);
}

function optionalBoolean(
  object: JsonObject,
  key: string,
): { ok: true; value?: boolean } | { ok: false; statusCode: number; detail: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value === "boolean") return { ok: true, value };
  return { ok: false, statusCode: 422, detail: `${key} must be a boolean` };
}

function optionalStringArray(
  object: JsonObject,
  key: string,
): { ok: true; value?: string[] } | { ok: false; statusCode: number; detail: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true };
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { ok: true, value };
  }
  return { ok: false, statusCode: 422, detail: `${key} must be a string array` };
}

function optionalStringArrayAlias(
  object: JsonObject,
  firstKey: string,
  secondKey: string,
): { ok: true; value?: string[] } | { ok: false; statusCode: number; detail: string } {
  if (object[firstKey] !== undefined) return optionalStringArray(object, firstKey);
  return optionalStringArray(object, secondKey);
}

function optionalObjectArray(
  object: JsonObject,
  key: string,
): { ok: true; value?: ExecuteProxyContextItem[] } | { ok: false; statusCode: number; detail: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true };
  if (Array.isArray(value) && value.every(isJsonObject)) {
    return { ok: true, value };
  }
  return { ok: false, statusCode: 422, detail: `${key} must be an object array` };
}

function optionalObject(
  object: JsonObject,
  key: string,
): { ok: true; value?: ExecuteProxyCallerInfo } | { ok: false; statusCode: number; detail: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true };
  if (isJsonObject(value)) return { ok: true, value };
  return { ok: false, statusCode: 422, detail: `${key} must be an object` };
}

function optionalReasoningEffort(
  object: JsonObject,
  key: string,
): { ok: true; value?: ReasoningEffort } | { ok: false; statusCode: number; detail: string } {
  const value = optionalString(object, key);
  if (!value.ok) return value;
  if (value.value === undefined) return { ok: true };
  if (reasoningEfforts.has(value.value as ReasoningEffort)) {
    return { ok: true, value: value.value as ReasoningEffort };
  }
  return { ok: false, statusCode: 422, detail: `${key} must be a valid reasoning effort` };
}

function optionalClaudePermissionModeAlias(
  object: JsonObject,
  firstKey: string,
  secondKey: string,
): { ok: true; value?: ClaudePermissionMode } | { ok: false; statusCode: number; detail: string } {
  const value = optionalStringAlias(object, firstKey, secondKey);
  if (!value.ok) return value;
  if (value.value === undefined) return { ok: true };
  if (claudePermissionModes.has(value.value as ClaudePermissionMode)) {
    return { ok: true, value: value.value as ClaudePermissionMode };
  }
  return { ok: false, statusCode: 422, detail: `${firstKey} must be a valid permission mode` };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
