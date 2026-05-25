import type { McpRuntime } from "../runtime.js";

import { REFLECTION_SCHEMA_VERSION, SELF_IDENTITY, SELF_SERVICE_NAME } from "./identity.js";
import type {
  ReflectionBriefSection,
  ReflectionEnvelope,
  ReflectionError,
  ReflectionLevel,
  ReflectionServiceBrief,
  ReflectionStatus,
} from "./types.js";

type ReflectLevel = (level: ReflectionLevel) => Promise<Record<string, unknown>>;

interface SafeLevelResult {
  level: ReflectionLevel;
  checked_at: string;
  envelope?: ReflectionEnvelope<Record<string, unknown>>;
  error?: ReflectionError;
}

const CORE_SOURCE_PATHS = new Set([
  "mcp/tools/reflect.ts",
  "mcp/reflection/self_reflection.ts",
  "mcp/reflection/brief_reflection.ts",
  "mcp/reflection/config_reflection.ts",
  "mcp/reflection/source_reflection.ts",
  "mcp/reflection/runtime_reflection.ts",
  "mcp/reflection/types.ts",
]);

export async function buildSelfServiceBrief(
  runtime: McpRuntime,
  reflectLevel: ReflectLevel,
): Promise<ReflectionServiceBrief> {
  const generatedAt = new Date().toISOString();
  const [identity, configuration, source, runtimeState] = await Promise.all([
    safeReflectLevel(0, reflectLevel, generatedAt),
    safeReflectLevel(1, reflectLevel, generatedAt),
    safeReflectLevel(2, reflectLevel, generatedAt),
    safeReflectLevel(3, reflectLevel, generatedAt),
  ]);

  const sections = {
    identity: buildSection(
      identity,
      "identity and MCP capability inventory",
      buildIdentityBriefData,
    ),
    configuration: buildSection(
      configuration,
      "configuration and environment status",
      buildConfigurationBriefData,
    ),
    source: buildSection(source, "core source entrypoint pointers", buildSourceBriefData),
    runtime: buildSection(
      runtimeState,
      "process runtime and dependency health",
      buildRuntimeBriefData,
    ),
  };
  const sectionValues = Object.values(sections);
  const status = combineStatuses(sectionValues.map((section) => section.status));
  const errors = sectionValues.flatMap((section) => section.errors);
  const identityData = sections.identity.data.identity;
  const capabilities = Array.isArray(sections.identity.data.capabilities)
    ? sections.identity.data.capabilities
    : [...SELF_IDENTITY.capabilities];
  const serviceIdentity = isRecord(identityData)
    ? identityData
    : { name: SELF_IDENTITY.name, description: SELF_IDENTITY.description };

  return {
    schema_version: REFLECTION_SCHEMA_VERSION,
    generated_at: generatedAt,
    service: SELF_SERVICE_NAME,
    node_id: runtime.nodeId,
    level: 0,
    kind: "compact_aggregate",
    status,
    summary:
      "Compact live aggregate of identity, configuration, source pointers, and runtime health.",
    identity: serviceIdentity,
    capabilities,
    data: {
      identity: serviceIdentity,
      capabilities,
    },
    sections,
    aggregate_sources: buildAggregateSources(runtime, generatedAt),
    errors,
  };
}

