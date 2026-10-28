import type { SSEEventPayload } from "../protocol.js";
import { ANTIGRAVITY_QUOTA_ERROR_CODE } from "../usage_limit_stop.js";

export interface AntigravityUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}
export interface AntigravityEvent {
  event: string;
  conversation_id?: string;
  init?: { model?: string };
  step_update?: {
    conversation_id: string; step_index: number; state: string; step_type: string;
    text_delta?: string;
    tool_info?: { name: string; parameters?: unknown; output?: unknown; error?: unknown };
    usage?: Record<string, number>;
  };
  result?: { status: string; response?: string; error?: string; usage?: Record<string, number> };
}
export interface AntigravityExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  forcedAfterResult?: boolean;
}

export function parseAntigravityEvent(line: string): AntigravityEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("event" in value) || typeof value.event !== "string") {
    throw new Error("Invalid Antigravity event envelope");
  }
  return value as AntigravityEvent;
}

export function addAntigravityUsage(
  left: AntigravityUsage | undefined, right: AntigravityUsage | undefined,
): AntigravityUsage | undefined {
  if (!left) return right && { ...right };
  if (!right) return { ...left };
  return { input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens };
}

/** One mapper per process. Only model DONE steps contribute; result usage is cumulative. */
export class AntigravityEventMapper {
  usage: AntigravityUsage | undefined;
  model: string | undefined;
  private result: AntigravityEvent["result"];
  private readonly counted = new Set<number>();
  private readonly calls = new Set<number>();
  private readonly finishedTools = new Set<number>();
  private readonly text = new Map<number, string>();
  private completedResponse: string | undefined;
  private sawErrorMessage = false;

  constructor(private readonly turnId: string, private readonly resuming = false) {}

  accept(raw: AntigravityEvent): SSEEventPayload[] {
    const timestamp = Date.now() / 1000;
    if (raw.event === "init" && raw.conversation_id !== undefined) {
      this.model = raw.init?.model;
      return [{ type: "session", session_id: raw.conversation_id, ...(this.model ? { model: this.model } : {}), timestamp }];
    }
    if (raw.event === "result") { this.result = raw.result; return []; }
    const step = raw.step_update;
    if (raw.event !== "step_update" || !step) return [];
    if (step.step_type === "error_message") this.sawErrorMessage = true;
    const index = step.step_index;
    if (step.state === "DONE" && step.usage && !this.counted.has(index)) {
      this.counted.add(index);
      const u = step.usage;
      this.usage = addAntigravityUsage(this.usage, {
        input_tokens: (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0), cached_input_tokens: u.cache_read_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0, reasoning_output_tokens: u.thinking_tokens ?? 0,
      });
    }
    const events: SSEEventPayload[] = [];
    if (step.step_type === "agent_response") {
      const identity = { item_id: String(index), thread_id: step.conversation_id,
        turn_id: this.turnId, raw_event_type: "antigravity/agent_response" };
      if (!this.text.has(index)) {
        this.text.set(index, "");
        events.push({ type: "text_start", ...identity, timestamp, _live_only: true });
      }
      if (step.text_delta !== undefined) {
        this.text.set(index, this.text.get(index)! + step.text_delta);
        events.push({ type: "text_delta", ...identity, text: step.text_delta, timestamp, _live_only: true });
      }
      if (step.state === "DONE") {
        const content = this.text.get(index)!;
        if (content) {
          this.completedResponse = content;
          events.push({ type: "assistant_message", ...identity, content, timestamp, _final_for_live_stream: true });
        }
        events.push({ type: "text_end", ...identity, timestamp, _live_only: true });
      }
    }
    if (step.step_type === "tool" && step.tool_info) {
      const info = step.tool_info;
      const parameters = info.parameters as Record<string, unknown> | undefined;
      const mcp = info.name === "call_mcp_tool";
      const tool_name = mcp ? `mcp/${parameters?.ServerName}/${parameters?.ToolName}` : info.name;
      const tool_use_id = `${step.conversation_id}:${this.turnId}:${index}`;
      if (!this.calls.has(index)) {
        this.calls.add(index);
        events.push({ type: "tool_start", tool_use_id, tool_name,
          tool_input: mcp ? parameters?.Arguments : info.parameters, timestamp });
      }
      if (step.state === "DONE" && !this.finishedTools.has(index)) {
        this.finishedTools.add(index);
        events.push({ type: "tool_result", tool_use_id, tool_name,
          ...(info.error !== undefined ? { result: info.error } : info.output !== undefined ? { result: info.output } : {}),
          is_error: info.error !== undefined, timestamp });
      }
    }
    return events;
  }

  terminal(exit: AntigravityExit, expectedInterrupt: boolean): SSEEventPayload[] {
    if (expectedInterrupt) return [];
    const result = this.result;
    const common = { timestamp: Date.now() / 1000, raw_event_type: "antigravity/result",
      ...(this.model !== undefined ? { model: this.model } : {}),
    };
    const usage = this.usage !== undefined ? { usage: this.usage } : {};
    // agy 1.3.5 can report a historical ERROR_MESSAGE in a resumed result.
    // The stream contains only this execution's steps; a matching DONE response
    // without a new error step proves recovery. Preserve all actual close errors.
    const recovered = this.resuming && result?.status === "ERROR"
      && !this.sawErrorMessage && this.completedResponse !== undefined
      && result.response === this.completedResponse;
    if (
      !exit.error
      && (result?.status === "SUCCESS" || recovered)
      && ((exit.code === 0 && exit.signal === null) || exit.forcedAfterResult === true)
    ) {
      return [{ type: "complete", ...common, status: "completed", ...usage,
        ...(result.response !== undefined ? { result: result.response } : {}) }];
    }
    const registryError = result?.error?.includes("not found in registry");
    const message = registryError
      ? "안티그라비티 도구 구성이 현재 CLI와 맞지 않아 실행을 시작하지 못했습니다."
      : exit.error ?? result?.error ?? `Antigravity exited without a successful result (${exit.signal ?? exit.code})`;
    const quotaMessage = result?.error ?? exit.error;
    if (quotaMessage && /quota reached/i.test(quotaMessage)) {
      const resetsAt = parseAntigravityResetsAt(quotaMessage);
      const quotaFields = { error_code: ANTIGRAVITY_QUOTA_ERROR_CODE,
        ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}) };
      return [
        { type: "credential_alert", status: "rejected", ...common,
          ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}) } as SSEEventPayload,
        { type: "error", ...common, ...usage, fatal: true, message, ...quotaFields } as SSEEventPayload,
      ];
    }
    return [{ type: "error", ...common, ...usage, fatal: true, message }];
  }
}

function parseAntigravityResetsAt(message: string): string | undefined {
  const match = /\bResets in\s+((?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?)/i.exec(message);
  const duration = match?.[1];
  if (!duration) return undefined;
  const parts = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(duration);
  if (!parts) return undefined;
  const seconds = Number(parts[1] ?? 0) * 86_400
    + Number(parts[2] ?? 0) * 3_600
    + Number(parts[3] ?? 0) * 60
    + Number(parts[4] ?? 0);
  return new Date(Date.now() + seconds * 1_000).toISOString();
}
