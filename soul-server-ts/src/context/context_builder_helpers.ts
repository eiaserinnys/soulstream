import type { CallerInfo, Task } from "../task/task_models.js";

import type { AtomContextSpec } from "./atom_context.js";
import type { PreparedContext } from "./context_builder.js";
import { formatContextItems, type ContextItem } from "./prompt_assembler.js";

export interface FolderChainEntry {
  id: string;
  parentFolderId: string | null;
  settings: Record<string, unknown>;
}

export function composeFirstTurnPrompt(ctx: PreparedContext): string {
  const parts: string[] = [];
  if (ctx.effectiveSystemPrompt) parts.push(ctx.effectiveSystemPrompt);
  const contextBlock = formatContextItems(ctx.combinedContextItems);
  if (contextBlock) parts.push(contextBlock);
  parts.push(ctx.assembledPrompt);
  return parts.join("\n\n");
}

export function buildClaudeSessionIdUpdateContextItem(task: Task): ContextItem {
  return {
    key: "claude_session_id_update",
    label: "Claude session id update",
    content: {
      agent_session_id: task.agentSessionId,
      claude_session_id: task.codexThreadId,
    },
  };
}

export function buildCallerInfoUpdateContextItem(
  previousCallerInfo: CallerInfo | undefined,
  currentCallerInfo: CallerInfo,
): ContextItem {
  return {
    key: "caller_info_update",
    label: "Caller info update",
    content: {
      previous_caller_info: previousCallerInfo ?? null,
      current_caller_info: currentCallerInfo,
    },
  };
}

export function callerInfoChanged(
  previousCallerInfo: CallerInfo | undefined,
  currentCallerInfo: CallerInfo,
): boolean {
  return stableJson(previousCallerInfo ?? null) !== stableJson(currentCallerInfo);
}

export function composeFolderPromptChain(chain: FolderChainEntry[]): string | undefined {
  const prompts: string[] = [];
  const seenPrompts = new Set<string>();
  for (const folder of chain) {
    const prompt = extractFolderPrompt(folder.settings);
    if (!prompt || seenPrompts.has(prompt)) continue;
    seenPrompts.add(prompt);
    prompts.push(prompt);
  }
  return prompts.length > 0 ? prompts.join("\n\n") : undefined;
}

export function extractFolderAtomContextSpecs(chain: FolderChainEntry[]): AtomContextSpec[] {
  const specsByNodeId = new Map<string, AtomContextSpec>();
  for (const folder of chain) {
    const spec = extractAtomContextSpec(folder.settings);
    if (!spec) continue;
    specsByNodeId.delete(spec.nodeId);
    specsByNodeId.set(spec.nodeId, spec);
  }
  return [...specsByNodeId.values()];
}

export function normalizeSettings(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === "object"
    ? (settings as Record<string, unknown>)
    : {};
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortObjectKeys(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortObjectKeys(record[key])]),
  );
}

function extractFolderPrompt(settings: Record<string, unknown>): string | undefined {
  const value = settings.folderPrompt;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractAtomContextSpec(settings: Record<string, unknown>): AtomContextSpec | null {
  const cfg = settings.atomContextNode;
  if (!cfg || typeof cfg !== "object") return null;
  const record = cfg as Record<string, unknown>;
  const nodeId = record.nodeId;
  if (typeof nodeId !== "string" || !nodeId) return null;
  return {
    nodeId,
    depth: typeof record.depth === "number" ? record.depth : 3,
    titlesOnly: Boolean(record.titlesOnly),
  };
}