async function safeReflectLevel(
  level: ReflectionLevel,
  reflectLevel: ReflectLevel,
  fallbackCheckedAt: string,
): Promise<SafeLevelResult> {
  try {
    const reflected = await reflectLevel(level);
    const envelope = parseEnvelope(reflected);
    if (!envelope) {
      return {
        level,
        checked_at: fallbackCheckedAt,
        error: {
          code: `level_${level}_invalid`,
          message: `reflect_service level ${level} returned an invalid envelope`,
        },
      };
    }
    return { level, checked_at: envelope.generated_at, envelope };
  } catch (err) {
    return {
      level,
      checked_at: new Date().toISOString(),
      error: {
        code: `level_${level}_unavailable`,
        message: `reflect_service level ${level} failed`,
        detail: { reason: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

function buildSection(
  result: SafeLevelResult,
  fallbackSummary: string,
  buildData: (data: Record<string, unknown>) => Record<string, unknown>,
): ReflectionBriefSection<Record<string, unknown>> {
  if (!result.envelope) {
    return {
      status: "unavailable",
      source: {
        service: SELF_SERVICE_NAME,
        tool: "reflect_service",
        level: result.level,
        checked_at: result.checked_at,
      },
      checked_at: result.checked_at,
      summary: fallbackSummary,
      data: {},
      errors: result.error ? [result.error] : [],
    };
  }
  return {
    status: result.envelope.status,
    source: {
      service: SELF_SERVICE_NAME,
      tool: "reflect_service",
      level: result.level,
      checked_at: result.envelope.generated_at,
    },
    checked_at: result.envelope.generated_at,
    summary: result.envelope.summary,
    data: buildData(result.envelope.data),
    errors: result.envelope.errors,
  };
}

function parseEnvelope(
  value: Record<string, unknown>,
): ReflectionEnvelope<Record<string, unknown>> | undefined {
  if (value.schema_version !== REFLECTION_SCHEMA_VERSION) return undefined;
  if (value.service !== SELF_SERVICE_NAME) return undefined;
  if (!isReflectionLevel(value.level)) return undefined;
  if (!isReflectionStatus(value.status)) return undefined;
  if (typeof value.generated_at !== "string") return undefined;
  if (typeof value.node_id !== "string") return undefined;
  if (typeof value.summary !== "string") return undefined;
  if (!isRecord(value.data)) return undefined;
  if (!Array.isArray(value.errors)) return undefined;
  return value as unknown as ReflectionEnvelope<Record<string, unknown>>;
}

function buildIdentityBriefData(data: Record<string, unknown>): Record<string, unknown> {
  const identity = isRecord(data.identity)
    ? data.identity
    : { name: SELF_IDENTITY.name, description: SELF_IDENTITY.description };
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
  return {
    identity,
    capabilities,
    capability_count: capabilities.length,
  };
}

function buildConfigurationBriefData(data: Record<string, unknown>): Record<string, unknown> {
  const configs = recordArray(data.configs);
  const missingRequired = configs.filter(
    (config) =>
      config.required === true &&
      (config.status === "missing" || config.status === "unavailable"),
  );
  return {
    configs,
    config_count: configs.length,
    missing_required: missingRequired.map((config) => ({
      key: config.key,
      status: config.status,
      reason: config.reason,
    })),
  };
}

function buildSourceBriefData(data: Record<string, unknown>): Record<string, unknown> {
  const sources = recordArray(data.sources)
    .filter((source) => typeof source.relative_path === "string")
    .filter((source) => CORE_SOURCE_PATHS.has(source.relative_path as string))
    .map((source) => ({
      relative_path: source.relative_path,
      absolute_path: source.absolute_path,
      role: source.role,
      status: source.status,
      entries: recordArray(source.entries).map((entry) => ({
        symbol: entry.symbol,
        status: entry.status,
        line_range: entry.line_range,
        reason: entry.reason,
      })),
    }));
  return {
    source_root: isRecord(data.source_root) ? data.source_root : { status: "unavailable" },
    entrypoints: sources,
    entrypoint_count: sources.length,
    drilldown: {
      tool: "reflect_service",
      service: SELF_SERVICE_NAME,
      level: 2,
    },
  };
}

function buildRuntimeBriefData(data: Record<string, unknown>): Record<string, unknown> {
  const processData = isRecord(data.process) ? data.process : {};
  const memory = isRecord(processData.memory) ? processData.memory : {};
  const dependencies = isRecord(data.dependencies) ? data.dependencies : {};
  return {
    process: {
      pid: processData.pid,
      cwd: processData.cwd,
      exec_path: processData.exec_path,
      uptime_seconds: processData.uptime_seconds,
      memory: {
        rss: memory.rss,
        heap_used: memory.heap_used,
      },
    },
    counts: isRecord(data.counts) ? data.counts : {},
    dependencies,
    dependency_statuses: Object.fromEntries(
      Object.entries(dependencies).map(([name, value]) => [
        name,
        isRecord(value) ? value.status : "unavailable",
      ]),
    ),
    drilldown: {
      tool: "reflect_service",
      service: SELF_SERVICE_NAME,
      level: 3,
    },
  };
}

function buildAggregateSources(
  runtime: McpRuntime,
  checkedAt: string,
): ReflectionServiceBrief["aggregate_sources"] {
  return {
    self: {
      status: "ok",
      source: "local reflect_service Level 0-3 builders",
      checked_at: checkedAt,
    },
    orchestrator: runtime.orch
      ? {
          status: "unavailable",
          source: "McpRuntime.orch",
          checked_at: checkedAt,
          base_url: runtime.orch.baseUrl,
          reason:
            "orchestrator proxy config exists, but no safe reflect_brief fan-out API is exposed to this TS node",
        }
      : {
          status: "not_configured",
          source: "McpRuntime.orch",
          checked_at: checkedAt,
          reason: "orchestrator aggregate provider is not configured for this TS node",
        },
    manifest: {
      status: "not_configured",
      source: "TS soul-server-ts runtime",
      checked_at: checkedAt,
      reason: "Cogito manifest registry is not configured for this TS node",
    },
  };
}

function combineStatuses(statuses: ReflectionStatus[]): ReflectionStatus {
  if (statuses.every((status) => status === "unavailable")) return "unavailable";
  if (statuses.some((status) => status !== "ok")) return "partial";
  return "ok";
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReflectionLevel(value: unknown): value is ReflectionLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isReflectionStatus(value: unknown): value is ReflectionStatus {
  return value === "ok" || value === "partial" || value === "unavailable";
}
