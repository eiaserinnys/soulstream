import { join } from "node:path";

import { z } from "zod";

import {
  AgentBackendSchema,
  AgentProfileSchema,
  AgentsSdkMcpServerSchema,
} from "../agent_registry.js";
import { assertRunnerJsonValue } from "./frame_protocol.js";

const RunnerProcessPathsSchema = z.object({
  sessionDirectory: z.string().min(1),
  databasePath: z.string().min(1),
  socketPath: z.string().min(1),
  // Older persisted configs predate socketKind. runner-state is host-local,
  // so the platform reading the config is the platform that wrote it — the
  // same rule the paths factory uses.
  socketKind: z.enum(["unix_socket", "named_pipe"]).optional(),
  pidPath: z.string().min(1),
  lockPath: z.string().min(1),
  configPath: z.string().min(1),
  logPath: z.string().min(1).optional(),
}).transform((paths) => ({
  ...paths,
  socketKind: paths.socketKind
    ?? (process.platform === "win32" ? "named_pipe" as const : "unix_socket" as const),
  logPath: paths.logPath ?? join(paths.sessionDirectory, "runner.log"),
}));

const RunnerChildConfigFields = {
  sessionId: z.string().min(1),
  backend: AgentBackendSchema,
  agent: AgentProfileSchema,
  paths: RunnerProcessPathsSchema,
  codeSha: z.string().min(1),
  releaseManifestId: z.string().min(1).optional(),
  runtimeEnvIdentity: z.string().min(1).optional(),
  snapshotPath: z.string().min(1),
  codexAdapterMode: z.enum(["sdk", "app-server"]),
  codexCliPath: z.string().min(1).optional(),
  claudeRuntimeV2Enabled: z.boolean(),
  claudeRuntimeIdleTtlMs: z.number().int().positive(),
  claudeRuntimeMaxEntries: z.number().int().positive(),
  claudeRuntimeTurnTimeoutMs: z.number().int().positive(),
  runnerLeaseTimeoutMs: z.number().int().positive().optional(),
  internalMcpUrl: z.string().url(),
  resolvedMcpServers: z.array(AgentsSdkMcpServerSchema).optional(),
  codexHome: z.string().min(1).nullable(),
  rolloutRoot: z.string().min(1).nullable(),
};

// Runner configs are consumed by the immutable snapshot selected by codeSha,
// not necessarily by the host version that writes them. The writer may raise
// this discriminator only after every snapshot that can be restarted already
// accepts the new value. Additive fields remain rolling-compatible because
// older Zod object readers discard unknown keys.
export const RunnerChildConfigSchema = z.object({
  schemaVersion: z.literal(1),
  ...RunnerChildConfigFields,
});

export type RunnerChildConfig = z.infer<typeof RunnerChildConfigSchema>;

export function parseRunnerChildConfig(value: unknown): RunnerChildConfig {
  assertRunnerJsonValue(value, "runner child config");
  return RunnerChildConfigSchema.parse(value);
}
