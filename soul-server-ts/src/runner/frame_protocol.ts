import { z } from "zod";

/**
 * Runner frame protocol v1 evolution rules.
 *
 * - Existing frame variants and field meanings are immutable within v1.
 * - New frame variants and optional fields may be added. Receivers must ignore
 *   unknown fields on a known variant.
 * - Removing/renaming a field, changing its meaning, or changing a field from
 *   optional to required requires a protocol version bump.
 * - Every frame must remain JSON-serializable. Functions, Date, Buffer, class
 *   instances, and process-local handles are forbidden at this boundary.
 */
export const RUNNER_FRAME_PROTOCOL_VERSION = 1 as const;

const protocolVersion = z.literal(RUNNER_FRAME_PROTOCOL_VERSION);
const correlationId = z.string().min(1);
const jsonRecord = z.record(z.string(), z.json());

export const RunnerExecuteParamsSchema = z.object({
  agentSessionId: z.string().min(1),
  prompt: z.string(),
  inputUuid: z.string().min(1).optional(),
  imageAttachmentPaths: z.array(z.string()).optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  useMcp: z.boolean().optional(),
  claudePermissionMode: z.enum([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "dontAsk",
    "plan",
    "auto",
  ]).optional(),
  extraEnv: z.record(z.string(), z.string()).optional(),
  resumeRunState: z.string().optional(),
  previousResponseId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  sessionItems: z.array(z.json()).optional(),
  queuedToolApproval: z.object({
    approvalId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    options: z.object({
      message: z.string().optional(),
      alwaysApprove: z.boolean().optional(),
      alwaysReject: z.boolean().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

export const RunnerCommandFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion,
    channel: z.literal("command"),
    kind: z.literal("execute"),
    commandId: correlationId,
    params: RunnerExecuteParamsSchema,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("command"),
    kind: z.literal("interrupt"),
    commandId: correlationId,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("command"),
    kind: z.literal("close"),
    commandId: correlationId,
  }).passthrough(),
]);

const RunnerRunStateSnapshotSchema = z.object({
  backendId: z.enum(["codex", "claude", "openai-agents"]),
  serialized: z.string().nullable(),
  pendingApprovalId: z.string().nullable().optional(),
  previousResponseId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  schemaVersion: z.string().nullable().optional(),
}).passthrough();

const RunnerSessionItemsSnapshotSchema = z.object({
  backendId: z.enum(["codex", "claude", "openai-agents"]),
  items: z.array(z.json()),
}).passthrough();

const RunnerRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule_tool_use"),
    agentSessionId: z.string().min(1),
    toolUseId: z.string().min(1),
    toolName: z.string().min(1),
    input: jsonRecord,
    now: z.string().datetime({ offset: true }),
  }).passthrough(),
  z.object({
    kind: z.literal("can_use_tool"),
    agentSessionId: z.string().min(1).optional(),
    toolUseId: z.string().min(1).optional(),
    toolName: z.string().min(1),
    input: jsonRecord,
  }).passthrough(),
  z.object({
    kind: z.literal("tool_approval"),
    approvalId: z.string().min(1),
    toolName: z.string().min(1),
    input: jsonRecord,
  }).passthrough(),
]);

export const RunnerEventFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion,
    channel: z.literal("event"),
    kind: z.literal("engine_event"),
    payload: jsonRecord,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("event"),
    kind: z.literal("run_state_snapshot"),
    snapshot: RunnerRunStateSnapshotSchema,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("event"),
    kind: z.literal("session_items_snapshot"),
    snapshot: RunnerSessionItemsSnapshotSchema,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("event"),
    kind: z.literal("request"),
    correlationId,
    request: RunnerRequestSchema,
  }).passthrough(),
]);

const RunnerControlResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    data: z.json().optional(),
  }).passthrough(),
  z.object({
    status: z.literal("error"),
    error: z.object({
      code: z.string().min(1),
      message: z.string(),
    }).passthrough(),
  }).passthrough(),
]);

export const RunnerControlFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("response"),
    correlationId,
    result: RunnerControlResultSchema,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("input_response"),
    correlationId,
    answers: jsonRecord,
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("tool_approval_response"),
    correlationId,
    decision: z.enum(["approved", "rejected"]),
    options: z.object({
      message: z.string().optional(),
      alwaysApprove: z.boolean().optional(),
      alwaysReject: z.boolean().optional(),
    }).passthrough().optional(),
  }).passthrough(),
]);

export const RunnerFrameSchema = z.union([
  RunnerCommandFrameSchema,
  RunnerEventFrameSchema,
  RunnerControlFrameSchema,
]);

export type RunnerExecuteParams = z.infer<typeof RunnerExecuteParamsSchema>;
export type RunnerCommandFrame = z.infer<typeof RunnerCommandFrameSchema>;
export type RunnerEventFrame = z.infer<typeof RunnerEventFrameSchema>;
export type RunnerControlFrame = z.infer<typeof RunnerControlFrameSchema>;
export type RunnerFrame = z.infer<typeof RunnerFrameSchema>;

export function engineEventFrame(payload: Record<string, unknown>): RunnerEventFrame {
  return {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "engine_event",
    payload,
  };
}
