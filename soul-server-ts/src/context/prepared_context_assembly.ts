import type { AgentProfile } from "../agent_registry.js";
import type { Task } from "../task/task_models.js";
import { assemblePrompt, type ContextItem } from "./prompt_assembler.js";
import type { ContextManifest } from "./compiler/index.js";
import { composeEffectiveSystemPrompt } from "./context_builder_helpers.js";
import { buildSoulstreamContextItem } from "./soulstream_item.js";
import { withoutSessionContextSourceMarkers } from "./session_context_sources.js";
import type { PrimarySessionFolderContext } from "./session_folder_context.js";

export interface PreparedContext {
  /** agent atom context + folder_prompt + task.systemPrompt. */
  effectiveSystemPrompt?: string;
  /** soulstream_item + cogito_context + atom_context + task.contextItems. */
  combinedContextItems: ContextItem[];
  folderName?: string;
  /** profile.workspace_dir (있으면). 호출자가 agent.workspace_dir로 폴백. */
  workingDir?: string;
  /** profile.max_turns (codex SDK 미지원 — 메타 보존). */
  maxTurns?: number;
  /** Python `assembled_prompt` 등가 — 현재 task.prompt 그대로 (task.context wire 별건). */
  assembledPrompt: string;
  /** Phase A compiler observation. Initial-message publisher records this once per new session. */
  contextManifest?: ContextManifest;
}

export interface PreparedContextAssemblyInput {
  nodeId: string;
  task: Task;
  agent: AgentProfile;
  folderName?: string;
  folderPrompt?: string;
  agentAtomMarkdown: string | null;
  atomMarkdown: string | null;
  taskAtomMarkdown: string | null;
  contextManifest: ContextManifest;
  primaryFolder: PrimarySessionFolderContext | null;
  pageContextItem: ContextItem | null;
  boardWorkspaceItem: ContextItem | null;
  runningSessionsItem: ContextItem | null;
  assignedCardItem: ContextItem;
  predecessorSummaryItem: ContextItem | null;
  generationCheckpointItem: ContextItem | null;
  nativeSessionId: string | null;
  cogitoContextItem: ContextItem | null;
  workingDir?: string;
  maxTurns?: number;
}

export function assemblePreparedContext(args: PreparedContextAssemblyInput): PreparedContext {
  const effectiveSystemPrompt = composeEffectiveSystemPrompt({
    agentAtomMarkdown: args.agentAtomMarkdown,
    folderPrompt: args.folderPrompt,
    taskSystemPrompt: args.task.systemPrompt,
  });

  const effectiveWorkspaceDir = args.workingDir ?? args.agent.workspace_dir;
  const soulstreamItem = buildSoulstreamContextItem({
    agentSessionId: args.task.agentSessionId,
    claudeSessionId: args.nativeSessionId,
    workspaceDir: effectiveWorkspaceDir,
    folderName: args.folderName,
    nodeId: args.nodeId,
    agentId: args.agent.id,
    callerInfo: args.task.callerInfo,
    folder: args.primaryFolder?.folder ?? null,
    card: args.primaryFolder?.card ?? null,
    cardGuidance: args.primaryFolder?.cardGuidance ?? null,
    folderGuidance: args.primaryFolder?.folderGuidance ?? null,
  });

  const combinedContextItems: ContextItem[] = [soulstreamItem];
  if (args.pageContextItem) combinedContextItems.push(args.pageContextItem);
  if (args.boardWorkspaceItem) combinedContextItems.push(args.boardWorkspaceItem);
  const checkpointContextItem = args.generationCheckpointItem ?? args.predecessorSummaryItem;
  if (checkpointContextItem) combinedContextItems.push(checkpointContextItem);
  if (args.runningSessionsItem) combinedContextItems.push(args.runningSessionsItem);
  if (args.cogitoContextItem) combinedContextItems.push(args.cogitoContextItem);
  if (args.atomMarkdown) {
    combinedContextItems.push({
      key: "atom_context",
      label: "atom 트리",
      content: args.atomMarkdown,
    });
  }
  if (args.taskAtomMarkdown) {
    combinedContextItems.push({
      key: "session_atom_context",
      label: "선택한 atom 노드",
      content: args.taskAtomMarkdown,
    });
  }
  combinedContextItems.push(
    ...withoutSessionContextSourceMarkers(args.task.contextItems).filter((item) => item.key !== "assigned_cards"),
  );
  combinedContextItems.push(args.assignedCardItem);

  return {
    effectiveSystemPrompt,
    combinedContextItems,
    folderName: args.folderName,
    workingDir: args.workingDir,
    maxTurns: args.maxTurns,
    assembledPrompt: assemblePrompt(args.task.prompt, undefined),
    contextManifest: args.contextManifest,
  };
}
