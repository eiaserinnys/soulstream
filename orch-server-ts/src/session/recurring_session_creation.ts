import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
} from "../node/pending_commands.js";
import type { CreateSessionNodeCommandPayload } from "../node/registry_types.js";
import type { ModelPresetAvailabilityService } from "../model/model_preset_availability.js";
import type { RecurringSessionLaunchResult } from "../recurring-jobs/types.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "./session_command_transport.js";
import type { SessionCommandRouter } from "./session_command_router.js";

export type RecurringSessionCreateCoreOptions = {
  readonly router: SessionCommandRouter;
  readonly bridge: SessionCommandTransportBridge;
  readonly modelPresetAvailability?: Pick<ModelPresetAvailabilityService, "requireAvailable">;
  readonly timeoutMs?: number;
  readonly reconcileTimeoutMs?: number;
};

export type CreateRecurringSessionInput = {
  readonly sessionId: string;
  readonly prompt: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly modelPreset: string | null;
  readonly folderId: string;
  readonly container: { readonly kind: "folder" | "task"; readonly id: string };
  readonly callerInfo: Readonly<Record<string, unknown>>;
};

export class RecurringSessionCreateError extends Error {
  constructor(
    readonly code: "INVALID_STABLE_SESSION_ID" | "NODE_REJECTED",
    message: string,
    readonly dispatchPhase: "before_send" | "after_send",
  ) {
    super(message);
    this.name = "RecurringSessionCreateError";
  }
}

/**
 * Explicit scheduler-facing create core. It deliberately accepts the run's
 * already persisted v4 ID and never falls through to the HTTP route's random
 * ID or page-anchor special case.
 */
export async function createRecurringSession(
  options: RecurringSessionCreateCoreOptions,
  input: CreateRecurringSessionInput,
): Promise<RecurringSessionLaunchResult> {
  if (!isUuidV4(input.sessionId)) {
    throw new RecurringSessionCreateError(
      "INVALID_STABLE_SESSION_ID",
      "Recurring run session_id must be a UUID v4.",
      "before_send",
    );
  }
  const command: CreateSessionNodeCommandPayload = {
    type: "create_session",
    agentSessionId: input.sessionId,
    prompt: input.prompt,
    nodeId: input.nodeId,
    profile: input.agentId,
    ...(input.modelPreset === null ? {} : { model_preset: input.modelPreset }),
    folderId: input.folderId,
    container: input.container,
    caller_info: { ...input.callerInfo },
  };
  const routed = options.router.createSession(command, {
    timeoutMs: options.timeoutMs,
    beforeCreateCommand: (selection) => {
      if (selection.modelPresetId && options.modelPresetAvailability) {
        options.modelPresetAvailability.requireAvailable(selection.node.nodeId, selection.modelPresetId);
      }
    },
  });
  try {
    const response = await options.bridge.sendPendingCommand(routed);
    if (isErrorAck(response)) {
      throw new RecurringSessionCreateError(
        "NODE_REJECTED",
        responseMessage(response, "Node rejected create_session."),
        "after_send",
      );
    }
    if (typeof response.agentSessionId === "string" && response.agentSessionId !== input.sessionId) {
      return await reconcileUncertainCreate(options, input.sessionId, routed.node.nodeId, routed.modelPresetId);
    }
    const observed = await options.router.waitForCreatedSession(
      input.sessionId,
      routed.node.nodeId,
      { timeoutMs: 0 },
    );
    return {
      state: observed ? "running" : "awaiting_session",
      resolvedModelPreset: routed.modelPresetId ?? null,
    };
  } catch (error) {
    if (error instanceof RecurringSessionCreateError) throw error;
    if (isConfirmedNodeRejection(error)) {
      throw new RecurringSessionCreateError(
        "NODE_REJECTED",
        responseMessage(error.response, "Node rejected create_session."),
        "after_send",
      );
    }
    if (isUncertainCreateFailure(error)) {
      return await reconcileUncertainCreate(options, input.sessionId, routed.node.nodeId, routed.modelPresetId);
    }
    throw error;
  }
}

async function reconcileUncertainCreate(
  options: RecurringSessionCreateCoreOptions,
  sessionId: string,
  nodeId: string,
  resolvedModelPreset: string | null | undefined,
): Promise<RecurringSessionLaunchResult> {
  const observed = await reconcileTimeout(options, sessionId, nodeId);
  return {
    state: observed ? "running" : "awaiting_session",
    resolvedModelPreset: resolvedModelPreset ?? null,
  };
}

async function reconcileTimeout(
  options: RecurringSessionCreateCoreOptions,
  sessionId: string,
  nodeId: string,
): Promise<boolean> {
  try {
    return await options.router.waitForCreatedSession(sessionId, nodeId, {
      timeoutMs: options.reconcileTimeoutMs ?? 5_000,
    });
  } catch {
    // The durable recurring reconciler owns follow-up lookup. This narrow
    // timeout recheck cannot turn an uncertain send into another send.
    return false;
  }
}

function isErrorAck(response: NodeCommandResponse): boolean {
  return response.type === "error" || response.status === "error";
}

function isConfirmedNodeRejection(
  error: unknown,
): error is PendingNodeCommandRejectedError & { readonly response: NodeCommandResponse } {
  return error instanceof PendingNodeCommandRejectedError &&
    error.response !== undefined && isErrorAck(error.response);
}

function isUncertainCreateFailure(error: unknown): boolean {
  if (error instanceof PendingNodeCommandTimeoutError) return true;
  if (error instanceof PendingNodeCommandRejectedError) return error.response === undefined;
  return error instanceof NodeCommandTransportError && error.code === "TRANSPORT_SEND_FAILED";
}

function responseMessage(response: NodeCommandResponse, fallback: string): string {
  return typeof response.message === "string" && response.message.trim()
    ? response.message
    : fallback;
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
