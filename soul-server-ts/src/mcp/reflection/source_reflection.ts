import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProbeStatus, ReflectionError } from "./types.js";

interface SourceManifestEntry {
  symbol: string;
  search: RegExp;
}

interface SourceManifestItem {
  relativePath: string;
  role: string;
  capabilities: string[];
  entries: SourceManifestEntry[];
}

interface SourceEntryReflection {
  symbol: string;
  status: ProbeStatus;
  line_range: {
    start_line: number;
    end_line: number;
  };
  reason?: string;
}

interface SourceReflection {
  relative_path: string;
  absolute_path: string;
  role: string;
  capabilities: string[];
  status: ProbeStatus;
  entries: SourceEntryReflection[];
}

const SOURCE_MANIFEST: SourceManifestItem[] = [
  {
    relativePath: "main.ts",
    role: "process wiring: config, DB, task manager, MCP runtime, HTTP server, upstream adapter",
    capabilities: [
      "cogito",
      "session_query",
      "session_mgmt",
      "catalog",
      "agent_config",
      "multi_node",
    ],
    entries: [{ symbol: "main", search: /^async function main/ }],
  },
  {
    relativePath: "config.ts",
    role: "environment schema and startup validation",
    capabilities: ["cogito"],
    entries: [{ symbol: "EnvSchema", search: /^export const EnvSchema/ }],
  },
  {
    relativePath: "server.ts",
    role: "Fastify server factory and route mounting",
    capabilities: ["cogito", "session_query", "session_mgmt", "catalog"],
    entries: [{ symbol: "buildServer", search: /^export async function buildServer/ }],
  },
  {
    relativePath: "mcp/runtime.ts",
    role: "typed dependency boundary for MCP tools",
    capabilities: [
      "cogito",
      "session_query",
      "session_mgmt",
      "catalog",
      "agent_config",
      "multi_node",
    ],
    entries: [{ symbol: "McpRuntime", search: /^export interface McpRuntime/ }],
  },
  {
    relativePath: "mcp/server.ts",
    role: "MCP server factory and tool registration order",
    capabilities: [
      "cogito",
      "session_query",
      "session_mgmt",
      "catalog",
      "agent_config",
      "multi_node",
    ],
    entries: [{ symbol: "buildMcpServer", search: /^export function buildMcpServer/ }],
  },
  {
    relativePath: "mcp/transport.ts",
    role: "Streamable HTTP MCP transport route",
    capabilities: ["cogito"],
    entries: [{ symbol: "registerMcpRoutes", search: /^export function registerMcpRoutes/ }],
  },
  {
    relativePath: "mcp/tools/reflect.ts",
    role: "reflect_* MCP tool registration",
    capabilities: ["cogito"],
    entries: [{ symbol: "registerReflectTools", search: /^export function registerReflectTools/ }],
  },
  {
    relativePath: "mcp/reflection/self_reflection.ts",
    role: "typed reflection envelope builder",
    capabilities: ["cogito"],
    entries: [
      { symbol: "reflectSelf", search: /^export async function reflectSelf/ },
      { symbol: "buildBriefSnapshot", search: /^export async function buildBriefSnapshot/ },
    ],
  },
  {
    relativePath: "mcp/reflection/source_reflection.ts",
    role: "source manifest and runtime line-range resolver",
    capabilities: ["cogito"],
    entries: [{ symbol: "buildSourceReflection", search: /^export function buildSourceReflection/ }],
  },
  {
    relativePath: "mcp/reflection/runtime_reflection.ts",
    role: "runtime process and dependency status builder",
    capabilities: ["cogito"],
    entries: [{ symbol: "buildRuntimeReflection", search: /^export async function buildRuntimeReflection/ }],
  },
  {
    relativePath: "db/session_db.ts",
    role: "Postgres session store adapter",
    capabilities: ["session_query", "session_mgmt", "catalog", "cogito"],
    entries: [
      { symbol: "SessionDB", search: /^export class SessionDB/ },
      { symbol: "ping", search: /^  async ping/ },
    ],
  },
  {
    relativePath: "agent_registry.ts",
    role: "agents.yaml schema and runtime registry",
    capabilities: ["session_mgmt", "agent_config", "cogito"],
    entries: [{ symbol: "AgentRegistry", search: /^export class AgentRegistry/ }],
  },
  {
    relativePath: "task/task_manager.ts",
    role: "session lifecycle and in-memory task collection",
    capabilities: ["session_mgmt", "session_query", "cogito"],
    entries: [{ symbol: "TaskManager", search: /^export class TaskManager/ }],
  },
  {
    relativePath: "engine/codex_adapter.ts",
    role: "Codex SDK adapter and event stream mapping boundary",
    capabilities: ["session_mgmt", "cogito"],
    entries: [{ symbol: "CodexEngineAdapter", search: /^export class CodexEngineAdapter/ }],
  },
  {
    relativePath: "mcp/orch_proxy.ts",
    role: "orchestrator HTTP proxy config derived from upstream WebSocket URL",
    capabilities: ["multi_node", "cogito"],
    entries: [{ symbol: "buildOrchProxyConfig", search: /^export function buildOrchProxyConfig/ }],
  },
];

