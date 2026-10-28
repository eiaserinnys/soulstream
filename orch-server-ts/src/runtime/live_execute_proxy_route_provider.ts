// Over 500 lines on purpose: the execute proxy's new/resume paths, the shared attachment
// admission step and the error mapping stay together until the production admission
// callback lands (#245); splitting them earlier would only move the pieces apart.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { FastifyRequest } from "fastify";

import {
  ExecuteProxyRouteError,
  formatExecuteProxyRawEvent,
  formatExecuteProxySseFrame,
  type ExecuteProxyProvider,
  type ExecuteProxyRawEvent,
  type ExecuteProxyResult,
  type ExecuteProxyNewProviderRequest,
  type ExecuteProxyResumeProviderRequest,
} from "../execute/execute_proxy_routes.js";
import type { AdmittedAttachmentInput } from "../attachments/attachment_input_admission.js";
import type {
  CreateSessionNodeCommandPayload,
  InMemoryNodeRegistry,
} from "../node/registry.js";
import {
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
} from "../node/pending_commands.js";
import { apiErrorBody, mapNodeCommandError } from "../http/api_errors.js";
import {
  SessionCommandRouteError,
  type SessionCommandRouter,
} from "../session/session_command_router.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import type { InterveneNodeCommandPayload } from "../session/session_action_command_payloads.js";
import { SessionCreateNodeSelectionError } from "../session/session_create_node_selector.js";
import type {
  RuntimeSessionEvent,
  RuntimeSessionEventHub,
} from "./session_event_hub.js";
import { CREATE_ACK_ERROR_HTTP_STATUS } from "../session/session_command_routes.js";
import {
  ModelPresetAvailabilityError,
  type ModelPresetAvailabilityService,
} from "../model/model_preset_availability.js";

const EXECUTE_PROXY_KEEPALIVE_MS = 30_000;

/** The request is the only actor carrier; it is undefined when the provider is called directly. */
export type ExecuteAttachmentAdmission = (
  request: FastifyRequest | undefined,
  input: {
    sessionId: string;
    nodeId: string;
    attachmentIds?: string[];
    attachmentPaths?: string[];
  },
) => Promise<AdmittedAttachmentInput>;

export type LiveExecuteProxyRouteProviderOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly router: SessionCommandRouter;
  readonly bridge: SessionCommandTransportBridge;
  readonly sessionEventHub: RuntimeSessionEventHub;
  readonly timeoutMs?: number;
  readonly createSessionReconcileTimeoutMs?: number;
  readonly generateSessionId?: () => string;
  readonly admitAttachmentInput?: ExecuteAttachmentAdmission;
  readonly modelPresetAvailability?: Pick<
    ModelPresetAvailabilityService,
    "requireAvailable"
  > & Partial<Pick<ModelPresetAvailabilityService, "chooseUsablePreset">>;
};

