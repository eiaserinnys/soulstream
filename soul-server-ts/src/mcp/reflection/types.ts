import type { REFLECTION_SCHEMA_VERSION, SELF_SERVICE_NAME } from "./identity.js";

export type ReflectionLevel = 0 | 1 | 2 | 3;
export type ReflectionStatus = "ok" | "partial" | "unavailable";
export type ProbeStatus =
  | "ok"
  | "present"
  | "missing"
  | "partial"
  | "not_configured"
  | "unavailable";

export interface ReflectionError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ReflectionEnvelope<TData extends Record<string, unknown>> {
  schema_version: typeof REFLECTION_SCHEMA_VERSION;
  generated_at: string;
  service: typeof SELF_SERVICE_NAME;
  node_id: string;
  level: ReflectionLevel;
  status: ReflectionStatus;
  summary: string;
  data: TData;
  errors: ReflectionError[];
}

export interface ReflectionBriefSection<TData extends Record<string, unknown>> {
  status: ReflectionStatus;
  source: {
    service: typeof SELF_SERVICE_NAME;
    tool: "reflect_service";
    level: ReflectionLevel;
    checked_at: string;
  };
  checked_at: string;
  summary: string;
  data: TData;
  errors: ReflectionError[];
}

export interface ReflectionAggregateSource {
  status: ProbeStatus;
  source: string;
  checked_at: string;
  reason?: string;
  base_url?: string;
}

export interface ReflectionServiceBrief extends Record<string, unknown> {
  schema_version: typeof REFLECTION_SCHEMA_VERSION;
  generated_at: string;
  service: typeof SELF_SERVICE_NAME;
  node_id: string;
  level: 0;
  kind: "compact_aggregate";
  status: ReflectionStatus;
  summary: string;
  identity: Record<string, unknown>;
  capabilities: unknown[];
  data: {
    identity: Record<string, unknown>;
    capabilities: unknown[];
  };
  sections: {
    identity: ReflectionBriefSection<Record<string, unknown>>;
    configuration: ReflectionBriefSection<Record<string, unknown>>;
    source: ReflectionBriefSection<Record<string, unknown>>;
    runtime: ReflectionBriefSection<Record<string, unknown>>;
  };
  aggregate_sources: {
    self: ReflectionAggregateSource;
    orchestrator: ReflectionAggregateSource;
    manifest: ReflectionAggregateSource;
  };
  errors: ReflectionError[];
}

export interface ReflectionBriefSnapshot extends Record<string, unknown> {
  schema_version: typeof REFLECTION_SCHEMA_VERSION;
  generated_at: string;
  kind: "compact_aggregate";
  status: ReflectionStatus;
  summary: string;
  services: Array<{
    name: typeof SELF_SERVICE_NAME;
    type: "internal";
    data: ReflectionServiceBrief;
  }>;
  aggregate_sources: ReflectionServiceBrief["aggregate_sources"];
  errors: ReflectionError[];
}
