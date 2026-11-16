import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { WorktreeGit } from "../../src/worktree/worktree_git.js";
import { RepositoryLock } from "../../src/worktree/worktree_repository_lock.js";
import { WorktreeService } from "../../src/worktree/worktree_service.js";
import type { WorktreeHost, WorktreeRecord } from "../../src/worktree/worktree_types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  projectsRoot: string;
  repo: string;
  activeDir: string;
  host: StubWorktreeHost;
  service: WorktreeService;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "worktree-mcp-tools-"));
  roots.push(root);
  const projectsRoot = join(root, "projects");
  const repo = join(projectsRoot, "demo");
  const activeDir = join(root, "active-session");
  mkdirSync(repo, { recursive: true });
  mkdirSync(activeDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  const host = new StubWorktreeHost();
  const service = new WorktreeService({
    nodeId: "node-a",
    projectsRoot,
    git: new WorktreeGit({ projectsRoot, timeoutMs: 20_000 }),
    createTimeoutMs: 20_000,
    lock: new RepositoryLock({ lockRoot: join(projectsRoot, ".locks"), defaultTimeoutMs: 5_000 }),
    host,
    listActiveWorkspaceDirs: () => [activeDir],
  });
  return { projectsRoot, repo, activeDir, host, service };
}

class StubWorktreeHost implements WorktreeHost {
  readonly records: WorktreeRecord[] = [];

  async sweepCandidates() {
    return [];
  }

  async list(input: Parameters<WorktreeHost["list"]>[0]) {
    return this.records
      .filter((record) => record.nodeId === input.nodeId)
      .filter((record) => !input.repoId || record.repoId === input.repoId)
      .filter((record) => !input.worktreeId || record.id === input.worktreeId)
      .map((record) => ({
        ...record,
        mutableByCaller: true,
        removableByCaller: true,
        activeSessionId: null,
      }));
  }

  async register(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async updateSetup(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async beginRemove(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async restoreReady(input: Parameters<WorktreeHost["restoreReady"]>[0]): Promise<WorktreeRecord> {
    const record = this.records.find((entry) => entry.id === input.worktreeId)!;
    return record;
  }
  async finishRemove(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async beginBranchDelete(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async finishBranchDelete(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async resolveExecution(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
}

function makeRuntime(worktreeService: WorktreeService): McpRuntime {
  return {
    nodeId: "node-a",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {},
    taskManager: { listTasks: () => [] },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: new AgentRegistry([]),
    agentProfileSource: {},
    agentConfigService: {},
    mcpConfigService: {},
    catalogService: {},
    worktreeService,
    orch: { baseUrl: "https://orchestrator.example", headers: {} },
    logger: pino({ level: "silent" }),
  } as unknown as McpRuntime;
}

async function callTool(
  worktreeService: WorktreeService,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = buildMcpServer(makeRuntime(worktreeService));
  const client = new Client({ name: "worktree-tools-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({ name, arguments: args }) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

function contentText(result: Record<string, unknown>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

function worktreeRecord(overrides: Partial<WorktreeRecord>): WorktreeRecord {
  return {
    id: "worktree-1",
    nodeId: "node-a",
    repoId: "demo",
    canonicalPath: "/nonexistent",
    branch: "feature/mcp",
    createdFromSha: "0".repeat(40),
    ownerFolderId: null,
    createdBySessionId: "owner",
    state: "ready",
    setupMode: "none",
    setupRequired: false,
    setupStatus: "not_requested",
    managedPaths: [],
    worktreeIdentity: "worktree-1",
    branchDeleteExpectedSha: null,
    branchDeleteMarkerRef: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

describe("worktree MCP tool error content", () => {
  it("explains a missing worktree ID in the content text", async () => {
    const { service } = fixture();

    const result = await callTool(service, "remove_worktree", {
      worktree_id: "1234abcd",
      caller_session_id: "owner",
    });

    expect(result.isError).toBe(true);
    const text = contentText(result);
    expect(text).toContain("WORKTREE_NOT_FOUND");
    expect(text).toContain("1234abcd");
    expect(text).toContain("full worktree ID");
    expect(text).toContain("list_worktrees");
    expect(text).toMatch(/details: \{.*"worktreeId":"1234abcd".*"nodeId":"node-a".*\}/);
  });

  it("explains the overlapping active workspace in the content text", async () => {
    const { service, host, activeDir } = fixture();
    host.records.push(worktreeRecord({ canonicalPath: activeDir }));

    const result = await callTool(service, "remove_worktree", {
      worktree_id: "worktree-1",
      caller_session_id: "owner",
    });

    expect(result.isError).toBe(true);
    const text = contentText(result);
    expect(text).toContain("WORKTREE_IN_USE");
    expect(text).toContain(activeDir);
    expect(text).toContain("details: ");
  });

  it("returns the paged list envelope with the cursor and total", async () => {
    const { service } = fixture();

    const result = await callTool(service, "list_worktrees", {
      repo_id: "demo",
      caller_session_id: "owner",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total: 1,
      nextCursor: null,
      worktrees: [expect.objectContaining({ repoId: "demo", discoveryKind: "base" })],
    });
    expect(contentText(result)).toContain("\"nextCursor\": null");
  });
});