export function createLiveExecuteProxyRouteProvider(
  options: LiveExecuteProxyRouteProviderOptions,
): ExecuteProxyProvider {
  const generateSessionId = options.generateSessionId ?? randomUUID;

  return {
    executeNew: async (payload, request) => {
      const agentSessionId = generateSessionId();
      const queue = new SessionEventQueue(
        options.sessionEventHub,
        agentSessionId,
      );
      try {
        let selected = options.router.selectNodeForCreate({
          nodeId: payload.nodeId,
          profileId: payload.profile,
          modelPresetId: payload.model_preset,
          legacyModelSpecified: (payload.model?.trim().length ?? 0) > 0,
        });
        if (
          payload.model_preset_fallbacks !== undefined
          && payload.model_preset_fallbacks.length > 0
          && options.modelPresetAvailability?.chooseUsablePreset !== undefined
        ) {
          const candidateIds = [...new Set([
            ...(selected.modelPresetId === undefined ? [] : [selected.modelPresetId]),
            ...payload.model_preset_fallbacks,
          ])];
          const chosenPresetId = options.modelPresetAvailability.chooseUsablePreset(
            selected.node.nodeId,
            candidateIds,
          );
          if (chosenPresetId !== selected.modelPresetId) {
            request?.log.info({
              nodeId: selected.node.nodeId,
              firstPresetId: selected.modelPresetId ?? null,
              chosenPresetId,
              skippedReason: "unavailable or weekly headroom below 1%",
            }, "Execute model preset fallback selected");
            selected = options.router.selectNodeForCreate({
              nodeId: selected.node.nodeId,
              profileId: selected.profileId,
              modelPresetId: chosenPresetId,
              legacyModelSpecified: (payload.model?.trim().length ?? 0) > 0,
            });
          }
        }
        if (selected.modelPresetId && options.modelPresetAvailability) {
          options.modelPresetAvailability.requireAvailable(
            selected.node.nodeId,
            selected.modelPresetId,
          );
        }
        const admitted = await admitExecuteAttachments(options, request, {
          sessionId: agentSessionId,
          resolveNodeId: () => selected.node.nodeId,
          attachmentIds: payload.attachment_ids,
          attachmentPaths: payload.attachment_paths,
        });
        const commandPayload = createSessionCommandPayload({
          payload,
          agentSessionId,
          backend: selected.backend,
          profileId: selected.profileId,
          modelPresetId: selected.modelPresetId,
          admitted,
        });
        const command = options.registry.createCommand(
          selected.node.nodeId,
          commandPayload,
          { timeoutMs: options.timeoutMs },
        );
        let result: NodeCommandResponse;
        try {
          result = await options.bridge.sendPendingCommand({
            node: selected.node,
            command,
          });
        } catch (error) {
          if (error instanceof PendingNodeCommandTimeoutError) {
            try {
              const reconciled = await options.router.waitForCreatedSession(
                agentSessionId,
                selected.node.nodeId,
                { timeoutMs: options.createSessionReconcileTimeoutMs },
              );
              if (reconciled) {
                return streamResult({
                  agentSessionId,
                  nodeId: selected.node.nodeId,
                  queue,
                });
              }
            } catch {
              // Preserve the command timeout when durable lookup is unavailable.
            }
          }
          throw error;
        }
        if (isCommandError(result)) {
          throw routeErrorFromAck(createAckStatus(result), result);
        }
        const actualSessionId = stringField(result.agentSessionId) ?? agentSessionId;
        return streamResult({
          agentSessionId: actualSessionId,
          nodeId: selected.node.nodeId,
          queue,
        });
      } catch (error) {
        queue.close();
        throw mapCommandError(error, createErrorStatus(error));
      }
    },
    executeResume: async (payload, request) => {
      const queue = new SessionEventQueue(
        options.sessionEventHub,
        payload.agent_session_id,
      );
      try {
        const admitted = await admitExecuteAttachments(options, request, {
          sessionId: payload.agent_session_id,
          resolveNodeId: async () =>
            (await options.router.requireNodeForExistingSession(payload.agent_session_id)).nodeId,
          attachmentIds: payload.attachment_ids,
          attachmentPaths: payload.attachment_paths,
        });
        const routed = await options.router.routeExistingSessionPendingCommand(
          interveneCommandPayload(payload, admitted),
          { timeoutMs: options.timeoutMs },
        );
        const result = await options.bridge.sendPendingCommand(routed);
        if (isCommandError(result)) {
          throw routeErrorFromAck(422, result);
        }
        return streamResult({
          agentSessionId: payload.agent_session_id,
          nodeId: routed.node.nodeId,
          queue,
        });
      } catch (error) {
        queue.close();
        throw mapCommandError(error, 422);
      }
    },
  };
}

/**
 * Admits attachment ids and paths against the node that will run the command.
 * Returns undefined when there is nothing to admit, or when only legacy paths
 * arrive without a callback, so those callers keep their current behavior.
 */
async function admitExecuteAttachments(
  options: LiveExecuteProxyRouteProviderOptions,
  request: FastifyRequest | undefined,
  input: {
    sessionId: string;
    /** Called only when the callback will run, so a 503 or a legacy path never looks up an owner. */
    resolveNodeId: () => string | Promise<string>;
    attachmentIds?: string[];
    attachmentPaths?: string[];
  },
): Promise<AdmittedAttachmentInput | undefined> {
  const attachmentIds = input.attachmentIds?.length ? input.attachmentIds : undefined;
  const attachmentPaths = input.attachmentPaths?.length ? input.attachmentPaths : undefined;
  if (attachmentIds === undefined && attachmentPaths === undefined) return undefined;
  if (options.admitAttachmentInput === undefined) {
    if (attachmentIds === undefined) return undefined;
    throw new ExecuteProxyRouteError(503, { error: {
      code: "ATTACHMENT_INPUT_UNAVAILABLE",
      message: "Attachment input is unavailable",
    } });
  }
  const nodeId = await input.resolveNodeId();
  try {
    return await options.admitAttachmentInput(request, {
      sessionId: input.sessionId,
      nodeId,
      ...(attachmentIds === undefined ? {} : { attachmentIds }),
      ...(attachmentPaths === undefined ? {} : { attachmentPaths }),
    });
  } catch (error) {
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (typeof code !== "string" || typeof statusCode !== "number") throw error;
    throw new ExecuteProxyRouteError(statusCode, { error: {
      code,
      message: error instanceof Error ? error.message : code,
    } });
  }
}

