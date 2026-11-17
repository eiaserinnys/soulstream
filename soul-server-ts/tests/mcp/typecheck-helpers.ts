import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// The SDK validates tool results; narrow its compatibility return type for these tests.
export function toolResult(value: unknown): CallToolResult {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("Expected MCP tool content");
  }
  return value as CallToolResult;
}

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a value in test fixture");
  return value;
}
