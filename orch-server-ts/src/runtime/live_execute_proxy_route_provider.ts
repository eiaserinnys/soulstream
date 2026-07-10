import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

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
import type {
  CreateSessionNodeCommandPayload,
  InMemoryNodeRegistry,
} from "../node/registry.js";
import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
} from "../node/pending_commands.js";
import {
  SessionCommandRouteError,
  type SessionCommandRouter,
} from "../session/session_command_router.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "../session/session_command_transport.js";
import type { InterveneNodeCommandPayload } from "../session/session_action_command_payloads.js";
import {
  SessionCreateNodeSelectionError,
  selectNodeForSessionCreate,
} from "../session/session_create_node_selector.js";
import type {
  RuntimeSessionEvent,
  RuntimeSessionEventHub,
} from "./session_event_hub.js";

const EXECUTE_PROXY_KEEPALIVE_MS = 30_000;

export type LiveExecuteProxyRouteProviderOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly router: SessionCommandRouter;
  readonly bridge: SessionCommandTransportBridge;
  readonly sessionEventHub: RuntimeSessionEventHub;
  readonly timeoutMs?: number;
  readonly generateSessionId?: () => string;
};

export function createLiveExecuteProxyRouteProvider(
  options: LiveExecuteProxyRouteProviderOptions,
): ExecuteProxyProvider {
  const generateSessionId = options.generateSessionId ?? randomUUID;

  return {
    executeNew: async (payload) => {
      const agentSessionId = generateSessionId();
      const queue = new SessionEventQueue(
        options.sessionEventHub,
        agentSessionId,
      );
      try {
        const selected = selectNodeForSessionCreate(options.registry, {
          nodeId: payload.nodeId,
          profileId: payload.profile,
        });
        const commandPayload = createSessionCommandPayload({
          payload,
          agentSessionId,
          backend: selected.backend,
        });
        const command = options.registry.createCommand(
          selected.node.nodeId,
          commandPayload,
          { timeoutMs: options.timeoutMs },
        );
        const result = await options.bridge.sendPendingCommand({
          node: selected.node,
          command,
        });
        if (isCommandError(result)) {
          throw routeErrorFromAck(503, result);
        }
        const actualSessionId = stringField(result.agentSessionId) ?? agentSessionId;
        return streamResult({
          agentSessionId: actualSessionId,
          nodeId: selected.node.nodeId,
          queue,
        });
      } catch (error) {
        queue.close();
        throw mapCommandError(error, 503);
      }
    },
    executeResume: async (payload) => {
      const queue = new SessionEventQueue(
        options.sessionEventHub,
        payload.agent_session_id,
      );
      try {
        const routed = options.router.routeExistingSessionPendingCommand(
          interveneCommandPayload(payload),
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
}): CreateSessionNodeCommandPayload {
  const { payload, agentSessionId, backend } = params;
  const command: CreateSessionNodeCommandPayload = {
    type: "create_session",
    agentSessionId,
    prompt: payload.prompt,
    profile: payload.profile,
    caller_info: payload.caller_info,
  };
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
  if (backend === "codex" && payload.reasoningEffort !== undefined) {
    command.reasoningEffort = payload.reasoningEffort;
  }
  if (payload.extra_context_items !== undefined) {
    command.extra_context_items = payload.extra_context_items;
  }
  return command;
}

function interveneCommandPayload(
  payload: ExecuteProxyResumeProviderRequest,
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
  if (payload.caller_info !== undefined) {
    command.caller_info = payload.caller_info;
  }
  if (payload.extra_context_items !== undefined) {
    command.extra_context_items = payload.extra_context_items;
  }
  return command;
}

function mapCommandError(error: unknown, ackErrorStatus: number): ExecuteProxyRouteError {
  if (error instanceof ExecuteProxyRouteError) return error;
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
  if (error instanceof NodeCommandTransportError) {
    return new ExecuteProxyRouteError(503, {
      error: {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId,
        connectionId: error.connectionId,
      },
    });
  }
  if (error instanceof PendingNodeCommandTimeoutError) {
    return new ExecuteProxyRouteError(503, {
      error: {
        code: "NODE_COMMAND_TIMEOUT",
        message: error.message,
        requestId: error.requestId,
      },
    });
  }
  if (error instanceof PendingNodeCommandRejectedError) {
    if (error.response !== undefined && isCommandError(error.response)) {
      return routeErrorFromAck(ackErrorStatus, error.response);
    }
    return new ExecuteProxyRouteError(503, {
      error: {
        code: "NODE_COMMAND_REJECTED",
        message: error.message,
        requestId: error.requestId,
      },
    });
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
