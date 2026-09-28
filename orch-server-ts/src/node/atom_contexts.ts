import { isUuid } from "../http/uuid.js";

export type AgentAtomContext = {
  readonly node_id: string;
  readonly depth?: number;
  readonly titles_only?: boolean;
  readonly include_ids?: boolean;
  readonly mode?: "full" | "index" | "titles";
  readonly applies_when?: Readonly<Record<string, unknown>>;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseAtomContexts(value: unknown): ParseResult<AgentAtomContext[]> {
  if (!Array.isArray(value)) return invalid("atom_contexts must be an array");
  const result: AgentAtomContext[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !isUuid(entry.node_id)) return invalid("atom_contexts node_id must be a UUID");
    if (entry.depth !== undefined && (!Number.isInteger(entry.depth) || (entry.depth as number) < 0)) return invalid("atom_contexts depth must be a non-negative integer");
    if (entry.mode !== undefined && !["full", "index", "titles"].includes(String(entry.mode))) return invalid("atom_contexts mode is invalid");
    if (entry.titles_only !== undefined && typeof entry.titles_only !== "boolean") return invalid("atom_contexts titles_only must be boolean");
    if (entry.include_ids !== undefined && typeof entry.include_ids !== "boolean") return invalid("atom_contexts include_ids must be boolean");
    if (entry.applies_when !== undefined && !isObject(entry.applies_when)) return invalid("atom_contexts applies_when must be an object");
    result.push({
      node_id: entry.node_id,
      ...(typeof entry.depth === "number" ? { depth: entry.depth } : {}),
      ...(typeof entry.titles_only === "boolean" ? { titles_only: entry.titles_only } : {}),
      ...(typeof entry.include_ids === "boolean" ? { include_ids: entry.include_ids } : {}),
      ...(typeof entry.mode === "string" ? { mode: entry.mode as AgentAtomContext["mode"] } : {}),
      ...(isObject(entry.applies_when) ? { applies_when: entry.applies_when } : {}),
    });
  }
  return { ok: true, value: result };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}
