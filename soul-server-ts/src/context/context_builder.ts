/** Builds input context; agent and folder instructions form the system prompt. */
import { readPersistentInstructions } from "@soulstream/wire-schema/persistent-session-instructions";
import { fetchAssignedCardContextItem, type AssignedCardContextCapture } from "./assigned_card_context.js";
import type { Logger } from "pino";
import type { AgentRegistry, AgentProfile } from "../agent_registry.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionRow } from "../db/session_db_types.js";
import type { CallerInfo, Task } from "../task/task_models.js";
import { type AtomContextSpec } from "./atom_context.js";
import {
  extractPageContextTruncation,
  mergeContextManifests,
} from "./compiler/index.js";
import {
  fetchCogitoContextItem,
  type CogitoContextConfig,
} from "./cogito_context.js";
import type { ContextItem } from "./prompt_assembler.js";
import {
  buildCallerInfoUpdateContextItem,
  buildClaudeSessionIdUpdateContextItem,
  callerInfoChanged,
  compileAtomContext,
  composeEffectiveSystemPrompt,
  composeFirstTurnPrompt as composeFirstTurnPromptImpl,
  composeFolderPromptChain,
  extractAgentAtomContextSpecs,
  extractFolderAtomContextSpecs,
  extractFolderProjectPageIds,
  isMinimalContextScope,
  normalizeSettings,
  prioritizeAtomContextSpecs,
  resolveContextFilterContext,
  resolveProfileRuntimeSettings,
  type FolderChainEntry,
} from "./context_builder_helpers.js";
import {
  fetchBoardWorkspaceContextItem,
  fetchRunningSessionsContextItem,
} from "./session_context_items.js";
import {
  NO_PAGE_ANCHOR_CONTEXT_RESOLVER,
  type PageContextResolution,
  type PageContextResolver,
} from "./page_context_resolver.js";
import { extractAtomContextSourceSpecs } from "./session_context_sources.js";
import { buildPredecessorSummaryContextItem } from "./predecessor_summary_context.js";
import { loadInitialResumeContext } from "./initial_resume_context.js";
import { assemblePreparedContext, type PreparedContext } from "./prepared_context_assembly.js";
export type { PreparedContext } from "./prepared_context_assembly.js";
import {
  buildPersistentCheckpoint,
  PERSISTENT_CHECKPOINT_BUDGET,
  PERSISTENT_CHECKPOINT_READ_LIMITS,
  PERSISTENT_SUPERVISION_SCOPE,
  type PersistentCheckpointStats,
} from "./persistent_checkpoint.js";
import { BOARD_WORKSPACE_SESSION_LIMIT } from "./board_workspace_item.js";
import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";
import {
  buildBestEffortBackendRolloverContext,
  type BackendRolloverContext,
} from "./backend_rollover_context.js";
export { CLAUDE_ROLLOVER_HISTORY_MAX_CHARS } from "./backend_rollover_context.js";
export type { BackendRolloverContext } from "./backend_rollover_context.js";

export interface GenerationPreparedContext extends PreparedContext {
  checkpointStats: PersistentCheckpointStats;
}

export interface FollowupContextOptions {
  inputId?: string | null;
  includeFullContext?: boolean;
  includeClaudeSessionIdUpdate?: boolean;
  previousCallerInfo?: CallerInfo;
  currentCallerInfo?: CallerInfo;
}

export interface FollowupContext {
  effectiveSystemPrompt?: string;
  contextItems: ContextItem[];
}

/** atom 호출 설정 (config.ts env에서 주입). */
export interface AtomConfig {
  enabled: boolean;
  serverUrl: string;
  apiKey: string;
}

/** codex 노드 식별자 (soulstream_item의 current_node_id에 박힘). */
export interface ContextBuilderConfig {
  nodeId: string;
  atom: AtomConfig;
  cogito?: CogitoContextConfig;
  captureAssignedCardContext?: (capture: AssignedCardContextCapture) => Promise<void>;
}
export class ExecutionContextBuilder {
  constructor(
    private readonly db: SessionDB,
    private readonly registry: AgentRegistry,
    private readonly cfg: ContextBuilderConfig,
    private readonly logger: Logger,
    private readonly pageContextResolver: PageContextResolver =
      NO_PAGE_ANCHOR_CONTEXT_RESOLVER,
  ) {}

