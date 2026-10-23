import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import { sanitizeAntigravityInputSchema } from "./mcp_schema_sanitizer.js";
import { ANTIGRAVITY_MCP_PROXY_CONFIG_ENV } from "./mcp_schema_proxy_launch.js";

export type AntigravityMcpProxyConfig =
  | { type: "streamable_http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string };

type ProxyIo = {
  stdin: Readable;
  stdout: Writable;
  inheritedEnv: NodeJS.ProcessEnv;
  signal: AbortSignal;
};

type PendingRequest = "initialize" | "tools/list";

/** Parse the one serialized upstream MCP configuration passed to the proxy process. */
export function parseAntigravityMcpProxyConfig(raw: string | undefined): AntigravityMcpProxyConfig {
  if (raw === undefined) throw new Error("Invalid Antigravity MCP proxy configuration");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid Antigravity MCP proxy configuration");
  }

  if (!isObject(parsed)) throw new Error("Invalid Antigravity MCP proxy configuration");
  if (parsed.type === "streamable_http" && typeof parsed.url === "string" && parsed.url.length > 0) {
    const headers = optionalStringRecord(parsed, "headers");
    return { type: "streamable_http", url: parsed.url, ...(headers !== undefined ? { headers } : {}) };
  }
  if (parsed.type === "stdio" && typeof parsed.command === "string" && parsed.command.length > 0) {
    const args = optionalStringArray(parsed, "args");
    const env = optionalStringRecord(parsed, "env");
    const cwd = optionalString(parsed, "cwd");
    return { type: "stdio", command: parsed.command,
      ...(args !== undefined ? { args } : {}), ...(env !== undefined ? { env } : {}), ...(cwd !== undefined ? { cwd } : {}) };
  }
  throw new Error("Invalid Antigravity MCP proxy configuration");
}

/** Relay MCP JSON-RPC messages between Antigravity's stdio and the configured upstream. */
export async function runAntigravityMcpSchemaProxy(config: AntigravityMcpProxyConfig, io: ProxyIo): Promise<void> {
  const downstream = new StdioServerTransport(io.stdin, io.stdout);
  const upstream = createUpstreamTransport(config, io.inheritedEnv);
  const pendingRequests = new Map<RequestId, PendingRequest>();
  let closePromise: Promise<void> | undefined;
  let failure: unknown;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);

  const onInputEnd = () => { void close(); };
  const onAbort = () => { void close(); };
  const close = (reason?: unknown): Promise<void> => {
    if (reason !== undefined && failure === undefined) failure = reason;
    if (!closePromise) {
      closePromise = Promise.resolve().then(async () => {
        io.stdin.removeListener("end", onInputEnd);
        io.signal.removeEventListener("abort", onAbort);
        pendingRequests.clear();
        downstream.onmessage = undefined;
        downstream.onerror = undefined;
        downstream.onclose = undefined;
        upstream.onmessage = undefined;
        upstream.onerror = undefined;
        upstream.onclose = undefined;
        const results = await Promise.allSettled([downstream.close(), upstream.close()]);
        if (failure === undefined) {
          const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (rejected) failure = rejected.reason;
        }
        if (failure === undefined) resolveClosed();
        else rejectClosed(asError(failure));
      });
    }
    return closePromise;
  };

  downstream.onmessage = (message) => {
    if ("method" in message && "id" in message && message.id !== undefined) {
      if (message.method === "initialize" || message.method === "tools/list") {
        pendingRequests.set(message.id, message.method);
      }
    }
    void upstream.send(message).catch((error: unknown) => { void close(error); });
  };
  upstream.onmessage = (message) => {
    let forwarded = message;
    if ("id" in message && message.id !== undefined && !("method" in message)) {
      const kind = pendingRequests.get(message.id);
      if (kind) {
        pendingRequests.delete(message.id);
        if (kind === "initialize" && "result" in message && isObject(message.result)
          && typeof message.result.protocolVersion === "string") {
          if (config.type === "streamable_http") {
            (upstream as StreamableHTTPClientTransport).setProtocolVersion?.(message.result.protocolVersion);
          }
        }
        if (kind === "tools/list" && "result" in message) forwarded = sanitizeToolsListResponse(message);
      }
    }
    void downstream.send(forwarded).catch((error: unknown) => { void close(error); });
  };
  downstream.onerror = (error) => { void close(error); };
  upstream.onerror = (error) => { void close(error); };
  downstream.onclose = () => { void close(); };
  upstream.onclose = () => { void close(); };
  io.stdin.once("end", onInputEnd);
  io.signal.addEventListener("abort", onAbort);

  try {
    if (io.signal.aborted) {
      await close();
    } else {
      await upstream.start();
      if (!closePromise) await downstream.start();
    }
    await closed;
  } catch (error) {
    await close(error);
    await closed.catch(() => undefined);
    throw asError(failure ?? error);
  }
}

function createUpstreamTransport(config: AntigravityMcpProxyConfig, inheritedEnv: NodeJS.ProcessEnv) {
  if (config.type === "streamable_http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }

  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (key !== ANTIGRAVITY_MCP_PROXY_CONFIG_ENV && typeof value === "string") mergedEnv[key] = value;
  }
  Object.assign(mergedEnv, config.env);
  return new StdioClientTransport({ command: config.command, args: config.args, env: mergedEnv, cwd: config.cwd, stderr: "inherit" });
}

function sanitizeToolsListResponse(message: JSONRPCMessage): JSONRPCMessage {
  if (!("result" in message) || !isObject(message.result) || !Array.isArray(message.result.tools)) return message;
  const tools = message.result.tools.map((tool) => {
    if (!isObject(tool) || !Object.hasOwn(tool, "inputSchema")) return tool;
    return { ...tool, inputSchema: sanitizeAntigravityInputSchema(tool.inputSchema) };
  });
  return { ...message, result: { ...message.result, tools } } as JSONRPCMessage;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "string") throw new Error("Invalid Antigravity MCP proxy configuration");
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error("Invalid Antigravity MCP proxy configuration");
  }
  return value;
}

function optionalStringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (!isObject(value) || !Object.values(value).every((item) => typeof item === "string")) {
    throw new Error("Invalid Antigravity MCP proxy configuration");
  }
  return value as Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Antigravity MCP proxy failed");
}
