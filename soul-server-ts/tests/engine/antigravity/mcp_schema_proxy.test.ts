import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { parseAntigravityMcpProxyConfig } from "../../../src/engine/antigravity/mcp_schema_proxy.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const PROXY_ENV = "SOULSTREAM_ANTIGRAVITY_MCP_UPSTREAM";
const PROXY_FLAG = "--antigravity-mcp-schema-proxy";
const PROTOCOL_VERSION = "2025-03-26";
const packageRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const packageRequire = createRequire(resolve(packageRoot, "package.json"));
const runnerEntry = resolve(packageRoot, "src/runner/runner_entry.ts");
const tsxEsmUrl = pathToFileURL(packageRequire.resolve("tsx/esm")).href;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
}

function createProxyTransport(config: unknown, stderr: string[] = []) {
  const env = { ...processEnvironment(), [PROXY_ENV]: JSON.stringify(config) };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxEsmUrl, runnerEntry, PROXY_FLAG],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", chunk => stderr.push(String(chunk)));
  return { transport, stderr };
}

async function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeClient(client: Client, transport: StdioClientTransport): Promise<void> {
  await Promise.allSettled([client.close(), transport.close()]);
}

describe("Antigravity MCP schema proxy", () => {
  it("parses the two supported upstream transports and rejects malformed configuration", () => {
    expect(parseAntigravityMcpProxyConfig(JSON.stringify({ type: "streamable_http", url: "http://localhost:4321/mcp", headers: { Authorization: "fixture" } })))
      .toEqual({ type: "streamable_http", url: "http://localhost:4321/mcp", headers: { Authorization: "fixture" } });
    expect(parseAntigravityMcpProxyConfig(JSON.stringify({ type: "stdio", command: "/usr/bin/node", args: ["probe.mjs"], env: { PROBE: "ok" }, cwd: "/tmp" })))
      .toEqual({ type: "stdio", command: "/usr/bin/node", args: ["probe.mjs"], env: { PROBE: "ok" }, cwd: "/tmp" });
    expect(() => parseAntigravityMcpProxyConfig(undefined)).toThrow();
    expect(() => parseAntigravityMcpProxyConfig("not-json")).toThrow();
    expect(() => parseAntigravityMcpProxyConfig(JSON.stringify({ type: "stdio", args: [] }))).toThrow();
  });

  it("forwards HTTP initialize, pagination, notifications, errors, and empty-string calls", async () => {
    const requests: Array<{ message: JsonRpcRequest; authorization?: string; protocol?: string; session?: string }> = [];
    const calls: unknown[] = [];
    let resolveCancellation!: () => void;
    const cancellationReceived = new Promise<void>(resolveReceived => { resolveCancellation = resolveReceived; });
    const variantTool = {
      name: "set_variant",
      description: "Set the source variant",
      inputSchema: { type: "object", properties: { variant: { type: "string", enum: ["clean", "logo", ""] } } },
      outputSchema: { type: "object", properties: { state: { type: "string", enum: ["ready", ""] } } },
      annotations: { readOnlyHint: true },
      _meta: { fixture: "preserved" },
    };
    const httpServer = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        if (!body.trim()) {
          response.writeHead(200).end();
          return;
        }
        const message = JSON.parse(body) as JsonRpcRequest;
        requests.push({ message, authorization: request.headers.authorization,
          protocol: request.headers["mcp-protocol-version"], session: request.headers["mcp-session-id"] });
        response.setHeader("Mcp-Session-Id", "proxy-http-session");
        if (message.method.startsWith("notifications/")) {
          response.writeHead(202).end();
          if (message.method === "notifications/cancelled" && message.params?.requestId === "cancel-http") {
            resolveCancellation();
          }
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.writeHead(200);
        if (message.method === "initialize") {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "proxy-http-fixture", version: "1" } } }));
          return;
        }
        if (message.method === "tools/list") {
          const cursor = message.params?.cursor;
          const result = cursor === "next"
            ? { tools: [variantTool, { name: "failure", inputSchema: { type: "object", properties: {} } }] }
            : { tools: [{ name: "first-page", inputSchema: { type: "object", properties: {} } }], nextCursor: "next" };
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          return;
        }
        if (message.method === "tools/call") {
          const params = message.params ?? {};
          if (params.name === "failure") {
            response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
              error: { code: -32071, message: "upstream fixture error" } }));
            return;
          }
          calls.push(params.arguments ?? {});
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            result: { content: [{ type: "text", text: "HTTP_TOOL_OK" }], structuredContent: { state: "ready" } } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
    });
    await new Promise<void>(resolveListen => httpServer.listen(0, "127.0.0.1", resolveListen));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
    const config = { type: "streamable_http", url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer http-fixture-secret" } };
    const started = createProxyTransport(config);
    const client = new Client({ name: "antigravity-proxy-test", version: "1" });
    try {
      await client.connect(started.transport);
      const firstPage = await client.listTools();
      const secondPage = await client.listTools({ cursor: firstPage.nextCursor });
      const forwardedSchema = secondPage.tools.find(tool => tool.name === "set_variant")!.inputSchema;
      expect(forwardedSchema.properties?.variant).toMatchObject({
        type: "string",
        description: 'Allowed values: ["clean","logo",""]. The empty string "" is a valid value and must be passed explicitly when intended.',
      });
      expect(forwardedSchema.properties?.variant).not.toHaveProperty("enum");
      expect(secondPage.tools.find(tool => tool.name === "set_variant")?.outputSchema?.properties?.state)
        .toEqual({ type: "string", enum: ["ready", ""] });
      expect(secondPage.tools.find(tool => tool.name === "set_variant")?._meta).toEqual({ fixture: "preserved" });

      await client.callTool({ name: "set_variant", arguments: {} });
      await client.callTool({ name: "set_variant", arguments: { variant: "" } });
      await expect(client.callTool({ name: "failure", arguments: {} })).rejects.toMatchObject({
        code: -32071,
        message: "MCP error -32071: upstream fixture error",
      });
      await started.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled",
        params: { requestId: "cancel-http", reason: "fixture" } });
      await waitFor(cancellationReceived, "HTTP cancellation notification was not forwarded");

      expect(calls).toEqual([{}, { variant: "" }]);
      expect(requests.some(x => x.message.method === "notifications/initialized")).toBe(true);
      expect(requests.some(x => x.message.method === "notifications/cancelled" && x.message.params?.requestId === "cancel-http")).toBe(true);
      expect(requests.some(x => x.message.method === "tools/list" && x.message.params?.cursor === "next")).toBe(true);
      const initialized = requests.find(x => x.message.method === "tools/list");
      expect(initialized?.authorization).toBe("Bearer http-fixture-secret");
      expect(initialized?.protocol).toBe(PROTOCOL_VERSION);
      expect(initialized?.session).toBe("proxy-http-session");
      expect(started.stderr.join("")).not.toContain("http-fixture-secret");
    } finally {
      await closeClient(client, started.transport);
      await new Promise<void>(resolveClose => httpServer.close(() => resolveClose()));
    }
  }, 60_000);

  it("forwards stdio calls, notifications, and server messages, then closes the upstream child", async () => {
    const root = await mkdtemp(join(tmpdir(), "antigravity-mcp-proxy-stdio-"));
    const workingDirectory = join(root, "upstream-cwd");
    const receiptPath = join(root, "calls.jsonl");
    const notificationPath = join(root, "notifications.jsonl");
    const closedPath = join(root, "upstream-closed");
    const scriptPath = join(root, "stdio-fixture.mjs");
    const sdkMcpUrl = pathToFileURL(packageRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
    const sdkStdioUrl = pathToFileURL(packageRequire.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
    const sdkTypesUrl = pathToFileURL(packageRequire.resolve("@modelcontextprotocol/sdk/types.js")).href;
    const zodUrl = pathToFileURL(packageRequire.resolve("zod/v4")).href;
    await mkdir(workingDirectory);
    const fixture = `
import { appendFileSync, writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(sdkMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { CancelledNotificationSchema } from ${JSON.stringify(sdkTypesUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const server = new McpServer({ name: "proxy-stdio-fixture", version: "1" }, { capabilities: { logging: {} } });
server.server.setNotificationHandler(CancelledNotificationSchema, notification => {
  appendFileSync(process.env.PROBE_NOTIFICATIONS, JSON.stringify(notification.params) + "\\n");
});
server.registerTool("set_variant", { description: "Record the exact variant value",
  inputSchema: { variant: z.enum(["clean", "logo", ""]).optional() } }, async ({ variant }) => {
  appendFileSync(process.env.PROBE_CALLS, JSON.stringify({ variant, secret: process.env.PROBE_SECRET, cwd: process.cwd() }) + "\\n");
  await server.sendLoggingMessage({ level: "info", logger: "fixture", data: "upstream-notification" });
  return { content: [{ type: "text", text: variant === "" ? "EMPTY_VALUE_OK" : "NONEMPTY_VALUE" }] };
});
process.stdin.once("end", () => { writeFileSync(process.env.PROBE_CLOSED, "closed"); });
await server.connect(new StdioServerTransport());
`;
    await writeFile(scriptPath, fixture, { mode: 0o600 });
    const config = { type: "stdio", command: process.execPath, args: [scriptPath], cwd: workingDirectory,
      env: { PROBE_CALLS: receiptPath, PROBE_NOTIFICATIONS: notificationPath, PROBE_CLOSED: closedPath,
        PROBE_SECRET: "stdio-fixture-secret" } };
    const started = createProxyTransport(config);
    const client = new Client({ name: "antigravity-proxy-test", version: "1" });
    let bodyPassed = false;
    let resolveLogging!: (data: unknown) => void;
    const logging = new Promise<unknown>(resolveLoggingPromise => { resolveLogging = resolveLoggingPromise; });
    client.setNotificationHandler(LoggingMessageNotificationSchema, message => resolveLogging(message.params.data));
    try {
      await client.connect(started.transport);
      const tools = await client.listTools();
      const inputSchema = tools.tools.find(tool => tool.name === "set_variant")!.inputSchema;
      expect(inputSchema.properties?.variant).not.toHaveProperty("enum");
      expect(inputSchema.properties?.variant).toMatchObject({ type: "string", description: expect.stringContaining("The empty string \"\" is a valid value") });
      const result = await client.callTool({ name: "set_variant", arguments: { variant: "" } });
      expect(result.content).toContainEqual({ type: "text", text: "EMPTY_VALUE_OK" });
      await expect(waitFor(logging, "upstream logging notification was not forwarded")).resolves.toBe("upstream-notification");

      await started.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled",
        params: { requestId: "cancel-stdio", reason: "fixture" } });
      const secondResult = await client.callTool({ name: "set_variant", arguments: {} });
      expect(secondResult.content).toContainEqual({ type: "text", text: "NONEMPTY_VALUE" });
      const calls = (await readFile(receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toEqual([
        { variant: "", secret: "stdio-fixture-secret", cwd: workingDirectory },
        { secret: "stdio-fixture-secret", cwd: workingDirectory },
      ]);
      const notifications = (await readFile(notificationPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(notifications).toContainEqual({ requestId: "cancel-stdio", reason: "fixture" });
      expect(started.stderr.join("")).not.toContain("stdio-fixture-secret");
      bodyPassed = true;
    } finally {
      await closeClient(client, started.transport);
      if (bodyPassed) await expect(readFile(closedPath, "utf8")).resolves.toBe("closed");
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    ["invalid configuration", { type: "unknown", url: "https://example.test/CONFIG_SECRET", headers: { Authorization: "CONFIG_SECRET" } }, "Antigravity MCP proxy configuration failed"],
    ["invalid upstream URL", { type: "streamable_http", url: "not-a-url/TRANSPORT_SECRET", headers: { Authorization: "TRANSPORT_SECRET" } }, "Antigravity MCP proxy transport failed"],
  ])("keeps %s details out of stderr", async (_label, config, expectedMessage) => {
    const started = createProxyTransport(config);
    let resolveClose!: () => void;
    const closed = new Promise<void>(resolveClosed => { resolveClose = resolveClosed; });
    started.transport.onclose = resolveClose;
    try {
      await started.transport.start();
      await waitFor(closed, "proxy process did not exit after startup failure");
      const output = started.stderr.join("");
      expect(output).toBe(`${expectedMessage}\n`);
      expect(output).not.toMatch(/CONFIG_SECRET|TRANSPORT_SECRET/);
    } finally {
      await started.transport.close();
    }
  }, 60_000);
});
