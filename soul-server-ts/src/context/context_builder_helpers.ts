import type { Logger } from "pino";
import type { CallerInfo, Task } from "../task/task_models.js";
import type { AgentProfile, AgentRegistry } from "../agent_registry.js";
import type { SessionDB } from "../db/session_db.js";

import {
  atomContextSpecKey,
  type AtomContextSpec,
  type AtomFetchConfig,
} from "./atom_context.js";
import {
  compileContexts,
  type ContextCompilationResult,
  type ContextFilterParameters,
} from "./compiler/index.js";
import type { PreparedContext } from "./context_builder.js";
import { formatContextItems, type ContextItem } from "./prompt_assembler.js";
import type { PrimarySessionContainerContext } from "./session_container_context.js";
import { resolvePrimarySessionContainerContext } from "./session_container_context.js";

export interface FolderChainEntry {
  id: string;
  parentFolderId: string | null;
  projectPageId?: string | null;
  settings: Record<string, unknown>;
}

export interface PrioritizedAtomContextSpecs {
  session: AtomContextSpec[];
  folder: AtomContextSpec[];
  agent: AtomContextSpec[];
}

export interface ProfileRuntimeSettings {
  workingDir?: string;
  maxTurns?: number;
}

export function composeFirstTurnPrompt(ctx: PreparedContext): string {
  const parts: string[] = [];
  if (ctx.effectiveSystemPrompt) parts.push(ctx.effectiveSystemPrompt);
  const contextBlock = formatContextItems(ctx.combinedContextItems);
  if (contextBlock) parts.push(contextBlock);
  parts.push(ctx.assembledPrompt);
  return parts.join("\n\n");
}

export function composeEffectiveSystemPrompt(args: {
  agentAtomMarkdown: string | null;
  folderPrompt?: string;
  taskSystemPrompt?: string;
}): string | undefined {
  return [args.agentAtomMarkdown, args.folderPrompt, args.taskSystemPrompt]
    .filter((part): part is string => Boolean(part))
    .join("\n\n") || undefined;
}

export function resolveProfileRuntimeSettings(
  task: Task,
  registry: AgentRegistry,
): ProfileRuntimeSettings {
  if (!task.profileId) return {};
  const profile = registry.get(task.profileId);
  if (!profile) return {};
  return { workingDir: profile.workspace_dir, maxTurns: profile.max_turns };
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
  const specsByKey = new Map<string, AtomContextSpec>();
  for (const folder of chain) {
    const spec = extractAtomContextSpec(folder.settings);
    if (!spec) continue;
    const key = atomContextSpecKey(spec);
    specsByKey.delete(key);
    specsByKey.set(key, spec);
  }
  return [...specsByKey.values()];
}

export function extractFolderProjectPageIds(chain: FolderChainEntry[]): string[] {
  const seen = new Set<string>();
  return chain.flatMap((folder) => {
    const pageId = folder.projectPageId?.trim();
    if (!pageId || seen.has(pageId)) return [];
    seen.add(pageId);
    return [pageId];
  });
}

export function extractAgentAtomContextSpecs(agent: AgentProfile): AtomContextSpec[] {
  return (agent.atom_contexts ?? []).map((context) => ({
    nodeId: context.node_id,
    depth: context.depth,
    titlesOnly: context.titles_only,
    ...(context.mode !== undefined ? { mode: context.mode } : {}),
    ...(context.include_ids !== undefined
      ? { includeIds: context.include_ids }
      : {}),
    ...(context.applies_when !== undefined
      ? { appliesWhen: context.applies_when }
      : {}),
  }));
}

export function buildContextFilterParameters(args: {
  task: Task;
  agent: AgentProfile;
  nodeId: string;
  primaryContainer: PrimarySessionContainerContext | null;
}): ContextFilterParameters {
  const source = args.task.callerInfo?.source;
  return {
    ...(typeof source === "string" && source.length > 0 ? { source } : {}),
    node_id: args.nodeId,
    ...(args.primaryContainer ? { container_kind: args.primaryContainer.container.kind } : {}),
    agent: args.agent.id,
  };
}

export async function resolveContextFilterContext(args: {
  db: SessionDB;
  logger: Logger;
  task: Task;
  agent: AgentProfile;
  nodeId: string;
  folderName?: string;
}): Promise<{
  primaryContainer: PrimarySessionContainerContext | null;
  filterParameters: ContextFilterParameters;
}> {
  const primaryContainer = await resolvePrimarySessionContainerContext(
    args.db,
    args.logger,
    args.task.agentSessionId,
    args.folderName,
  );
  return {
    primaryContainer,
    filterParameters: buildContextFilterParameters({ ...args, primaryContainer }),
  };
}

export async function compileAtomContext(
  config: AtomFetchConfig,
  specs: readonly AtomContextSpec[],
  logger: Pick<Logger, "warn">,
  filterParameters?: ContextFilterParameters,
): Promise<ContextCompilationResult> {
  return await compileContexts(config, specs, logger, filterParameters);
}

export function prioritizeAtomContextSpecs(args: {
  session: AtomContextSpec[];
  pageNodeIds: readonly string[];
  folder: AtomContextSpec[];
  agent: AtomContextSpec[];
}): PrioritizedAtomContextSpecs {
  const seenSpecs = new Set<string>();
  const blockedNodeIds = new Set<string>();
  const take = (specs: AtomContextSpec[]): AtomContextSpec[] => specs.filter((spec) => {
    const key = atomContextSpecKey(spec);
    if (blockedNodeIds.has(spec.nodeId) || seenSpecs.has(key)) return false;
    seenSpecs.add(key);
    return true;
  });
  const session = take(args.session);
  for (const nodeId of args.pageNodeIds) blockedNodeIds.add(nodeId);
  return { session, folder: take(args.folder), agent: take(args.agent) };
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
    ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
  };
}
