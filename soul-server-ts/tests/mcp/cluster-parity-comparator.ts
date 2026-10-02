import { expect } from "vitest";

// Both JSON text and structuredContent use these exact paths. Session command UUID
// originates in session_command_routes.ts:createSessionPayload(randomUUID()).
const randomPaths: Record<string, readonly string[]> = { create_remote_agent_session: ["agentSessionId"] };
export function maskCluster(tool: string, value: unknown, path: string[] = []): unknown {
  if (randomPaths[tool]?.includes(path.join("."))) return "<session-id>";
  if (Array.isArray(value)) return value.map((v, i) => maskCluster(tool, v, [...path, String(i)]));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /_at$|At$/.test(key) && child !== null ? "<time>" : maskCluster(tool, child, [...path, key])]));
}
function serialize(tool: string, result: unknown) {
  const value = result as { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  return JSON.stringify({ ...value, content: value.content.map(item => {
    if (item.type !== "text" || value.isError) return item;
    let parsed; try { parsed = JSON.parse(item.text!); } catch { return item; }
    expect(item.text).toBe(JSON.stringify(parsed, null, 2));
    return { ...item, text: JSON.stringify(maskCluster(tool, parsed), null, 2) };
  }), ...(value.structuredContent === undefined ? {} : { structuredContent: maskCluster(tool, value.structuredContent) }) }, null, 2);
}
export function assertClusterParity(tool: string, old: unknown, next: unknown) { expect(serialize(tool, next)).toBe(serialize(tool, old)); }
