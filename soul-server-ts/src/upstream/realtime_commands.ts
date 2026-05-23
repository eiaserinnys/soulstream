import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import {
  buildRealtimeCallCreatedAck,
  buildRealtimeEventAck,
  buildRealtimeToolApprovalAck,
  type RealtimeAckType,
  type RealtimeCallCreatedAck,
  type RealtimeEventAck,
  type RealtimeToolApprovalAck,
} from "./realtime_ack.js";

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

export interface RealtimeCreateCallCommand extends CommandLike {
  type: "realtime_create_call";
  agentSessionId?: string;
  session_id?: string;
  offerSdp?: string;
  offer_sdp?: string;
  model?: string | null;
  voice?: string | null;
  instructions?: string | null;
}

export interface RealtimeEventCommand extends CommandLike {
  type: "realtime_event";
  agentSessionId?: string;
  session_id?: string;
  event?: unknown;
  callId?: string | null;
  call_id?: string | null;
}

export interface RealtimeResolveToolApprovalCommand extends CommandLike {
  type: "realtime_resolve_tool_approval";
  agentSessionId?: string;
  session_id?: string;
  approvalId?: string;
  approval_id?: string;
  decision?: "approved" | "rejected";
  message?: string;
  source?: "tap" | "voice";
  callId?: string | null;
  call_id?: string | null;
}

export type RealtimeCommandAck =
  | RealtimeCallCreatedAck
  | RealtimeEventAck
  | RealtimeToolApprovalAck;

type RealtimeBrokerBoundary = Pick<
  RealtimeBroker,
  "createCall" | "relayEvent" | "resolveToolApproval"
>;

export class RealtimeCommandError extends Error {
  constructor(
    readonly ackType: RealtimeAckType,
    readonly requestId: string,
    readonly agentSessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeCommandError";
  }
}

/**
 * Owns upstream realtime command semantics.
 *
 * RealtimeBroker owns realtime domain policy and realtime_ack owns broker-result
 * to wire ACK mapping. This boundary owns the command adaptation between them:
 * broker availability, field validation, id normalization, source/call metadata
 * mapping, broker calls, and broker-error conversion to realtime ACK metadata.
 */
export class RealtimeCommands {
  constructor(private readonly broker: RealtimeBrokerBoundary | undefined) {}

  async createCall(
    cmd: RealtimeCreateCallCommand,
  ): Promise<RealtimeCallCreatedAck | null> {
    const requestId = commandRequestId(cmd);
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    const offerSdp = cmd.offerSdp ?? cmd.offer_sdp ?? "";

    const broker = this.getBroker("realtime_call_created", requestId, sessionId);
    if (!sessionId || !offerSdp) {
      throw new RealtimeCommandError(
        "realtime_call_created",
        requestId,
        sessionId,
        "realtime_create_call requires agentSessionId and offerSdp",
      );
    }

    try {
      const result = await broker.createCall({
        agentSessionId: sessionId,
        offerSdp,
        ...(cmd.model !== undefined ? { model: cmd.model } : {}),
        ...(cmd.voice !== undefined ? { voice: cmd.voice } : {}),
        ...(cmd.instructions !== undefined ? { instructions: cmd.instructions } : {}),
      });
      if (!requestId) return null;
      return buildRealtimeCallCreatedAck({
        requestId,
        agentSessionId: sessionId,
        result,
      });
    } catch (err) {
      throw this.wrapBrokerError(
        "realtime_call_created",
        requestId,
        sessionId,
        err,
      );
    }
  }

  async relayEvent(cmd: RealtimeEventCommand): Promise<RealtimeEventAck | null> {
    const requestId = commandRequestId(cmd);
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";

    const broker = this.getBroker("realtime_event_ack", requestId, sessionId);
    if (!sessionId || cmd.event === undefined) {
      throw new RealtimeCommandError(
        "realtime_event_ack",
        requestId,
        sessionId,
        "realtime_event requires agentSessionId and event",
      );
    }

    try {
      const result = await broker.relayEvent({
        agentSessionId: sessionId,
        event: cmd.event,
        callId: cmd.callId ?? cmd.call_id ?? undefined,
      });
      if (!requestId) return null;
      return buildRealtimeEventAck({
        requestId,
        agentSessionId: sessionId,
        result,
      });
    } catch (err) {
      throw this.wrapBrokerError(
        "realtime_event_ack",
        requestId,
        sessionId,
        err,
      );
    }
  }

  async resolveToolApproval(
    cmd: RealtimeResolveToolApprovalCommand,
  ): Promise<RealtimeToolApprovalAck | null> {
    const requestId = commandRequestId(cmd);
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    const approvalId = cmd.approvalId ?? cmd.approval_id ?? "";
    const decision = cmd.decision;

    const broker = this.getBroker(
      "realtime_tool_approval_ack",
      requestId,
      sessionId,
    );
    if (!sessionId || !approvalId || (decision !== "approved" && decision !== "rejected")) {
      throw new RealtimeCommandError(
        "realtime_tool_approval_ack",
        requestId,
        sessionId,
        "realtime_resolve_tool_approval requires agentSessionId, approvalId, and decision",
      );
    }

    try {
      const result = await broker.resolveToolApproval({
        agentSessionId: sessionId,
        approvalId,
        decision,
        ...(cmd.message ? { message: cmd.message } : {}),
        ...(cmd.source ? { source: cmd.source } : {}),
        callId: cmd.callId ?? cmd.call_id ?? undefined,
      });
      if (!requestId) return null;
      return buildRealtimeToolApprovalAck({
        requestId,
        agentSessionId: sessionId,
        approvalId,
        decision,
        result,
      });
    } catch (err) {
      throw this.wrapBrokerError(
        "realtime_tool_approval_ack",
        requestId,
        sessionId,
        err,
      );
    }
  }

  private getBroker(
    ackType: RealtimeAckType,
    requestId: string,
    agentSessionId: string,
  ): RealtimeBrokerBoundary {
    if (this.broker) return this.broker;
    throw new RealtimeCommandError(
      ackType,
      requestId,
      agentSessionId,
      "Realtime broker is not configured in soul-server-ts",
    );
  }

  private wrapBrokerError(
    ackType: RealtimeAckType,
    requestId: string,
    agentSessionId: string,
    err: unknown,
  ): RealtimeCommandError {
    return new RealtimeCommandError(
      ackType,
      requestId,
      agentSessionId,
      stringifyError(err),
    );
  }
}

function commandRequestId(cmd: CommandLike): string {
  return cmd.requestId ?? cmd.request_id ?? "";
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
