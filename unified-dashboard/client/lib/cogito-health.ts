export type CogitoAggregateStatus = "ok" | "partial" | "empty" | "error";
export type CogitoNodeStatus = "ok" | "timeout" | "unavailable" | "error";

export interface CogitoBriefError {
  code?: string;
  message?: string;
}

export interface CogitoBriefNodeEntry {
  node_id?: string;
  nodeId?: string;
  status?: CogitoNodeStatus | string;
  checked_at?: string;
  data?: unknown;
  errors?: CogitoBriefError[] | unknown;
}

export interface CogitoBriefAggregate {
  schema_version?: string;
  kind?: string;
  status?: CogitoAggregateStatus | string;
  generated_at?: string;
  checked_at?: string;
  timeout_seconds?: number;
  node_count?: number;
  nodes?: CogitoBriefNodeEntry[];
}

export interface CogitoDependencyStatus {
  name: string;
  status: string;
}

export interface CogitoRuntimeSummary {
  status: string;
  uptimeLabel?: string;
  memoryLabel?: string;
  agentCount?: number;
  activeTaskCount?: number;
  tasksByStatus: Record<string, number>;
  dependencies: CogitoDependencyStatus[];
}

export interface CogitoNodeHealth {
  nodeId: string;
  status: CogitoNodeStatus;
  checkedAt?: string;
  service?: string;
  serviceStatus: string;
  capabilityCount: number;
  capabilities: string[];
  omittedCapabilities: number;
  runtime: CogitoRuntimeSummary;
  warnings: CogitoBriefError[];
}

export interface CogitoHealthSummary {
  status: CogitoAggregateStatus;
  checkedAt: string;
  nodeCount: number;
  nodes: CogitoNodeHealth[];
}

const MAX_CAPABILITIES_PER_NODE = 6;
const MAX_WARNINGS_PER_NODE = 2;
const MAX_WARNING_LENGTH = 140;

