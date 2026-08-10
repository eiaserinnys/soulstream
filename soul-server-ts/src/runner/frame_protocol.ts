import { z } from "zod";
import {
  withRunnerJsonContract as withJsonContract,
} from "./runner_json_contract.js";

export { assertRunnerJsonValue } from "./runner_json_contract.js";

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

export const RunnerExecuteParamsSchema = withJsonContract(z.object({
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
  scheduleToolUseEnabled: z.boolean().optional(),
}).passthrough());

export const RunnerCommandFrameSchema = withJsonContract(z.discriminatedUnion("kind", [
  z.object({
    protocolVersion,
    channel: z.literal("command"),
    kind: z.literal("prepare_session"),
    commandId: correlationId,
    agentSessionId: z.string().min(1),
  }).passthrough(),
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
  z.object({
    protocolVersion,
    channel: z.literal("command"),
    kind: z.literal("invoke"),
    commandId: correlationId,
    capability: z.string().min(1),
    args: z.array(z.json()),
  }).passthrough(),
]));

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

const RunnerEngineEventMetadataSchema = z.object({
  claudeBackgroundProvenance: z.enum([
    "sdk_membership",
    "explicit_background_tool_result",
    "runtime_close",
  ]).optional(),
  claudeBackgroundDelivery: z.object({
    deliveryId: z.string(),
    completionId: z.string(),
    relationKey: z.string(),
    producerTerminalRevision: z.string(),
    deliveryCreatedAt: z.string(),
    source: z.string(),
    storedPayload: jsonRecord,
    storedPayloadHash: z.string(),
  }).passthrough().optional(),
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
  z.object({
    kind: z.literal("host_call"),
    service: z.enum([
      "session_store",
      "claude_runtime",
      "detached_event",
      "snapshot",
    ]),
    operation: z.string().min(1),
    args: z.array(z.json()),
  }).passthrough(),
]);

export const RunnerEventFrameSchema = withJsonContract(z.discriminatedUnion("kind", [
  z.object({
    protocolVersion,
    channel: z.literal("event"),
    kind: z.literal("engine_event"),
    payload: jsonRecord,
    metadata: RunnerEngineEventMetadataSchema.optional(),
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
    timeoutMs: z.number().int().positive().optional(),
    request: RunnerRequestSchema,
  }).passthrough(),
]));

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

export const RunnerControlFrameSchema = withJsonContract(z.discriminatedUnion("kind", [
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("command_result"),
    commandId: correlationId,
    result: RunnerControlResultSchema,
  }).passthrough(),
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
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("execution_ended"),
    commandId: correlationId,
    error: z.object({
      code: z.string().min(1),
      message: z.string(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("outbox_available"),
    sourceSeq: z.number().int().positive(),
  }).passthrough(),
  z.object({
    protocolVersion,
    channel: z.literal("control"),
    kind: z.literal("host_frame_applied"),
    frameSeq: z.number().int().positive(),
  }).passthrough(),
]));

export const RunnerFrameSchema = z.union([
  RunnerCommandFrameSchema,
  RunnerEventFrameSchema,
  RunnerControlFrameSchema,
]);

export type RunnerExecuteParams = z.infer<typeof RunnerExecuteParamsSchema>;
export type RunnerCommandFrame = z.infer<typeof RunnerCommandFrameSchema>;
export type RunnerEventFrame = z.infer<typeof RunnerEventFrameSchema>;
export type RunnerControlFrame = z.infer<typeof RunnerControlFrameSchema>;
export type RunnerCommandResultFrame = Extract<RunnerControlFrame, { kind: "command_result" }>;
export type RunnerFrame = z.infer<typeof RunnerFrameSchema>;

export function parseRunnerCommandJsonRoundTrip(value: unknown): RunnerCommandFrame {
  const parsed = RunnerCommandFrameSchema.parse(value);
  return RunnerCommandFrameSchema.parse(JSON.parse(JSON.stringify(parsed)));
}

export function engineEventFrame(
  payload: unknown,
  metadata?: unknown,
): Extract<RunnerEventFrame, { kind: "engine_event" }> {
  return RunnerEventFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "engine_event",
    payload,
    ...(metadata !== undefined ? { metadata } : {}),
  }) as Extract<RunnerEventFrame, { kind: "engine_event" }>;
}

