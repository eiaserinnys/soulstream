import type { SSEEventPayload } from "./protocol.js";

type UnknownRecord = Record<string, unknown>;

/**
 * OpenAI Agents SDK RunStreamEvent → Soulstream SSE payload mapper.
 *
 * Mapper is intentionally stateless. Approval resumption and runner loop state live in
 * AgentsEngineAdapter; this file only translates public SDK event shapes into wire events.
 */
export function mapAgentsRunStreamEvent(event: unknown): SSEEventPayload[] {
  if (!isRecord(event)) return [];
  const now = Date.now() / 1000;

  if (event.type === "agent_updated_stream_event") {
    const agent = asRecord(event.agent);
    return [asSSE({
      type: "agent_updated",
      agent_name: readString(agent, "name") ?? "unknown",
      timestamp: now,
    })];
  }

  if (event.type !== "run_item_stream_event") return [];
  const name = readString(event, "name");
  const item = asRecord(event.item);
  const rawItem = asRecord(item.rawItem);

  switch (name) {
    case "handoff_requested": {
      return [asSSE({
        type: "handoff_requested",
        source_agent: readAgentName(item.agent) ?? "unknown",
        target_agent: inferHandoffTarget(rawItem),
        tool_use_id: readToolUseId(rawItem),
        handoff_input: parseToolInput(rawItem.arguments),
        timestamp: now,
      })];
    }
    case "handoff_occurred": {
      return [asSSE({
        type: "handoff_occurred",
        source_agent: readAgentName(item.sourceAgent) ?? "unknown",
        target_agent: readAgentName(item.targetAgent) ?? inferHandoffTarget(rawItem),
        tool_use_id: readToolUseId(rawItem),
        timestamp: now,
      })];
    }
    case "tool_called": {
      return [asSSE({
        type: "tool_start",
        timestamp: now,
        tool_name: readToolName(item, rawItem),
        tool_input: parseToolInput(rawItem.arguments),
        tool_use_id: readToolUseId(rawItem),
      })];
    }
    case "tool_output": {
      return [asSSE({
        type: "tool_result",
        timestamp: now,
        tool_name: readToolName(item, rawItem),
        result: stringifyToolOutput(rawItem.output ?? item.output),
        is_error: false,
        tool_use_id: readToolUseId(rawItem),
      })];
    }
    case "tool_approval_requested": {
      const approvalId = readToolUseId(rawItem);
      return [asSSE({
        type: "tool_approval_requested",
        approval_id: approvalId,
        tool_use_id: approvalId,
        tool_name: readToolName(item, rawItem),
        tool_input: parseToolInput(rawItem.arguments),
        agent_name: readAgentName(item.agent),
        timestamp: now,
      })];
    }
    default:
      return [];
  }
}

export function mapAgentsGuardrailError(err: unknown): SSEEventPayload[] {
  if (!isRecord(err)) return [];
  const name = readString(err, "name") ?? "";
  if (!name.includes("GuardrailTripwireTriggered") && !isRecord(err.result)) {
    return [];
  }

  const result = asRecord(err.result);
  const guardrail = asRecord(result.guardrail);
  const output = asRecord(result.output);
  return [asSSE({
    type: "guardrail_tripwire",
    guardrail_type: readString(guardrail, "type") ?? inferGuardrailType(name),
    guardrail_name: readString(guardrail, "name") ?? name,
    message: readString(err, "message") ?? name,
    output_info: output.outputInfo,
    timestamp: Date.now() / 1000,
  })];
}

function inferGuardrailType(name: string): string {
  if (name.startsWith("Input")) return "input";
  if (name.startsWith("Output")) return "output";
  if (name.startsWith("ToolInput")) return "tool_input";
  if (name.startsWith("ToolOutput")) return "tool_output";
  return "unknown";
}

function inferHandoffTarget(rawItem: UnknownRecord): string {
  const rawName = readString(rawItem, "name") ?? "";
  return rawName.startsWith("transfer_to_")
    ? rawName.slice("transfer_to_".length)
    : rawName || "unknown";
}

function readToolName(item: UnknownRecord, rawItem: UnknownRecord): string {
  return readString(item, "toolName")
    ?? readString(rawItem, "name")
    ?? readString(item, "name")
    ?? "unknown";
}

function readToolUseId(rawItem: UnknownRecord): string {
  return readString(rawItem, "callId")
    ?? readString(rawItem, "call_id")
    ?? readString(rawItem, "id")
    ?? "";
}

function readAgentName(value: unknown): string | undefined {
  const agent = asRecord(value);
  return readString(agent, "name");
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return isRecord(value) ? value : {};
  }
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asSSE(payload: Record<string, unknown>): SSEEventPayload {
  return payload as unknown as SSEEventPayload;
}