export function buildSourceReflection(capability?: string): {
  source_root: { status: ProbeStatus; path?: string; reason?: string };
  sources: SourceReflection[];
  errors: ReflectionError[];
} {
  const root = resolveSourceRoot();
  const filtered = SOURCE_MANIFEST.filter((source) =>
    capability ? source.capabilities.includes(capability) : true,
  );
  if (!root) {
    return buildUnavailableSourceReflection(filtered);
  }
  const sources = filtered.map((source) => resolveSourceItem(root, source));
  const errors = sources
    .filter((source) => source.status !== "ok")
    .map((source) => ({
      code: "source_unavailable",
      message: `Source file unavailable: ${source.relative_path}`,
      detail: { path: source.absolute_path },
    }));
  return {
    source_root: { status: "ok", path: root },
    sources,
    errors,
  };
}

function buildUnavailableSourceReflection(filtered: SourceManifestItem[]) {
  return {
    source_root: {
      status: "unavailable" as const,
      reason: "source root could not be resolved from import.meta.url or process.cwd()",
    },
    sources: filtered.map((source) => ({
      relative_path: source.relativePath,
      absolute_path: path.resolve(process.cwd(), "src", source.relativePath),
      role: source.role,
      capabilities: source.capabilities,
      status: "unavailable" as const,
      entries: source.entries.map((entry) => ({
        symbol: entry.symbol,
        status: "unavailable" as const,
        line_range: { start_line: 0, end_line: 0 },
        reason: "source root unavailable",
      })),
    })),
    errors: [
      {
        code: "source_root_unavailable",
        message: "TS source root could not be resolved",
      },
    ],
  };
}

function resolveSourceRoot(): string | undefined {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const candidates = [
    path.resolve(moduleDir, "../.."),
    path.resolve(process.cwd(), "src"),
    path.resolve(process.cwd(), "soul-server-ts/src"),
  ];
  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "mcp/tools/reflect.ts")),
  );
}

function resolveSourceItem(
  sourceRoot: string,
  source: SourceManifestItem,
): SourceReflection {
  const absolutePath = path.join(sourceRoot, source.relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      relative_path: source.relativePath,
      absolute_path: absolutePath,
      role: source.role,
      capabilities: source.capabilities,
      status: "unavailable",
      entries: source.entries.map((entry) => ({
        symbol: entry.symbol,
        status: "unavailable",
        line_range: { start_line: 0, end_line: 0 },
        reason: "file not found",
      })),
    };
  }
  const lines = fs.readFileSync(absolutePath, "utf-8").split(/\r?\n/);
  const entries = source.entries.map((entry) => resolveSourceEntry(lines, entry));
  return {
    relative_path: source.relativePath,
    absolute_path: absolutePath,
    role: source.role,
    capabilities: source.capabilities,
    status: entries.every((entry) => entry.status === "ok") ? "ok" : "partial",
    entries,
  };
}

function resolveSourceEntry(
  lines: string[],
  entry: SourceManifestEntry,
): SourceEntryReflection {
  const startIndex = lines.findIndex((line) => entry.search.test(line));
  if (startIndex < 0) {
    return {
      symbol: entry.symbol,
      status: "unavailable",
      line_range: { start_line: 0, end_line: 0 },
      reason: "symbol pattern not found",
    };
  }
  const startLine = startIndex + 1;
  return {
    symbol: entry.symbol,
    status: "ok",
    line_range: {
      start_line: startLine,
      end_line: findBlockEndLine(lines, startIndex),
    },
  };
}

function findBlockEndLine(lines: string[], startIndex: number): number {
  let depth = 0;
  let started = false;
  const isConstExpression = lines[startIndex]?.includes(" const ") ?? false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? "");
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (started && depth <= 0 && (!isConstExpression || line.trim().endsWith(";"))) {
      return index + 1;
    }
    if (!started && index > startIndex && line.trim().endsWith(";")) {
      return index + 1;
    }
  }
  return startIndex + 1;
}

function stripLineComment(line: string): string {
  const commentStart = line.indexOf("//");
  return commentStart >= 0 ? line.slice(0, commentStart) : line;
}
