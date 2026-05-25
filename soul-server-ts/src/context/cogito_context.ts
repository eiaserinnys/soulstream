import type { Logger } from "pino";

import type { ContextItem } from "./prompt_assembler.js";

export interface CogitoContextConfig {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxNodes: number;
  maxChars: number;
}

export const DEFAULT_COGITO_CONTEXT_LIMITS = {
  timeoutMs: 1500,
  maxNodes: 8,
  maxChars: 6000,
} as const;

const CONTEXT_SCHEMA_VERSION = "soulstream.startup.cogito_context.v1";
const COGITO_BRIEFS_PATH = "/cogito/briefs";
const MAX_CAPABILITIES_PER_NODE = 12;
const MAX_WARNINGS_PER_NODE = 3;
const MAX_WARNING_LENGTH = 160;

type StartupCogitoStatus = "ok" | "partial" | "empty" | "error" | "unavailable";

interface StartupWarning {
  code: string;
  message: string;
}

interface StartupCogitoContext {
  schema_version: typeof CONTEXT_SCHEMA_VERSION;
  status: StartupCogitoStatus;
  checked_at: string;
  summary: string;
  source: {
    type: "orchestrator";
    endpoint: typeof COGITO_BRIEFS_PATH;
    timeout_ms: number;
    node_count: number;
    included_nodes: number;
    omitted_nodes: number;
  };
  nodes: StartupNodeContext[];
  warnings: StartupWarning[];
}

interface StartupNodeContext {
  node_id: string;
  status: string;
  checked_at?: string;
  service?: string;
  service_status?: string;
  capability_count: number;
  capabilities: string[];
  omitted_capabilities: number;
  runtime: Record<string, unknown>;
  warnings?: StartupWarning[];
}

export async function fetchCogitoContextItem(
  cfg: CogitoContextConfig,
  logger: Logger,
): Promise<ContextItem> {
  try {
    const aggregate = await fetchAggregate(cfg);
    const content = buildSafeStartupContext(aggregate, cfg);
    return {
      key: "cogito_context",
      label: "Cogito cluster startup context",
      content,
    };
  } catch (err) {
    logger.warn({ err }, "cogito startup context unavailable");
    return {
      key: "cogito_context",
      label: "Cogito cluster startup context",
      content: buildUnavailableContext(cfg),
    };
  }
}

async function fetchAggregate(cfg: CogitoContextConfig): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}${COGITO_BRIEFS_PATH}`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        ...cfg.headers,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`cogito brief aggregate failed with HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildUnavailableContext(cfg: CogitoContextConfig): StartupCogitoContext {
  const checkedAt = new Date().toISOString();
  return {
    schema_version: CONTEXT_SCHEMA_VERSION,
    status: "unavailable",
    checked_at: checkedAt,
    summary: "Cogito cluster brief unavailable. Startup continues.",
    source: {
      type: "orchestrator",
      endpoint: COGITO_BRIEFS_PATH,
      timeout_ms: cfg.timeoutMs,
      node_count: 0,
      included_nodes: 0,
      omitted_nodes: 0,
    },
    nodes: [],
    warnings: [
      {
        code: "cogito_context_unavailable",
        message:
          "cogito cluster brief unavailable; startup continues without live cluster context",
      },
    ],
  };
}

function buildSafeStartupContext(
  aggregate: unknown,
  cfg: CogitoContextConfig,
): StartupCogitoContext {
  const record = isRecord(aggregate) ? aggregate : {};
  const checkedAt = stringField(record, "checked_at") ?? new Date().toISOString();
  const rawNodes = recordArray(record.nodes);
  const nodeCount = numberField(record, "node_count") ?? rawNodes.length;
  const includedRawNodes = rawNodes.slice(0, cfg.maxNodes);
  const omittedByNodeCap = Math.max(0, nodeCount - includedRawNodes.length);
  const warnings: StartupWarning[] = [];
  if (omittedByNodeCap > 0) {
    warnings.push({
      code: "cogito_context_truncated",
      message: `${omittedByNodeCap} node(s) omitted by startup cogito maxNodes cap`,
    });
  }

  const context: StartupCogitoContext = {
    schema_version: CONTEXT_SCHEMA_VERSION,
    status: normalizeAggregateStatus(stringField(record, "status"), rawNodes.length),
    checked_at: checkedAt,
    summary:
      "Safe startup subset of orchestrator cogito cluster health. Raw runtime payload omitted.",
    source: {
      type: "orchestrator",
      endpoint: COGITO_BRIEFS_PATH,
      timeout_ms: cfg.timeoutMs,
      node_count: nodeCount,
      included_nodes: includedRawNodes.length,
      omitted_nodes: omittedByNodeCap,
    },
    nodes: includedRawNodes.map(summarizeNode),
    warnings,
  };
  return enforceMaxChars(context, cfg.maxChars);
}

function normalizeAggregateStatus(
  status: string | undefined,
  nodeCount: number,
): StartupCogitoStatus {
  if (
    status === "ok" ||
    status === "partial" ||
    status === "empty" ||
    status === "error" ||
    status === "unavailable"
  ) {
    return status;
  }
  return nodeCount === 0 ? "empty" : "partial";
}