  async buildFollowupContext(
    task: Task,
    agent: AgentProfile,
    options: FollowupContextOptions = {},
  ): Promise<FollowupContext> {
    if (options.includeFullContext) {
      const taskForContext = options.currentCallerInfo
        ? { ...task, callerInfo: options.currentCallerInfo }
        : task;
      const ctx = await this.build(taskForContext, agent, options.inputId);
      return {
        effectiveSystemPrompt: ctx.effectiveSystemPrompt,
        contextItems: ctx.combinedContextItems,
      };
    }

    const contextItems: ContextItem[] = [];
    if (options.includeClaudeSessionIdUpdate && task.codexThreadId) {
      contextItems.push(buildClaudeSessionIdUpdateContextItem(task));
    }
    if (
      options.currentCallerInfo &&
      callerInfoChanged(options.previousCallerInfo, options.currentCallerInfo)
    ) {
      contextItems.push(
        buildCallerInfoUpdateContextItem(
          options.previousCallerInfo,
          options.currentCallerInfo,
        ),
      );
    }

    if (!isMinimalContextScope(agent)) {
      const runningSessionsItem = await fetchRunningSessionsContextItem(
        this.db,
        this.logger,
        task.agentSessionId,
      );
      if (runningSessionsItem) {
        contextItems.push(runningSessionsItem);
      }
    }
    const assignedCardItem = await this.buildAssignedCardContext(task, options.inputId);
    if (assignedCardItem) contextItems.push(assignedCardItem);
    return { contextItems };
  }

  buildAssignedCardContext(task: Task, inputId?: string | null) {
    return fetchAssignedCardContextItem(this.db,this.logger,task.agentSessionId,
      this.cfg.captureAssignedCardContext ? snapshot=>this.cfg.captureAssignedCardContext!({
        source: "prepared_model_input", sessionId: task.agentSessionId,
        registrationId: task.executionRegistration?.registrationId ?? null,
        executionCommandId: task.executionRegistration?.executionCommandId ?? null,
        inputId: inputId ?? null, snapshot,
      }) : undefined);
  }

  async buildBackendRolloverContext(
    task: Task,
    agent: AgentProfile,
  ): Promise<BackendRolloverContext> {
    return await buildBestEffortBackendRolloverContext({
      db: this.db,
      logger: this.logger,
      sessionId: task.agentSessionId,
      buildFullContext: async () =>
        await this.buildFollowupContext(task, agent, { includeFullContext: true }),
    });
  }

  async buildResumeContextItems(task: Task, agent: AgentProfile): Promise<ContextItem[]> {
    const ctx = await this.buildFollowupContext(task, agent, {
      includeClaudeSessionIdUpdate: Boolean(task.codexThreadId),
      currentCallerInfo: task.callerInfo,
    });
    return ctx.contextItems;
  }

  /**
   * Claude resume/intervention turn용 system prompt만 조립한다.
   *
   * 첫 턴의 `system_message` durable event를 다시 쓰지 않고, Claude SDK의 `systemPrompt`
   * option으로만 넘겨 대화 히스토리 중복 누적을 막는다. folder atomContextNode·cogito·
   * task.contextItems는 user/context 영역이라 여기서 제외한다.
   */
  async buildSystemPrompt(task: Task, agent: AgentProfile): Promise<string | undefined> {
    const { folderPrompt } = await this._resolveFolder(task);
    const { filterParameters } = await resolveContextFilterContext({
      db: this.db, logger: this.logger, task, agent, nodeId: this.cfg.nodeId,
    });
    const agentAtomMarkdown = (await compileAtomContext(
      this.cfg.atom, extractAgentAtomContextSpecs(agent), this.logger, filterParameters,
    )).assembled;
    return composeEffectiveSystemPrompt({
      agentAtomMarkdown,
      folderPrompt,
      taskSystemPrompt: task.systemPrompt,
    });
  }

  /**
   *
   * 호출 시점은 task_executor의 *신규 첫 turn 진입 전* (interventionQueue 비어있을 때).
   */
  async build(task: Task, agent: AgentProfile, inputId?: string | null): Promise<PreparedContext> {
    return await this._buildContext(task, agent, inputId, false);
  }

  async buildGenerationContext(
    task: Task,
    agent: AgentProfile,
    inputId?: string | null,
  ): Promise<GenerationPreparedContext> {
    return await this._buildContext(task, agent, inputId, true);
  }

