import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testMcpServer } from "../src/mcp_central/server_tester.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function reply(message: { id?: number; method?: string; params?: { cursor?: string } }, paginated = false) {
  if (message.id === undefined) return undefined;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : { tools: [{ name: message.params?.cursor ? "next" : "example", inputSchema: { type: "object" } }],
      ...(paginated && !message.params?.cursor ? { nextCursor: "page-2" } : {}) };
  return { jsonrpc: "2.0", id: message.id, result };
}

async function startServer(mode: "http" | "sse" | "unauthorized" | "hang" | "init-error", paginated = false, echo?: string) {
  let stream: ServerResponse | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (mode === "unauthorized") { res.writeHead(401).end(); return; }
    if (mode === "hang") return;
    if (mode === "sse" && req.method === "GET") {
      stream = res; res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n"); return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (mode === "init-error") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "initialization failed" } }));
      return;
    }
    const response = reply(request, paginated);
    if (echo && response && request.method === "tools/list") response.result = { tools: [{ name: echo, inputSchema: { type: "object" } }] };
    if (mode === "sse") {
      res.writeHead(202).end();
      if (response) stream?.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } else if (response) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
    } else res.writeHead(202).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { stream?.end(); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe("MCP server tester", () => {
  it.each(["http", "sse"] as const)("initializes and lists tools over %s", async mode => {
    const url = await startServer(mode);
    const result = await testMcpServer({ id: "test", name: "test", type: mode === "http" ? "streamable_http" : "sse", config: { url } }, {});
    expect(result).toMatchObject({ ok: true, server_info: { name: "fixture", version: "1" }, tool_count: 1, tools: ["example"] });
  });

  it("counts tools across pages", async () => {
    const url = await startServer("http", true);
    const result = await testMcpServer({ id: "test", name: "test", type: "streamable_http", config: { url } }, {});
    expect(result).toMatchObject({ ok: true, tool_count: 2, tools: ["example", "next"] });
  });

  it("does not echo header or URL query values returned by a server", async () => {
    const url = await startServer("http", false, "fake-query-value-fake-header-value");
    const result = await testMcpServer({ id: "s", name: "s", type: "streamable_http", config: {
      url: `${url}?license=fake-query-value`, headers: { "x-license": "fake-header-value" },
    } }, {});
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fake-query-value");
    expect(JSON.stringify(result)).not.toContain("fake-header-value");
  });

  it("cleans up stdio processes after success and timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-test-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, "server.cjs");
    writeFileSync(script, `const fs = require('node:fs'); const readline = require('node:readline');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
if (process.env.HANG) { setInterval(() => {}, 1000); } else {
readline.createInterface({input: process.stdin}).on('line', line => {
  const msg = JSON.parse(line); if (msg.id === undefined) return;
  const result = msg.method === 'initialize' ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : {tools:[{name:process.env.ECHO || 'example',inputSchema:{type:'object'}}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}) + '\\n');
}); }`);
    for (const hang of [false, true]) {
      const pidFile = join(dir, hang ? "hang.pid" : "ok.pid");
      const result = await testMcpServer({ id: "test", name: "test", type: "stdio", config: { command: process.execPath, args: [script], env: { PID_FILE: pidFile, ...(hang ? { HANG: "yes" } : {}) } } }, {}, hang ? 500 : 5000);
      if (hang) expect(result).toMatchObject({ ok: false, error_stage: "timeout" });
      else expect(result).toMatchObject({ ok: true, tool_count: 1, tools: ["example"] });
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
    const command = `${process.execPath} ${script}`;
    const result = await testMcpServer({ id: "test", name: "test", type: "stdio", config: {
      full_command: command, env: { PID_FILE: join(dir, "full.pid"), ECHO: command },
    } }, {}, 5000);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(command);
    expect(() => process.kill(Number(readFileSync(join(dir, "full.pid"), "utf8")), 0)).toThrow();
  });

  it("reports 401 and initialization timeout", async () => {
    const unauthorized = await startServer("unauthorized");
    expect(await testMcpServer({ id: "s", name: "s", type: "streamable_http", config: { url: unauthorized } }, {}, 1000)).toMatchObject({ ok: false });
    const hang = await startServer("hang");
    expect(await testMcpServer({ id: "s", name: "s", type: "streamable_http", config: { url: hang } }, {}, 300)).toMatchObject({ ok: false, error_stage: "timeout" });
  });

  it("identifies an initialization protocol error", async () => {
    const url = await startServer("init-error");
    expect(await testMcpServer({ id: "s", name: "s", type: "streamable_http", config: { url } }, {})).toMatchObject({ ok: false, error_stage: "initialize" });
  });

  it("finishes the default initialization timeout within 13 seconds", async () => {
    const url = await startServer("hang");
    const started = Date.now();
    const result = await testMcpServer({ id: "s", name: "s", type: "streamable_http", config: { url } }, {});
    expect(result).toMatchObject({ ok: false, error_stage: "timeout" });
    expect(Date.now() - started).toBeLessThanOrEqual(13_000);
  }, 15_000);
  it("reports connection failure without exposing query or header values", async () => {
    const result = await testMcpServer({ id: "test", name: "test", type: "streamable_http", config: {
      url: "http://127.0.0.1:1/mcp?value=fake-query-value", headers: { Authorization: "fake-header-value" },
    } }, {}, 1000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error_stage).toBe("connect");
    expect(JSON.stringify(result)).not.toContain("fake-query-value");
    expect(JSON.stringify(result)).not.toContain("fake-header-value");
  });

  it("never returns environment values on configuration failure", async () => {
    const result = await testMcpServer({ id: "s", name: "s", type: "stdio", config: {
      command: "missing-fake-command", env: { VALUE: { env: "FAKE_VALUE" } },
    } }, { FAKE_VALUE: "fake-env-value" }, 1000);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fake-env-value");
  });

  it("accepts full_command without returning its contents", async () => {
    const command = `${process.execPath} --version`;
    const result = await testMcpServer({ id: "s", name: "s", type: "stdio", config: { full_command: command } }, {}, 1000);
    expect(result).toMatchObject({ ok: false, error_stage: "initialize" });
    expect(JSON.stringify(result)).not.toContain(command);
  });
});
