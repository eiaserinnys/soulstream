import type { McpRuntime } from "../runtime.js";

import { buildConfigReflection } from "./config_reflection.js";
import {
  filterCapabilities,
  REFLECTION_SCHEMA_VERSION,
  SELF_IDENTITY,
  SELF_SERVICE_NAME,
} from "./identity.js";
import { buildRuntimeReflection, type RuntimeReflectionData } from "./runtime_reflection.js";
import { buildSourceReflection } from "./source_reflection.js";
import type {
  ReflectionEnvelope,
  ReflectionError,
  ReflectionLevel,
  ReflectionStatus,
} from "./types.js";

export { REFLECTION_SCHEMA_VERSION, SELF_IDENTITY, SELF_SERVICE_NAME };
export type { ReflectionLevel };

export async function buildBriefSnapshot(
  runtime: McpRuntime,
): Promise<{
  services: Array<{
    name: typeof SELF_SERVICE_NAME;
    type: "internal";
    data: Record<string, unknown>;
  }>;
}> {
  return {
    services: [
      {
        name: SELF_IDENTITY.name,
        type: "internal",
        data: await reflectSelf(runtime, 0),
      },
    ],
  };
}

export async function reflectSelf(
  runtime: McpRuntime,
  level: ReflectionLevel,
  capability?: string,
): Promise<Record<string, unknown>> {
  const generatedAt = new Date().toISOString();
  if (level === 0) {
    return withCompatibility(
      envelope(runtime, level, generatedAt, "identity and MCP capability inventory", {
        identity: {
          name: SELF_IDENTITY.name,
          description: SELF_IDENTITY.description,
        },
        capabilities: filterCapabilities(capability),
      }),
    );
  }
  if (level === 1) {
    return withCompatibility(
      envelope(runtime, level, generatedAt, "configuration and environment state", {
        configs: buildConfigReflection(runtime),
      }),
    );
  }
  if (level === 2) {
    const data = buildSourceReflection(capability);
    const status = data.source_root.status === "ok" ? "ok" : "partial";
    return withCompatibility(
      envelope(
        runtime,
        level,
        generatedAt,
        "source entrypoints, files, symbols, and line ranges",
        data,
        status,
        data.errors,
      ),
    );
  }
  const data = await buildRuntimeReflection(runtime);
  const status = data.errors.length === 0 ? "ok" : "partial";
  return withCompatibility(
    envelope(
      runtime,
      level,
      generatedAt,
      "process runtime and external dependency status",
      data,
      status,
      data.errors,
    ),
  );
}

function envelope<TData extends Record<string, unknown>>(
  runtime: McpRuntime,
  level: ReflectionLevel,
  generatedAt: string,
  summary: string,
  data: TData,
  status: ReflectionStatus = "ok",
  errors: ReflectionError[] = [],
): ReflectionEnvelope<TData> {
  return {
    schema_version: REFLECTION_SCHEMA_VERSION,
    generated_at: generatedAt,
    service: SELF_SERVICE_NAME,
    node_id: runtime.nodeId,
    level,
    status,
    summary,
    data,
    errors,
  };
}

function withCompatibility<TData extends Record<string, unknown>>(
  reflection: ReflectionEnvelope<TData>,
): Record<string, unknown> {
  const data = reflection.data;
  if (reflection.level === 0) {
    return { ...reflection, ...data };
  }
  if (reflection.level === 1) {
    return { ...reflection, configs: data.configs };
  }
  if (reflection.level === 2) {
    return { ...reflection, sources: data.sources };
  }
  if (reflection.level === 3) {
    const runtime = data as unknown as RuntimeReflectionData;
    return {
      ...reflection,
      pid: runtime.process.pid,
      uptime_seconds: runtime.process.uptime_seconds,
      agent_count: runtime.counts.agent_count,
      active_task_count: runtime.counts.active_task_count,
    };
  }
  return reflection as unknown as Record<string, unknown>;
}