function summarizeNode(node: Record<string, unknown>): StartupNodeContext {
  const data = isRecord(node.data) ? node.data : {};
  const capabilities = extractCapabilities(data);
  const includedCapabilities = capabilities.slice(0, MAX_CAPABILITIES_PER_NODE);
  const warnings = summarizeErrors(node.errors);
  return {
    node_id: stringField(node, "node_id") ?? stringField(node, "nodeId") ?? "unknown",
    status: stringField(node, "status") ?? "unavailable",
    ...(stringField(node, "checked_at") ? { checked_at: stringField(node, "checked_at") } : {}),
    ...(stringField(data, "service") ? { service: stringField(data, "service") } : {}),
    service_status: stringField(data, "status") ?? stringField(node, "status") ?? "unavailable",
    capability_count: capabilities.length,
    capabilities: includedCapabilities,
    omitted_capabilities: Math.max(0, capabilities.length - includedCapabilities.length),
    runtime: summarizeRuntime(data),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function summarizeRuntime(data: Record<string, unknown>): Record<string, unknown> {
  const sections = isRecord(data.sections) ? data.sections : {};
  const runtimeSection = isRecord(sections.runtime) ? sections.runtime : {};
  const runtimeData = isRecord(runtimeSection.data) ? runtimeSection.data : {};
  const processData = isRecord(runtimeData.process) ? runtimeData.process : {};
  const memory = isRecord(processData.memory) ? processData.memory : {};
  const counts = isRecord(runtimeData.counts) ? runtimeData.counts : {};

  const runtime: Record<string, unknown> = {
    status: stringField(runtimeSection, "status") ?? "unavailable",
  };
  const pid = numberField(processData, "pid");
  if (pid !== undefined) runtime.pid = pid;
  const uptime = numberField(processData, "uptime_seconds");
  if (uptime !== undefined) runtime.uptime_seconds = uptime;

  const safeMemory = pickNumberFields(memory, ["rss", "heap_used"]);
  if (Object.keys(safeMemory).length > 0) runtime.memory = safeMemory;

  const safeCounts = pickNumberFields(counts, ["agent_count", "active_task_count"]);
  const tasksByStatus = pickNumericRecord(counts.tasks_by_status);
  if (tasksByStatus && Object.keys(tasksByStatus).length > 0) {
    safeCounts.tasks_by_status = tasksByStatus;
  }
  if (Object.keys(safeCounts).length > 0) runtime.counts = safeCounts;

  const dependencyStatuses = extractDependencyStatuses(runtimeData);
  if (Object.keys(dependencyStatuses).length > 0) {
    runtime.dependency_statuses = dependencyStatuses;
  }
  return runtime;
}

function extractDependencyStatuses(data: Record<string, unknown>): Record<string, string> {
  const statuses: Record<string, string> = {};
  const dependencies = isRecord(data.dependencies) ? data.dependencies : {};
  for (const [name, value] of Object.entries(dependencies)) {
    if (!isRecord(value)) continue;
    const status = stringField(value, "status");
    if (status) statuses[name] = status;
  }
  const explicitStatuses = isRecord(data.dependency_statuses) ? data.dependency_statuses : {};
  for (const [name, value] of Object.entries(explicitStatuses)) {
    if (typeof value === "string") statuses[name] = value;
  }
  return statuses;
}

function extractCapabilities(data: Record<string, unknown>): string[] {
  const fromTopLevel = Array.isArray(data.capabilities) ? data.capabilities : undefined;
  const sections = isRecord(data.sections) ? data.sections : {};
  const identitySection = isRecord(sections.identity) ? sections.identity : {};
  const identityData = isRecord(identitySection.data) ? identitySection.data : {};
  const fromIdentity = Array.isArray(identityData.capabilities)
    ? identityData.capabilities
    : undefined;
  const rawCapabilities = fromTopLevel ?? fromIdentity ?? [];
  const names: string[] = [];
  for (const capability of rawCapabilities) {
    const name = capabilityName(capability);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function capabilityName(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (isRecord(value)) return stringField(value, "name");
  return undefined;
}

function summarizeErrors(value: unknown): StartupWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: StartupWarning[] = [];
  for (const error of value) {
    if (!isRecord(error)) continue;
    const code = stringField(error, "code") ?? "node_warning";
    const message = sanitizeWarningMessage(
      stringField(error, "message") ?? "node cogito brief unavailable",
    );
    warnings.push({ code, message });
    if (warnings.length >= MAX_WARNINGS_PER_NODE) break;
  }
  return warnings;
}

function sanitizeWarningMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|password|api[_-]?key)=\S+/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/\/(?:[\w.-]+\/){2,}[\w.-]+/g, "[path]")
    .slice(0, MAX_WARNING_LENGTH);
}

function enforceMaxChars(
  context: StartupCogitoContext,
  maxChars: number,
): StartupCogitoContext {
  let omittedBySize = 0;
  while (
    JSON.stringify(context, null, 2).length > maxChars &&
    context.nodes.length > 0
  ) {
    context.nodes.pop();
    omittedBySize += 1;
    context.source.included_nodes = context.nodes.length;
    context.source.omitted_nodes += 1;
  }
  if (omittedBySize > 0) {
    context.warnings.push({
      code: "cogito_context_truncated",
      message: `${omittedBySize} node(s) omitted by startup cogito maxChars cap`,
    });
  }
  if (JSON.stringify(context, null, 2).length > maxChars) {
    context.nodes = [];
    context.source.included_nodes = 0;
    context.source.omitted_nodes = context.source.node_count;
    context.warnings = [
      {
        code: "cogito_context_truncated",
        message: "node details omitted by startup cogito maxChars cap",
      },
    ];
  }
  return context;
}

function pickNumberFields(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = numberField(record, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function pickNumericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number") out[key] = raw;
  }
  return out;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
