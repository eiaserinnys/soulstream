import type { SSEEventPayload } from "../protocol.js";

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    reason?: string;
    cost?: number;
    synthetic?: boolean;
    metadata?: { compaction_continue?: boolean };
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };
  };
  error?: unknown;
}

export function parseOpenCodeEvent(line: string): OpenCodeEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("type" in value)
    || typeof value.type !== "string") {
    throw new Error("Invalid OpenCode event envelope");
  }
  return value as OpenCodeEvent;
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const data = "data" in value ? value.data : undefined;
    if (data && typeof data === "object" && "message" in data
      && typeof data.message === "string") return data.message;
    if ("message" in value && typeof value.message === "string") return value.message;
  }
  return "OpenCode reported an error";
}

/** Maps completed OpenCode parts into the existing runner event contract. */
export class OpenCodeEventMapper {
  private sessionId: string | undefined;
  private readonly toolCalls = new Set<string>();
  private lastText: string | undefined;
  private pendingText: string | undefined;
  private turnCostUsd = 0;
  private sawStop = false;
  private failed = false;
  private finished = false;

  constructor(private readonly model: string) {}

  accept(event: OpenCodeEvent): SSEEventPayload[] {
    if (this.finished || this.failed) return [];
    const output: SSEEventPayload[] = [];
    const timestamp = Date.now() / 1000;
    if (event.sessionID && !this.sessionId) {
      this.sessionId = event.sessionID;
      output.push({ type: "session", session_id: event.sessionID, model: this.model, timestamp });
    }

    if (event.type === "error") {
      return [...output, ...this.fail(errorMessage(event.error))];
    }

    const part = event.part;
    if (event.type === "text" && part?.type === "text" && typeof part.text === "string") {
      if (part.synthetic === true) {
        if (part.metadata?.compaction_continue === true) this.pendingText = undefined;
        return output;
      }
      output.push(...this.flushPendingText(timestamp));
      this.pendingText = part.text;
      return output;
    }

    if (event.type === "tool_use") output.push(...this.flushPendingText(timestamp));

    if (event.type === "tool_use" && part?.type === "tool" && part.state
      && (part.state.status === "completed" || part.state.status === "error")
      && typeof part.callID === "string" && typeof part.tool === "string"
      && !this.toolCalls.has(part.callID)) {
      this.toolCalls.add(part.callID);
      output.push({
        type: "tool_start",
        tool_use_id: part.callID,
        tool_name: part.tool,
        ...(part.state.input !== undefined ? { tool_input: part.state.input } : {}),
        timestamp,
      });
      const isError = part.state.status === "error";
      output.push({
        type: "tool_result",
        tool_use_id: part.callID,
        tool_name: part.tool,
        ...(part.state.output !== undefined
          ? { result: part.state.output }
          : part.state.error !== undefined ? { result: part.state.error } : {}),
        is_error: isError,
        timestamp,
      });
      return output;
    }

    if (event.type === "step_finish" && part?.type === "step-finish"
      && typeof part.reason === "string") {
      if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
        this.turnCostUsd += part.cost;
      }
      if (part.reason === "stop") this.sawStop = true;
    }
    return output;
  }

  fail(error: unknown): SSEEventPayload[] {
    if (this.finished || this.failed) return [];
    const pendingText = this.flushPendingText(Date.now() / 1000);
    this.failed = true;
    return [...pendingText, {
      type: "error",
      fatal: true,
      message: errorMessage(error),
      model: this.model,
      timestamp: Date.now() / 1000,
    }];
  }

  finish(
    exitCode: number | null,
    signal: string | null,
    expectedInterrupt = false,
  ): SSEEventPayload[] {
    if (this.finished || this.failed) return [];
    if (expectedInterrupt) {
      this.finished = true;
      return [];
    }
    if (exitCode === 0 && signal === null && this.sawStop) {
      const timestamp = Date.now() / 1000;
      const pendingText = this.flushPendingText(timestamp);
      this.finished = true;
      return [...pendingText, {
        type: "complete",
        status: "completed",
        ...(this.lastText !== undefined ? { result: this.lastText } : {}),
        model: this.model,
        turn_cost_usd: this.turnCostUsd,
        timestamp,
      }];
    }
    const reason = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`;
    return this.fail(this.sawStop
      ? `OpenCode exited with ${reason}`
      : `OpenCode ended without a stop event (${reason})`);
  }

  private flushPendingText(timestamp: number): SSEEventPayload[] {
    if (this.pendingText === undefined) return [];
    const content = this.pendingText;
    this.pendingText = undefined;
    this.lastText = content;
    return [{ type: "assistant_message", content, model: this.model, timestamp }];
  }
}
