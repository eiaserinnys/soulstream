import {
  sanitizeJsonText,
  sanitizeJsonValue,
  truncateJsonText,
} from "./json_text.js";

export const TOOL_SEARCHABLE_TEXT_MAX_CODE_POINTS = 1_024;
const TOOL_NAME_MAX_CODE_POINTS = 128;
const TOOL_INPUT_SCALAR_MAX_CODE_POINTS = 160;
const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_ARRAY_ITEMS = 3;
const TOOL_INPUT_MAX_LEAVES = 8;
const TOOL_INPUT_KEY_PRIORITY = [
  "command",
  "cmd",
  "query",
  "q",
  "file_path",
  "path",
  "url",
  "uri",
  "pattern",
  "search",
  "prompt",
  "cwd",
  "filename",
  "id",
] as const;

export function extractToolSearchableText(
  event: Record<string, unknown>,
): string | null {
  if (event.type === "tool_start") return extractToolStart(event);
  if (event.type === "tool_result") return extractToolResult(event);
  return null;
}

function extractToolStart(event: Record<string, unknown>): string {
  const prefix = `tool: ${extractToolName(event)}`;
  const normalized = normalizeToolInput(event.tool_input);
  if (normalized.kind === "raw") {
    const raw = truncateJsonText(
      normalized.value,
      TOOL_INPUT_SCALAR_MAX_CODE_POINTS,
    );
    return cap(raw ? `${prefix} input: ${raw}` : prefix);
  }

  const leaves: ToolInputLeaf[] = [];
  collectToolInputLeaves(normalized.value, "", 0, leaves);
  const suffix = leaves
    .map(({ path, value }) => `${path}: ${value}`)
    .join(" ");
  return cap(suffix ? `${prefix} ${suffix}` : prefix);
}

function extractToolResult(event: Record<string, unknown>): string {
  const prefix = `tool: ${extractToolName(event)} result:`;
  const result = toolResultToText(event.result);
  return cap(result ? `${prefix} ${result}` : prefix);
}

function cap(value: string): string {
  return truncateJsonText(value, TOOL_SEARCHABLE_TEXT_MAX_CODE_POINTS);
}

function extractToolName(event: Record<string, unknown>): string {
  const value = typeof event.tool_name === "string"
    ? sanitizeJsonText(event.tool_name).trim()
    : "";
  return truncateJsonText(
    value || "unknown_tool",
    TOOL_NAME_MAX_CODE_POINTS,
  );
}

type NormalizedToolInput =
  | { kind: "structured"; value: Record<string, unknown> | unknown[] }
  | { kind: "raw"; value: string };

interface ToolInputLeaf {
  path: string;
  value: string;
}

function normalizeToolInput(value: unknown): NormalizedToolInput {
  if (typeof value === "string") {
    const sanitized = sanitizeJsonText(value);
    try {
      const parsed: unknown = JSON.parse(sanitized);
      if (isStructuredToolInput(parsed)) {
        return { kind: "structured", value: parsed };
      }
    } catch {
      // Truncated/non-JSON external arguments still retain a searchable prefix.
    }
    return { kind: "raw", value: sanitized };
  }
  if (isStructuredToolInput(value)) {
    return { kind: "structured", value };
  }
  if (value === undefined || value === null) {
    return { kind: "structured", value: {} };
  }
  return { kind: "raw", value: scalarToolInputToText(value) };
}

function isStructuredToolInput(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return Boolean(value && typeof value === "object");
}

function collectToolInputLeaves(
  value: unknown,
  path: string,
  depth: number,
  leaves: ToolInputLeaf[],
): void {
  if (leaves.length >= TOOL_INPUT_MAX_LEAVES) return;
  const scalar = scalarToolInputToText(value);
  if (scalar !== "") {
    if (path) {
      leaves.push({
        path,
        value: truncateJsonText(
          scalar,
          TOOL_INPUT_SCALAR_MAX_CODE_POINTS,
        ),
      });
    }
    return;
  }
  if (depth >= TOOL_INPUT_MAX_DEPTH || !value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (
      let index = 0;
      index < Math.min(value.length, TOOL_INPUT_MAX_ARRAY_ITEMS);
      index += 1
    ) {
      collectToolInputLeaves(
        value[index],
        `${path}[${index}]`,
        depth + 1,
        leaves,
      );
      if (leaves.length >= TOOL_INPUT_MAX_LEAVES) return;
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort(compareToolInputKeys)) {
    collectToolInputLeaves(
      record[key],
      path ? `${path}.${key}` : key,
      depth + 1,
      leaves,
    );
    if (leaves.length >= TOOL_INPUT_MAX_LEAVES) return;
  }
}

function compareToolInputKeys(left: string, right: string): number {
  const leftPriority = TOOL_INPUT_KEY_PRIORITY.indexOf(
    left as (typeof TOOL_INPUT_KEY_PRIORITY)[number],
  );
  const rightPriority = TOOL_INPUT_KEY_PRIORITY.indexOf(
    right as (typeof TOOL_INPUT_KEY_PRIORITY)[number],
  );
  const leftRank = leftPriority === -1
    ? TOOL_INPUT_KEY_PRIORITY.length
    : leftPriority;
  const rightRank = rightPriority === -1
    ? TOOL_INPUT_KEY_PRIORITY.length
    : rightPriority;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left < right ? -1 : left > right ? 1 : 0;
}

function scalarToolInputToText(value: unknown): string {
  if (typeof value === "string") return sanitizeJsonText(value);
  if (
    typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value === null) return "null";
  return "";
}

function toolResultToText(value: unknown): string {
  if (typeof value === "string") return sanitizeJsonText(value);
  if (value === undefined || value === null) return "";
  try {
    return sanitizeJsonText(JSON.stringify(sanitizeJsonValue(value)));
  } catch {
    return sanitizeJsonText(String(value));
  }
}