function streamResult(params: {
  agentSessionId: string;
  nodeId: string;
  queue: SessionEventQueue;
}): ExecuteProxyResult {
  return {
    body: Readable.from(streamExecuteProxyEvents(params)),
    contentType: "text/event-stream",
  };
}

async function* streamExecuteProxyEvents(params: {
  agentSessionId: string;
  nodeId: string;
  queue: SessionEventQueue;
}): AsyncGenerator<string> {
  try {
    yield formatExecuteProxySseFrame({
      event: "init",
      data: {
        type: "init",
        agent_session_id: params.agentSessionId,
        node_id: params.nodeId,
      },
    });

    while (true) {
      const next = await params.queue.next(EXECUTE_PROXY_KEEPALIVE_MS);
      if (next === "closed") return;
      if (next === "timeout") {
        yield ": keepalive\n\n";
        continue;
      }

      const raw = next.data as ExecuteProxyRawEvent;
      yield formatExecuteProxyRawEvent(raw);
      const eventType = eventTypeFromRawEvent(raw);
      if (eventType === "complete" || eventType === "error") return;
    }
  } finally {
    params.queue.close();
  }
}

function createSessionCommandPayload(params: {
  payload: ExecuteProxyNewProviderRequest;
  agentSessionId: string;
  backend: string;
  profileId: string;
  modelPresetId?: string;
  admitted?: AdmittedAttachmentInput;
}): CreateSessionNodeCommandPayload {
  const { payload, agentSessionId, backend, profileId, modelPresetId, admitted } = params;
  const command: CreateSessionNodeCommandPayload = {
    type: "create_session",
    agentSessionId,
    prompt: payload.prompt,
    profile: profileId,
    caller_info: payload.caller_info,
  };
  if (modelPresetId !== undefined) command.model_preset = modelPresetId;
  if (payload.allowed_tools !== undefined) command.allowed_tools = payload.allowed_tools;
  if (payload.disallowed_tools !== undefined) {
    command.disallowed_tools = payload.disallowed_tools;
  }
  if (payload.claude_permission_mode !== undefined) {
    command.claude_permission_mode = payload.claude_permission_mode;
  }
  if (payload.use_mcp !== undefined) command.use_mcp = payload.use_mcp;
  if (payload.folderId !== undefined) command.folderId = payload.folderId;
  if (payload.system_prompt !== undefined) command.systemPrompt = payload.system_prompt;
  if (payload.model !== undefined) command.model = payload.model;
  if (payload.reasoningEffort !== undefined) {
    // Forwarded for every backend. The node's TaskManager is the single
    // validator, so gating by backend here would silently drop a Claude
    // request's effort and re-introduce a second authority.
    command.reasoningEffort = payload.reasoningEffort;
  }
  if (payload.extra_context_items !== undefined) {
    command.extra_context_items = payload.extra_context_items;
  }
  if (payload.attachment_paths?.length) command.attachment_paths = payload.attachment_paths;
  if (admitted?.attachment_ids.length) command.attachment_ids = admitted.attachment_ids;
  if (admitted?.attachment_bindings.length) {
    command.attachment_bindings = admitted.attachment_bindings;
  }
  return command;
}

function interveneCommandPayload(
  payload: ExecuteProxyResumeProviderRequest,
  admitted?: AdmittedAttachmentInput,
): InterveneNodeCommandPayload {
  const command: InterveneNodeCommandPayload = {
    type: "intervene",
    agentSessionId: payload.agent_session_id,
    text: payload.prompt,
    user: "",
  };
  if (payload.attachment_paths !== undefined) {
    command.attachment_paths = payload.attachment_paths;
  }
  if (admitted?.attachment_ids.length) command.attachment_ids = admitted.attachment_ids;
  if (admitted?.attachment_bindings.length) {
    command.attachment_bindings = admitted.attachment_bindings;
  }
  if (payload.caller_info !== undefined) {
    command.caller_info = payload.caller_info;
  }
  if (payload.extra_context_items !== undefined) {
    command.extra_context_items = payload.extra_context_items;
  }
  if (payload.delivery_id !== undefined) command.delivery_id = payload.delivery_id;
  if (payload.delivery_intent !== undefined) {
    command.delivery_intent = payload.delivery_intent;
  }
  if (payload.source !== undefined) command.source = payload.source;
  if (payload.completion_id !== undefined) command.completion_id = payload.completion_id;
  if (payload.relation_key !== undefined) command.relation_key = payload.relation_key;
  if (payload.producer_terminal_revision !== undefined) {
    command.producer_terminal_revision = payload.producer_terminal_revision;
  }
  if (payload.parent_delivery_id !== undefined) {
    command.parent_delivery_id = payload.parent_delivery_id;
  }
  if (payload.caller_turn_id !== undefined) command.caller_turn_id = payload.caller_turn_id;
  if (payload.created_at !== undefined) command.created_at = payload.created_at;
  if (payload.delivery_attempt_token !== undefined) {
    command.delivery_attempt_token = payload.delivery_attempt_token;
  }
  return command;
}

