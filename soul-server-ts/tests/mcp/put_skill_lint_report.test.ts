import { toolResult } from "./typecheck-helpers.js";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";

const transport = vi.hoisted(() => ({ fetchOrchResponse: vi.fn() }));
vi.mock("../../src/control_plane/persistence_host_transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/control_plane/persistence_host_transport.js")>()),
  fetchOrchResponse: transport.fetchOrchResponse,
}));

const report = { generated_at: "2026-11-25T03:30:00+00:00", skills: [{ name: "a" }], catalogs: [] };
let root: string;
let workspace: string;
let outside: string;
const clients: Client[] = [];
const servers: ReturnType<typeof buildMcpServer>[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lint-report-")));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  await mkdir(path.join(workspace, ".local"), { recursive: true });
  await mkdir(outside);
  transport.fetchOrchResponse.mockReset();
  transport.fetchOrchResponse.mockResolvedValue(new Response(JSON.stringify({
    content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: { ok: true, generated_at: report.generated_at, skill_count: 1, catalog_count: 0 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
});

afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
  while (servers.length) await servers.pop()?.close();
  await rm(root, { recursive: true, force: true });
});

async function call(reportFile: string, active = true) {
  const task = active ? {
    resolvedWorkspaceDir: workspace,
    agentProfileSnapshot: undefined,
    runner: { engine: { workspaceDir: workspace }, dispatcher: { activeExecutionCommandId: () => "cmd-1" } },
  } : undefined;
  const runtime = {
    nodeId: "node-1", agentsConfigPath: "/test/agents.yaml", db: {}, taskManager: { getTask: () => task }, taskExecutor: {},
    onResume: () => undefined, agentRegistry: new AgentRegistry([]), catalogService: {}, logger: pino({ level: "silent" }),
    orch: { baseUrl: "http://orch.test", headers: {} },
  } as unknown as McpRuntime;
  const server = buildMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lint-report-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  servers.push(server);
  clients.push(client);
  const result = toolResult(await withMcpRequestContext({ callerSessionId: "session-1" }, () =>
    client.callTool({ name: "put_skill_lint_report", arguments: { report_file: reportFile } })));
  const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  return { result, text };
}

describe("put_skill_lint_report", () => {
  it("reads a JSON report inside the workspace and forwards it to orch as {report}", async () => {
    await writeFile(path.join(workspace, ".local", "lint.json"), JSON.stringify(report));
    const { result } = await call(".local/lint.json");

    expect(result.isError).not.toBe(true);
    expect(transport.fetchOrchResponse).toHaveBeenCalledOnce();
    const [, method, url, body] = transport.fetchOrchResponse.mock.calls[0]!;
    expect([method, url]).toEqual(["POST", "/api/mcp/host/put_skill_lint_report"]);
    expect(body).toMatchObject({ args: { report }, context: { caller_session_id: "session-1", node_id: "node-1" } });
  });

  it("rejects paths outside the workspace, including symlinks that leave it", async () => {
    await writeFile(path.join(outside, "lint.json"), JSON.stringify(report));
    await symlink(path.join(outside, "lint.json"), path.join(workspace, "link.json"));

    for (const file of [path.join(outside, "lint.json"), "../outside/lint.json", "link.json"]) {
      const { result, text } = await call(file);
      expect(result.isError).toBe(true);
      expect(text).toContain("SKILL_LINT_REPORT_PATH_DENIED");
    }
    expect(transport.fetchOrchResponse).not.toHaveBeenCalled();
  });

  it("rejects a missing file and a session without an active execution", async () => {
    expect((await call("missing.json")).text).toContain("SKILL_LINT_REPORT_FILE_NOT_FOUND");
    expect((await call("missing.json", false)).text).toContain("SKILL_LINT_REPORT_ACTIVE_EXECUTION_REQUIRED");
    expect(transport.fetchOrchResponse).not.toHaveBeenCalled();
  });

  it("rejects files over 900KB", async () => {
    await writeFile(path.join(workspace, "big.json"), JSON.stringify({ ...report, pad: "x".repeat(900 * 1024) }));
    const { result, text } = await call("big.json");
    expect(result.isError).toBe(true);
    expect(text).toContain("SKILL_LINT_REPORT_TOO_LARGE");
    expect(transport.fetchOrchResponse).not.toHaveBeenCalled();
  });

  it("rejects non-JSON files and objects without generated_at and skills", async () => {
    await writeFile(path.join(workspace, "text.json"), "not json");
    await writeFile(path.join(workspace, "noskills.json"), JSON.stringify({ generated_at: "x" }));
    await writeFile(path.join(workspace, "nodate.json"), JSON.stringify({ skills: [] }));
    await writeFile(path.join(workspace, "array.json"), "[]");

    expect((await call("text.json")).text).toContain("SKILL_LINT_REPORT_NOT_JSON");
    for (const file of ["noskills.json", "nodate.json", "array.json"]) {
      expect((await call(file)).text).toContain("SKILL_LINT_REPORT_INVALID");
    }
    expect(transport.fetchOrchResponse).not.toHaveBeenCalled();
  });
});
