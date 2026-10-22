import type { AgentProfile } from "../agent_registry.js";
import type { InputMaterialPartV1 } from "@soulstream/wire-schema";
import type { Task } from "../task/task_models.js";
import { assemblePrompt, type ContextItem } from "./prompt_assembler.js";
import {
  createInputMaterialPart,
  joinInputMaterialSegments,
  scopeInputMaterialParts,
  type InputMaterialTextSegment,
} from "./input_material_parts.js";
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
  inputMaterialBreakdown?: {
    systemParts: InputMaterialPartV1[];
    contextParts: Array<InputMaterialPartV1[] | null>;
  };
}

export interface PreparedContextAssemblyInput {
  nodeId: string;
  task: Task;
  agent: AgentProfile;
  folderName?: string;
  folderPrompt?: string;
  agentAtomMarkdown: string | null;
  agentAtomMaterialParts?: InputMaterialPartV1[];
  atomMarkdown: string | null;
  atomMaterialParts?: InputMaterialPartV1[];
  taskAtomMarkdown: string | null;
  taskAtomMaterialParts?: InputMaterialPartV1[];
  contextManifest: ContextManifest;
  primaryFolder: PrimarySessionFolderContext | null;
  pageContextItem: ContextItem | null;
  boardWorkspaceItem: ContextItem | null;
  runningSessionsItem: ContextItem | null;
  assignedCardItem: ContextItem | null;
  predecessorSummaryItem: ContextItem | null;
  generationCheckpointItem: ContextItem | null;
  persistentReportItem?: ContextItem | null;
  nodeResourcesItem?: ContextItem | null;
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
  const systemSegments: InputMaterialTextSegment[] = [];
  if (args.agentAtomMarkdown) {
    systemSegments.push({
      text: args.agentAtomMarkdown,
      parts: scopeInputMaterialParts(args.agentAtomMaterialParts ?? [], "system/agent-atom"),
    });
  }
  if (args.folderPrompt) {
    systemSegments.push({
      text: args.folderPrompt,
      parts: [createInputMaterialPart("system_prompt", "system/folder_prompt", args.folderPrompt)],
    });
  }
  if (args.task.systemPrompt) {
    systemSegments.push({
      text: args.task.systemPrompt,
      parts: [createInputMaterialPart(
        "system_prompt",
        "system/task_system_prompt",
        args.task.systemPrompt,
      )],
    });
  }
  const systemMaterial = joinInputMaterialSegments(systemSegments, "\n\n", "system_prompt");

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
  });

  const combinedContextItems: ContextItem[] = [soulstreamItem];
  const contextParts: Array<InputMaterialPartV1[] | null> = [null];
  if (args.persistentReportItem) {
    combinedContextItems.push(args.persistentReportItem);
    contextParts.push(null);
  }
  if (args.nodeResourcesItem) {
    combinedContextItems.push(args.nodeResourcesItem);
    contextParts.push(null);
  }
  if (args.pageContextItem) {
    combinedContextItems.push(args.pageContextItem);
    contextParts.push(null);
  }
  if (args.boardWorkspaceItem) {
    combinedContextItems.push(args.boardWorkspaceItem);
    contextParts.push(null);
  }
  const checkpointContextItem = args.generationCheckpointItem ?? args.predecessorSummaryItem;
  if (checkpointContextItem) {
    combinedContextItems.push(checkpointContextItem);
    contextParts.push(null);
  }
  if (args.runningSessionsItem) {
    combinedContextItems.push(args.runningSessionsItem);
    contextParts.push(null);
  }
  if (args.cogitoContextItem) {
    combinedContextItems.push(args.cogitoContextItem);
    contextParts.push(null);
  }
  if (args.atomMarkdown) {
    combinedContextItems.push({
      key: "atom_context",
      label: "atom 트리",
      content: args.atomMarkdown,
    });
    contextParts.push(args.atomMaterialParts ?? null);
  }
  if (args.taskAtomMarkdown) {
    combinedContextItems.push({
      key: "session_atom_context",
      label: "선택한 atom 노드",
      content: args.taskAtomMarkdown,
    });
    contextParts.push(args.taskAtomMaterialParts ?? null);
  }
  for (const item of withoutSessionContextSourceMarkers(args.task.contextItems)
    .filter((entry) => entry.key !== "assigned_cards")) {
    combinedContextItems.push(item);
    contextParts.push(null);
  }
  if (args.assignedCardItem) {
    combinedContextItems.push(args.assignedCardItem);
    contextParts.push(null);
  }

  return {
    effectiveSystemPrompt,
    combinedContextItems,
    folderName: args.folderName,
    workingDir: args.workingDir,
    maxTurns: args.maxTurns,
    assembledPrompt: assemblePrompt(args.task.prompt, undefined),
    contextManifest: args.contextManifest,
    inputMaterialBreakdown: {
      systemParts: [...systemMaterial.parts],
      contextParts,
    },
  };
}