export async function fetchCogitoBriefs(
  fetcher: typeof fetch = fetch,
): Promise<CogitoBriefAggregate> {
  const res = await fetcher("/cogito/briefs", {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`cogito briefs HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!isRecord(data)) {
    throw new Error("cogito briefs response is not an object");
  }
  return data as CogitoBriefAggregate;
}

export function summarizeCogitoHealth(
  aggregate: CogitoBriefAggregate | Record<string, unknown>,
): CogitoHealthSummary {
  const record = isRecord(aggregate) ? aggregate : {};
  const rawNodes = recordArray(record.nodes);
  return {
    status: normalizeAggregateStatus(stringField(record, "status"), rawNodes.length),
    checkedAt: stringField(record, "checked_at") ?? new Date().toISOString(),
    nodeCount: numberField(record, "node_count") ?? rawNodes.length,
    nodes: rawNodes.map(summarizeNode),
  };
}

function summarizeNode(node: Record<string, unknown>): CogitoNodeHealth {
  const data = isRecord(node.data) ? node.data : {};
  const serviceBrief = findServiceBrief(data);
  const capabilities = extractCapabilities(serviceBrief, data);
  const includedCapabilities = capabilities.slice(0, MAX_CAPABILITIES_PER_NODE);
  return {
    nodeId: stringField(node, "node_id") ?? stringField(node, "nodeId") ?? "unknown",
    status: normalizeNodeStatus(stringField(node, "status")),
    checkedAt: stringField(node, "checked_at"),
    service: stringField(serviceBrief, "service"),
    serviceStatus:
      stringField(serviceBrief, "status") ??
      stringField(data, "status") ??
      stringField(node, "status") ??
      "unavailable",
    capabilityCount: capabilities.length,
    capabilities: includedCapabilities,
    omittedCapabilities: Math.max(0, capabilities.length - includedCapabilities.length),
    runtime: summarizeRuntime(serviceBrief),
    warnings: summarizeErrors(node.errors),
  };
}

function findServiceBrief(data: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(data.sections)) return data;
  const services = recordArray(data.services);
  for (const service of services) {
    if (isRecord(service.data)) return service.data;
  }
  return data;
}

function summarizeRuntime(serviceBrief: Record<string, unknown>): CogitoRuntimeSummary {
  const sections = isRecord(serviceBrief.sections) ? serviceBrief.sections : {};
  const runtimeSection = isRecord(sections.runtime) ? sections.runtime : {};
  const runtimeData = isRecord(runtimeSection.data) ? runtimeSection.data : {};
  const processData = isRecord(runtimeData.process) ? runtimeData.process : {};
  const memory = isRecord(processData.memory) ? processData.memory : {};
  const counts = isRecord(runtimeData.counts) ? runtimeData.counts : {};

  return {
    status: stringField(runtimeSection, "status") ?? "unavailable",
    uptimeLabel: formatDuration(numberField(processData, "uptime_seconds")),
    memoryLabel: formatMemory(memory),
    agentCount: numberField(counts, "agent_count"),
    activeTaskCount: numberField(counts, "active_task_count"),
    tasksByStatus: pickNumericRecord(counts.tasks_by_status),
    dependencies: extractDependencyStatuses(runtimeData),
  };
}

function extractCapabilities(
  serviceBrief: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): string[] {
  const sections = isRecord(serviceBrief.sections) ? serviceBrief.sections : {};
  const identitySection = isRecord(sections.identity) ? sections.identity : {};
  const identityData = isRecord(identitySection.data) ? identitySection.data : {};
  const nestedData = isRecord(serviceBrief.data) ? serviceBrief.data : {};

  const rawCapabilities =
    arrayField(serviceBrief, "capabilities") ??
    arrayField(nestedData, "capabilities") ??
    arrayField(identityData, "capabilities") ??
    arrayField(snapshot, "capabilities") ??
    [];
  const names: string[] = [];
  for (const capability of rawCapabilities) {
    const name = capabilityName(capability);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function capabilityName(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (!isRecord(value)) return undefined;
  return stringField(value, "name") ?? stringField(value, "id");
}

function extractDependencyStatuses(data: Record<string, unknown>): CogitoDependencyStatus[] {
  const statuses = new Map<string, string>();
  const dependencies = isRecord(data.dependencies) ? data.dependencies : {};
  for (const [name, value] of Object.entries(dependencies)) {
    if (!isRecord(value)) continue;
    const status = stringField(value, "status");
    if (status) statuses.set(name, status);
  }
  const explicitStatuses = isRecord(data.dependency_statuses)
    ? data.dependency_statuses
    : {};
  for (const [name, value] of Object.entries(explicitStatuses)) {
    if (typeof value === "string" && value) statuses.set(name, value);
  }
  return [...statuses.entries()].map(([name, status]) => ({ name, status }));
}

function summarizeErrors(value: unknown): CogitoBriefError[] {
  if (!Array.isArray(value)) return [];
  const warnings: CogitoBriefError[] = [];
  for (const error of value) {
    if (!isRecord(error)) continue;
    warnings.push({
      code: stringField(error, "code") ?? "node_warning",
      message: sanitizeWarningMessage(
        stringField(error, "message") ?? "node cogito brief unavailable",
      ),
    });
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

function normalizeAggregateStatus(
  status: string | undefined,
  nodeCount: number,
): CogitoAggregateStatus {
  if (status === "ok" || status === "partial" || status === "empty" || status === "error") {
    return status;
  }
  return nodeCount === 0 ? "empty" : "partial";
}

function normalizeNodeStatus(status: string | undefined): CogitoNodeStatus {
  if (status === "ok" || status === "timeout" || status === "unavailable" || status === "error") {
    return status;
  }
  return "error";
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatMemory(memory: Record<string, unknown>): string | undefined {
  const rss = numberField(memory, "rss");
  const heapUsed = numberField(memory, "heap_used");
  const parts: string[] = [];
  if (rss !== undefined) parts.push(`rss ${formatBytes(rss)}`);
  if (heapUsed !== undefined) parts.push(`heap ${formatBytes(heapUsed)}`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function pickNumericRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
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
