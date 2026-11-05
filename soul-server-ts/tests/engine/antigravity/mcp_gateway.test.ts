import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { antigravityGatewayServerName, antigravityGatewayToolName, splitAntigravityGatewayToolName, parseAntigravityMcpGatewayConfig } from "../../../src/engine/antigravity/mcp_gateway.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const require = createRequire(resolve(root, "package.json"));
const runner = resolve(root, "src/runner/runner_entry.ts");
const tsx = pathToFileURL(require.resolve("tsx/esm")).href;

describe("Antigravity MCP gateway", () => {
  it("validates config and maps names", () => {
    const config = { version: 1, servers: [{ name: "alpha", upstream: { type: "stdio", command: "node" } }] };
    expect(parseAntigravityMcpGatewayConfig(JSON.stringify(config))).toEqual(config.servers);
    for (const invalid of [
      "bad json", JSON.stringify({ version: 2, servers: [] }), JSON.stringify({ version: 1, servers: {} }),
      JSON.stringify({ version: 1, servers: [config.servers[0], config.servers[0]] }),
      JSON.stringify({ version: 1, servers: [{ name: "a__b", upstream: config.servers[0]!.upstream }] }),
      JSON.stringify({ version: 1, servers: [{ name: "", upstream: config.servers[0]!.upstream }] }),
      JSON.stringify({ version: 1, servers: [{ name: "x", upstream: { type: "stdio" } }] }),
    ]) expect(() => parseAntigravityMcpGatewayConfig(invalid)).toThrow();
    expect(antigravityGatewayServerName("Test_Agent")).toBe("profile-test-agent");
    expect(antigravityGatewayToolName("alpha", "x__y")).toBe("alpha__x__y");
    expect(splitAntigravityGatewayToolName("alpha__x__y")).toEqual({ server: "alpha", tool: "x__y" });
    for (const invalid of ["x", "__x", "x__"]) expect(splitAntigravityGatewayToolName(invalid)).toBeUndefined();
  });

  it("lists paginated stdio tools, sanitizes and routes calls despite one failed upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agy-gateway-"));
    const fixture = join(directory, "upstream.mjs");
    const config = join(directory, "gateway.json");
    const sdkServer = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/index.js")).href;
    const sdkStdio = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
    const sdkTypes = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/types.js")).href;
    await writeFile(fixture, `
import { Server } from ${JSON.stringify(sdkServer)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdio)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdkTypes)};
const name = process.argv[2];
const server = new Server({name, version:"1"}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async ({params}) => {
  if (name === "alpha" && !params?.cursor) return { tools: [{name:"x", inputSchema:{type:"object",properties:{value:{type:"string",enum:["","ok"]}}}, annotations:{readOnlyHint:true}}], nextCursor:"next" };
  if (name === "alpha") return {tools:[{name:"second",inputSchema:{type:"object"}}]};
  return {tools:[{name:"y",inputSchema:{type:"object"}}]};
});
server.setRequestHandler(CallToolRequestSchema, async ({params}) => ({content:[{type:"text",text:JSON.stringify({server:name,tool:params.name,args:params.arguments, leaked:!!process.env.SOULSTREAM_ANTIGRAVITY_MCP_GATEWAY_CONFIG})}], structuredContent:{server:name}}));
await server.connect(new StdioServerTransport());
`);
    await writeFile(config, JSON.stringify({version:1,servers:[
      {name:"alpha",upstream:{type:"stdio",command:process.execPath,args:[fixture,"alpha"]}},
      {name:"beta",upstream:{type:"stdio",command:process.execPath,args:[fixture,"beta"]}},
      {name:"broken",upstream:{type:"stdio",command:join(directory,"missing-secret")}},
    ]}));
    const stderr: string[] = [];
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({command:process.execPath,args:["--import",tsx,runner,"--antigravity-mcp-gateway"],
      env:{...env,SOULSTREAM_ANTIGRAVITY_MCP_GATEWAY_CONFIG:config},stderr:"pipe"});
    transport.stderr?.on("data", chunk => stderr.push(String(chunk)));
    const client = new Client({name:"gateway-test",version:"1"});
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool=>tool.name)).toEqual(["alpha__x","alpha__second","beta__y"]);
      const x = tools[0]!;
      expect(x.annotations).toEqual({readOnlyHint:true});
      expect(x.inputSchema.properties?.value).not.toHaveProperty("enum");
      expect(x.inputSchema.properties?.value).toHaveProperty("description");
      for (const [server,tool] of [["alpha","x"],["beta","y"]]) {
        const result = await client.callTool({name:`${server}__${tool}`,arguments:{value:"ok"}});
        expect(result).toMatchObject({content:[{type:"text",text:JSON.stringify({server,tool,args:{value:"ok"},leaked:false})}],structuredContent:{server}});
      }
      await expect(client.callTool({name:"missing__x"})).rejects.toMatchObject({code:ErrorCode.InvalidParams});
      expect(stderr.join("")).toContain("Antigravity MCP gateway upstream broken unavailable");
      expect(stderr.join("")).not.toContain("missing-secret");
    } finally {
      await client.close();
      await rm(directory,{recursive:true,force:true});
    }
  }, 60_000);

  it("connects an HTTP upstream with headers and returns its tool result", async () => {
    const seen: Array<string | undefined> = [];
    const http = createServer((request, response) => {
      if (request.method === "GET" || request.method === "DELETE") { response.writeHead(405).end(); return; }
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        seen.push(request.headers.authorization);
        const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === "initialize"
          ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "http-pong" }] };
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>(resolveListen => http.listen(0, "127.0.0.1", resolveListen));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    const directory = await mkdtemp(join(tmpdir(), "agy-gateway-http-"));
    const config = join(directory, "gateway.json");
    await writeFile(config, JSON.stringify({ version: 1, servers: [{ name: "alpha",
      upstream: { type: "streamable_http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "fixture-token" } } }] }));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", tsx, runner, "--antigravity-mcp-gateway"],
      env: { ...env, SOULSTREAM_ANTIGRAVITY_MCP_GATEWAY_CONFIG: config }, stderr: "pipe" });
    const client = new Client({ name: "gateway-http-test", version: "1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["alpha__ping"]);
      expect(await client.callTool({ name: "alpha__ping" })).toMatchObject({ content: [{ type: "text", text: "http-pong" }] });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(value => value === "fixture-token")).toBe(true);
    } finally {
      await client.close();
      await new Promise<void>(resolveClose => http.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