function mapCommandError(error: unknown, ackErrorStatus: number): ExecuteProxyRouteError {
  if (error instanceof ExecuteProxyRouteError) return error;
  if (error instanceof ModelPresetAvailabilityError) {
    return new ExecuteProxyRouteError(error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  if (error instanceof SessionCreateNodeSelectionError) {
    return new ExecuteProxyRouteError(error.statusCode, error.message);
  }
  if (error instanceof SessionCommandRouteError) {
    return new ExecuteProxyRouteError(
      error.code === "SESSION_OWNER_MISSING" ? 404 : 503,
      {
        error: {
          code: error.code,
          message: error.message,
          agentSessionId: error.agentSessionId,
          nodeId: error.nodeId,
        },
      },
    );
  }
  const nodeCommandError = mapNodeCommandError(error);
  if (nodeCommandError?.kind === "rejected") {
    if (nodeCommandError.response !== undefined && isCommandError(nodeCommandError.response)) {
      return routeErrorFromAck(ackErrorStatus, nodeCommandError.response);
    }
    return new ExecuteProxyRouteError(nodeCommandError.statusCode, apiErrorBody({
      ...nodeCommandError.apiError,
      requestId: nodeCommandError.requestId,
    }));
  }
  if (nodeCommandError !== undefined) {
    return new ExecuteProxyRouteError(
      nodeCommandError.statusCode,
      apiErrorBody(nodeCommandError.apiError),
    );
  }
  return new ExecuteProxyRouteError(500, {
    error: {
      code: "EXECUTE_PROXY_PROVIDER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function routeErrorFromAck(
  statusCode: number,
  response: NodeCommandResponse,
): ExecuteProxyRouteError {
  return new ExecuteProxyRouteError(statusCode, {
    error: {
      code: stringField(response.code) ?? "NODE_COMMAND_FAILED",
      message: stringField(response.message) ?? "Node command failed",
    },
  });
}

function isCommandError(response: NodeCommandResponse): boolean {
  return response.type === "error" || response.status === "error";
}

function eventTypeFromRawEvent(raw: ExecuteProxyRawEvent): string {
  const payload = isRecord(raw.event)
    ? raw.event
    : isRecord(raw.payload)
      ? raw.payload
      : undefined;
  return typeof payload?.type === "string" ? payload.type : "message";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

class SessionEventQueue {
  private readonly buffered: RuntimeSessionEvent[] = [];
  private readonly unsubscribe: () => void;
  private pending:
    | ((value: RuntimeSessionEvent | "timeout" | "closed") => void)
    | undefined;
  private closed = false;

  constructor(hub: RuntimeSessionEventHub, agentSessionId: string) {
    this.unsubscribe = hub.subscribe(agentSessionId, (event) => {
      if (this.closed) return;
      const pending = this.pending;
      if (pending !== undefined) {
        this.pending = undefined;
        pending(event);
        return;
      }
      this.buffered.push(event);
    });
  }

  async next(timeoutMs: number): Promise<RuntimeSessionEvent | "timeout" | "closed"> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return buffered;
    if (this.closed) return "closed";

    return await new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const complete = (value: RuntimeSessionEvent | "timeout" | "closed") => {
        if (this.pending === complete) this.pending = undefined;
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        complete(this.closed ? "closed" : "timeout");
      }, timeoutMs);
      this.pending = complete;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    const pending = this.pending;
    if (pending !== undefined) {
      this.pending = undefined;
      pending("closed");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Create-path input errors are the caller's problem, not an unavailable node.
 * Everything else keeps the historical 503 so timeouts and offline nodes stay
 * distinguishable from a bad request. The status table is the one owned by the
 * REST create route — a second copy would drift.
 */
function createStatusForCode(code: unknown): number {
  return typeof code === "string" && Object.hasOwn(CREATE_ACK_ERROR_HTTP_STATUS, code)
    ? CREATE_ACK_ERROR_HTTP_STATUS[code] ?? 503
    : 503;
}

function createAckStatus(result: NodeCommandResponse): number {
  return createStatusForCode((result as { code?: unknown }).code);
}

function createErrorStatus(error: unknown): number {
  return createStatusForCode(
    (error as { response?: { code?: unknown } } | undefined)?.response?.code,
  );
}
