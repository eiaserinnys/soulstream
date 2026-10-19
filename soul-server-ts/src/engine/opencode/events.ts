import type { SSEEventPayload } from "../protocol.js";
import type { UsageSnapshotV1 } from "@soulstream/wire-schema";

interface OpenCodeRawUsage {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache_read: number | null;
  cache_write: number | null;
  total: number | null;
}

interface OpenCodeNormalizedUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
}

interface OpenCodeUsageContext {
  commandId: string;
  inputId: string | null;
  usageSnapshot: UsageSnapshotV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function addCounters(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

function stepUsage(part: OpenCodeEvent["part"]): OpenCodeRawUsage {
  const tokens = isRecord(part?.tokens) ? part.tokens : undefined;
  const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
  return {
    input: knownCounter(tokens?.input),
    output: knownCounter(tokens?.output),
    reasoning: knownCounter(tokens?.reasoning),
    cache_read: knownCounter(cache?.read),
    cache_write: knownCounter(cache?.write),
    total: knownCounter(tokens?.total),
  };
}

function sumStepCounters(steps: OpenCodeRawUsage[]): OpenCodeRawUsage | undefined {
  if (steps.length === 0) return undefined;
  const sum = (key: keyof OpenCodeRawUsage): number | null => {
    let total = 0;
    for (const step of steps) {
      const value = step[key];
      if (value === null) return null;
      total += value;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  };
  return {
    input: sum("input"),
    output: sum("output"),
    reasoning: sum("reasoning"),
    cache_read: sum("cache_read"),
    cache_write: sum("cache_write"),
    total: sum("total"),
  };
}

function normalizeUsage(rawUsage: OpenCodeRawUsage): OpenCodeNormalizedUsage {
  return {
    input_tokens: addCounters(rawUsage.input, rawUsage.cache_read),
    cached_input_tokens: rawUsage.cache_read,
    // OpenCode reports this counter, but its billing meaning is not established.
    cache_write_input_tokens: null,
    output_tokens: addCounters(rawUsage.output, rawUsage.reasoning),
    reasoning_output_tokens: rawUsage.reasoning,
  };
}

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    id?: string;
    messageID?: string;
    reason?: string;
    cost?: number;
    tokens?: {
      total?: unknown;
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
      cache?: { read?: unknown; write?: unknown };
    };
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
  private readonly usageStepIds = new Set<string>();
  private readonly usageSteps: OpenCodeRawUsage[] = [];
  private lastText: string | undefined;
  private pendingText: string | undefined;
  private turnCostUsd = 0;
  private sawStop = false;
  private failed = false;
  private finished = false;

  constructor(
    private readonly model: string,
    private readonly usageContext?: OpenCodeUsageContext,
  ) {}

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
      if (typeof part.id === "string" && part.id.length > 0
        && !this.usageStepIds.has(part.id)) {
        this.usageStepIds.add(part.id);
        this.usageSteps.push(stepUsage(part));
      }
      if (part.reason === "stop") this.sawStop = true;
    }
    return output;
  }

  fail(error: unknown): SSEEventPayload[] {
    if (this.finished || this.failed) return [];
    const pendingText = this.flushPendingText(Date.now() / 1000);
    this.failed = true;
    const usageFields = this.terminalUsageFields();
    return [...pendingText, {
      type: "error",
      fatal: true,
      message: errorMessage(error),
      model: this.model,
      timestamp: Date.now() / 1000,
      ...usageFields,
    }];
  }

  finish(
    exitCode: number | null,
    signal: string | null,
    expectedInterrupt = false,
  ): SSEEventPayload[] {
    if (this.finished || this.failed) return [];
    if (expectedInterrupt) {
      const pendingText = this.flushPendingText(Date.now() / 1000);
      this.finished = true;
      if (!this.usageContext) return pendingText;
      const usage = this.usageObservation();
      return usage ? [...pendingText, usage] : pendingText;
    }
    if (exitCode === 0 && signal === null && this.sawStop) {
      const timestamp = Date.now() / 1000;
      const pendingText = this.flushPendingText(timestamp);
      this.finished = true;
      const usageFields = this.terminalUsageFields();
      return [...pendingText, {
        type: "complete",
        status: "completed",
        ...(this.lastText !== undefined ? { result: this.lastText } : {}),
        model: this.model,
        turn_cost_usd: this.turnCostUsd,
        timestamp,
        ...usageFields,
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

  private rawUsage(): OpenCodeRawUsage | undefined {
    return sumStepCounters(this.usageSteps);
  }

  private terminalUsageFields(): Record<string, unknown> {
    const rawUsage = this.rawUsage();
    if (!rawUsage) return {};
    return {
      source: "opencode_step_finish",
      usage: normalizeUsage(rawUsage),
      raw_usage: rawUsage,
    };
  }

  private usageObservation(): SSEEventPayload | undefined {
    if (!this.usageContext) return undefined;
    const rawUsage = this.rawUsage();
    if (!rawUsage) return undefined;
    return {
      type: "usage_observation",
      schema_version: 1,
      timestamp: Date.now() / 1000,
      output_command_id: this.usageContext.commandId,
      input_id: this.usageContext.inputId,
      usage_snapshot: this.usageContext.usageSnapshot,
      model: null,
      usage_scope: "command_delta",
      accounting_key: this.usageContext.commandId,
      outcome: "interrupted",
      source: "opencode_step_finish",
      usage: normalizeUsage(rawUsage),
      raw_usage: rawUsage,
    };
  }
}