  private async _buildContext(
    task: Task,
    agent: AgentProfile,
    inputId: string | null | undefined,
    generation: false,
  ): Promise<PreparedContext>;
  private async _buildContext(
    task: Task,
    agent: AgentProfile,
    inputId: string | null | undefined,
    generation: true,
  ): Promise<GenerationPreparedContext>;
  private async _buildContext(
    task: Task,
    agent: AgentProfile,
    inputId: string | null | undefined,
    generation: boolean,
  ): Promise<PreparedContext | GenerationPreparedContext> {
    const resumeContext = await loadInitialResumeContext(
      this.db,
      this.logger,
      task.agentSessionId,
      BOARD_WORKSPACE_SESSION_LIMIT,
    );
    const checkpoint = generation
      ? await this.readPersistentCheckpoint(task)
      : null;
    const folder = await this._resolveFolder(task, resumeContext.session);
    const sessionAtomSpecs = extractAtomContextSourceSpecs(task.contextItems);
    const minimal = isMinimalContextScope(agent);
    const pageContext: PageContextResolution = minimal
      ? { kind: "no-page-anchor" }
      : await this.pageContextResolver.resolve(task, agent, this.cfg.atom, {
          pageIds: folder.projectPageIds,
          excludedAtomNodeIds: sessionAtomSpecs.map((spec) => spec.nodeId),
        });
    const pageContextItem = pageContext.kind === "page-context" ? pageContext.contextItem : null;
    const atomSources = prioritizeAtomContextSpecs({
      session: sessionAtomSpecs,
      pageNodeIds: pageContext.kind === "page-context" ? pageContext.atomNodeIds : [],
      folder: minimal ? [] : folder.atomContextSpecs ?? [],
      agent: extractAgentAtomContextSpecs(agent),
    });
    const { primaryFolder, filterParameters } = await resolveContextFilterContext({
      db: this.db, logger: this.logger, task, agent, nodeId: this.cfg.nodeId,
      folderId: folder.folderId,
    });
    const [agentAtomCompilation, atomCompilation, taskAtomCompilation, boardWorkspaceItem] =
      await Promise.all([
        compileAtomContext(this.cfg.atom, atomSources.agent, this.logger, filterParameters),
        compileAtomContext(this.cfg.atom, atomSources.folder, this.logger, filterParameters),
        compileAtomContext(this.cfg.atom, atomSources.session, this.logger, filterParameters),
        minimal
          ? null
          : fetchBoardWorkspaceContextItem(
              this.db,
              this.logger,
              folder.folderId,
              resumeContext.folderSessions,
            ),
      ]);
    const contextManifest = mergeContextManifests(
      [
        agentAtomCompilation.manifest,
        atomCompilation.manifest,
        taskAtomCompilation.manifest,
        ...(pageContext.kind === "page-context" ? [pageContext.contextManifest] : []),
      ],
      extractPageContextTruncation(pageContextItem),
    );
    const runningSessionsItem = minimal
      ? null
      : await fetchRunningSessionsContextItem(
          this.db,
          this.logger,
          task.agentSessionId,
          resumeContext.runningSessions,
        );
    const predecessorSummaryItem = generation
      ? null
      : await buildPredecessorSummaryContextItem(
          this.db,
          this.logger,
          task.agentSessionId,
          resumeContext.predecessor,
        );
    const cogitoContextItem = minimal ? null : await this._fetchCogitoContext();
    const { workingDir, maxTurns } = resolveProfileRuntimeSettings(task, this.registry);
    const prepared = assemblePreparedContext({
      nodeId: this.cfg.nodeId,
      task,
      agent,
      folderName: folder.folderName,
      folderPrompt: folder.folderPrompt,
      agentAtomMarkdown: agentAtomCompilation.assembled,
      atomMarkdown: atomCompilation.assembled,
      taskAtomMarkdown: taskAtomCompilation.assembled,
      contextManifest,
      primaryFolder,
      pageContextItem,
      boardWorkspaceItem,
      runningSessionsItem,
      assignedCardItem: await this.buildAssignedCardContext(task, inputId),
      predecessorSummaryItem,
      generationCheckpointItem: checkpoint?.item ?? null,
      nativeSessionId: generation ? null : task.codexThreadId ?? null,
      cogitoContextItem,
      workingDir,
      maxTurns,
    });
    return checkpoint ? { ...prepared, checkpointStats: checkpoint.stats } : prepared;
  }

