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