export function runStateSnapshotFrame(
  snapshot: unknown,
): Extract<RunnerEventFrame, { kind: "run_state_snapshot" }> {
  return RunnerEventFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "run_state_snapshot",
    snapshot,
  }) as Extract<RunnerEventFrame, { kind: "run_state_snapshot" }>;
}

export function sessionItemsSnapshotFrame(
  snapshot: unknown,
): Extract<RunnerEventFrame, { kind: "session_items_snapshot" }> {
  return RunnerEventFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "session_items_snapshot",
    snapshot,
  }) as Extract<RunnerEventFrame, { kind: "session_items_snapshot" }>;
}

export function runnerRequestFrame(
  correlationId: string,
  request: unknown,
  options: { timeoutMs?: number } = {},
): Extract<RunnerEventFrame, { kind: "request" }> {
  return RunnerEventFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "request",
    correlationId,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    request,
  }) as Extract<RunnerEventFrame, { kind: "request" }>;
}

export function runnerControlResponseFrame(
  correlationId: string,
  result: unknown,
): Extract<RunnerControlFrame, { kind: "response" }> {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "response",
    correlationId,
    result,
  }) as Extract<RunnerControlFrame, { kind: "response" }>;
}

export function prepareSessionCommandFrame(
  commandId: string,
  agentSessionId: string,
): Extract<RunnerCommandFrame, { kind: "prepare_session" }> {
  return RunnerCommandFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "prepare_session",
    commandId,
    agentSessionId,
  }) as Extract<RunnerCommandFrame, { kind: "prepare_session" }>;
}

export function executeCommandFrame(
  commandId: string,
  params: unknown,
): Extract<RunnerCommandFrame, { kind: "execute" }> {
  return RunnerCommandFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "execute",
    commandId,
    params,
  }) as Extract<RunnerCommandFrame, { kind: "execute" }>;
}

export function interruptCommandFrame(
  commandId: string,
): Extract<RunnerCommandFrame, { kind: "interrupt" }> {
  return RunnerCommandFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "interrupt",
    commandId,
  }) as Extract<RunnerCommandFrame, { kind: "interrupt" }>;
}

export function closeCommandFrame(
  commandId: string,
): Extract<RunnerCommandFrame, { kind: "close" }> {
  return RunnerCommandFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "close",
    commandId,
  }) as Extract<RunnerCommandFrame, { kind: "close" }>;
}

export function invokeCommandFrame(
  commandId: string,
  capability: string,
  args: unknown[],
): Extract<RunnerCommandFrame, { kind: "invoke" }> {
  return RunnerCommandFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "invoke",
    commandId,
    capability,
    args,
  }) as Extract<RunnerCommandFrame, { kind: "invoke" }>;
}

export function executionEndedControlFrame(
  commandId: string,
  error?: { code: string; message: string },
): Extract<RunnerControlFrame, { kind: "execution_ended" }> {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "execution_ended",
    commandId,
    ...(error ? { error } : {}),
  }) as Extract<RunnerControlFrame, { kind: "execution_ended" }>;
}

export function outboxAvailableControlFrame(
  sourceSeq: number,
): Extract<RunnerControlFrame, { kind: "outbox_available" }> {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "outbox_available",
    sourceSeq,
  }) as Extract<RunnerControlFrame, { kind: "outbox_available" }>;
}

export function hostFrameAppliedControlFrame(
  frameSeq: number,
): Extract<RunnerControlFrame, { kind: "host_frame_applied" }> {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "host_frame_applied",
    frameSeq,
  }) as Extract<RunnerControlFrame, { kind: "host_frame_applied" }>;
}

export function runnerCommandResultFrame(
  commandId: string,
  result: unknown,
): RunnerCommandResultFrame {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "command_result",
    commandId,
    result,
  }) as RunnerCommandResultFrame;
}

export function inputResponseControlFrame(
  correlationId: string,
  answers: unknown,
): Extract<RunnerControlFrame, { kind: "input_response" }> {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "input_response",
    correlationId,
    answers,
  }) as Extract<RunnerControlFrame, { kind: "input_response" }>;
}

export function toolApprovalControlFrame(
  correlationId: string,
  decision: "approved" | "rejected",
  options?: unknown,
): Extract<RunnerControlFrame, { kind: "tool_approval_response" }> {
  return RunnerControlFrameSchema.parse({
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "tool_approval_response",
    correlationId,
    decision,
    ...(options !== undefined ? { options } : {}),
  }) as Extract<RunnerControlFrame, { kind: "tool_approval_response" }>;
}