  private async readPersistentCheckpoint(task: Task) {
    const sessionId = task.agentSessionId;
    const [material, cards] = await Promise.all([
      this.db.getGenerationCheckpointMaterial(sessionId, PERSISTENT_CHECKPOINT_READ_LIMITS),
      this.db.getSupervisedCardContext({
        sessionId,
        ...PERSISTENT_SUPERVISION_SCOPE,
        cardLimit: PERSISTENT_CHECKPOINT_BUDGET.cardLimit,
        questionLimit: PERSISTENT_CHECKPOINT_BUDGET.questionLimit,
      }),
    ]);
    return buildPersistentCheckpoint({
      material,
      cards,
      standingInstructions: readPersistentInstructions(task.metadata)
        .filter((instruction) => instruction.status === "active")
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .map((instruction) => instruction.source_turns.length > 0
          ? `- (${instruction.source_turns.join(", ")}) ${instruction.text}`
          : `- ${instruction.text}`),
      ownSessionId: sessionId,
    }, PERSISTENT_CHECKPOINT_BUDGET);
  }

  /**
   * sessions.folder_id → folders row → settings 추출 (Python L73-105).
   *
   * settings는 jsonb dict인 케이스만 통과 (Python isinstance(dict) 가드 정합).
   * 본 PR은 *신규 task에만* 폴더 프롬프트 적용 — 호출자가 이미 분기 보장하므로 본 메서드에서
   * resume 가드는 생략 (Python L100은 호출자 분기와 중복이지만 안전망).
   */
  private async _resolveFolder(
    task: Task,
    preloadedSession?: SessionRow | null,
  ): Promise<{
    folderId?: string;
    folderName?: string;
    folderPrompt?: string;
    atomContextSpecs?: AtomContextSpec[];
    projectPageIds?: string[];
  }> {
    let sessionRow = preloadedSession;
    if (preloadedSession === undefined) {
      try {
        sessionRow = await this.db.getSession(task.agentSessionId);
      } catch (err) {
        if (isSessionDataHostError(err)) throw err;
        this.logger.warn(
          { err, sessionId: task.agentSessionId },
          "_resolveFolder: getSession failed",
        );
        return {};
      }
    }
    if (!sessionRow || !sessionRow.folder_id) return {};

    let folderRow;
    try {
      folderRow = await this.db.getFolderById(sessionRow.folder_id);
    } catch (err) {
      this.logger.warn(
        { err, folderId: sessionRow.folder_id },
        "_resolveFolder: getFolderById failed",
      );
      return {};
    }
    if (!folderRow) return {};

    const folderName = folderRow.name;
    const chain = await this._resolveFolderChain(folderRow);
    const folderPrompt = composeFolderPromptChain(chain);
    const atomContextSpecs = extractFolderAtomContextSpecs(chain);
    const projectPageIds = extractFolderProjectPageIds(chain);
    return { folderId: folderRow.id, folderName, folderPrompt, atomContextSpecs, projectPageIds };
  }

  private async _resolveFolderChain(folderRow: {
    id: string;
    parent_folder_id?: string | null;
    project_page_id?: string | null;
    settings?: Record<string, unknown>;
  }): Promise<FolderChainEntry[]> {
    const fallback: FolderChainEntry[] = [
      {
        id: folderRow.id,
        parentFolderId: folderRow.parent_folder_id ?? null,
        projectPageId: folderRow.project_page_id ?? null,
        settings: normalizeSettings(folderRow.settings),
      },
    ];
    const getCatalog = (this.db as unknown as {
      getCatalog?: SessionDB["getCatalog"];
    }).getCatalog;
    if (typeof getCatalog !== "function") return fallback;

    try {
      const catalog = await getCatalog.call(this.db);
      const byId = new Map(
        catalog.folders.map((folder) => [
          folder.id,
          {
            id: folder.id,
            parentFolderId: folder.parentFolderId,
            projectPageId: folder.projectPageId ?? null,
            settings: normalizeSettings(folder.settings),
          },
        ]),
      );
      const path: FolderChainEntry[] = [];
      const seen = new Set<string>();
      let current = byId.get(folderRow.id) ?? fallback[0];
      while (current && !seen.has(current.id)) {
        path.push(current);
        seen.add(current.id);
        current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
      }
      return path.length > 0 ? path.reverse() : fallback;
    } catch (err) {
      this.logger.warn({ err, folderId: folderRow.id }, "_resolveFolderChain: getCatalog failed");
      return fallback;
    }
  }

  private async _fetchCogitoContext(): Promise<ContextItem | null> {
    if (!this.cfg.cogito) return null;
    try {
      return await fetchCogitoContextItem(this.cfg.cogito, this.logger);
    } catch (err) {
      this.logger.warn({ err }, "_fetchCogitoContext: unexpected failure");
      return null;
    }
  }

}

/** Keeps the public and cogito-reflected context composition entrypoint stable. */
export function composeFirstTurnPrompt(ctx: PreparedContext): string {
  return composeFirstTurnPromptImpl(ctx);
}
