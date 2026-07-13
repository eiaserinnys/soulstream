/**
 * ExecutionContextBuilder — B-6 풀세트, Python `service/execution_context_builder.py` 정본 이식.
 *
 * codex task 첫 turn 진입 전에 다음을 조립:
 * 폴더·agent atom·page·cogito·profile을 조회하고 PreparedContext로 조립한다.
 *
 * 호출자(task_executor)는 codex SDK가 turn-level systemPrompt를 지원하지 않으므로 (분석 캐시
 * `20260517-2338-codex-ts-context-builder-B-6.md` §B), `composeFirstTurnPrompt` helper로
 * 합성 prompt를 만들어 engine.execute에 넘긴다.
 *
 * 신규 task와 compact 후 첫 사용자 메시지는 system prompt + context items 전체를 조립한다.
 * 일반 auto-resume·intervention turn은 매턴 갱신이 필요한 running_sessions와 짧은 delta만
 * user prompt 말미에 붙인다.
 */

import type { Logger } from "pino";

import type { AgentRegistry, AgentProfile } from "../agent_registry.js";
import type { SessionDB } from "../db/session_db.js";
import type { CallerInfo, Task } from "../task/task_models.js";

import {
  fetchAtomContext,
  fetchAtomContexts,
  type AtomContextSpec,
} from "./atom_context.js";
import {
  fetchCogitoContextItem,
  type CogitoContextConfig,
} from "./cogito_context.js";
import {
  assemblePrompt,
  type ContextItem,
} from "./prompt_assembler.js";
import {
  buildCallerInfoUpdateContextItem,
  buildClaudeSessionIdUpdateContextItem,
  callerInfoChanged,
  composeFirstTurnPrompt as composeFirstTurnPromptImpl,
  composeFolderPromptChain,
  extractFolderAtomContextSpecs,
  normalizeSettings,
  type FolderChainEntry,
} from "./context_builder_helpers.js";
import {
  fetchBoardWorkspaceContextItem,
  fetchRunningSessionsContextItem,
} from "./session_context_items.js";
import {
  resolvePrimarySessionContainerContext,
  type PrimarySessionContainerContext,
} from "./session_container_context.js";
import {
  NO_PAGE_ANCHOR_CONTEXT_RESOLVER,
  type PageContextResolver,
} from "./page_context_resolver.js";
import { buildSoulstreamContextItem } from "./soulstream_item.js";

/** Python `_PreparedContext` (execution_context_builder.py:24-34) TS 등가. */
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
}

export interface FollowupContextOptions {
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
      const ctx = await this.build(taskForContext, agent);
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

    const runningSessionsItem = await fetchRunningSessionsContextItem(
      this.db,
      this.logger,
      task.agentSessionId,
    );
    if (runningSessionsItem) {
      contextItems.push(runningSessionsItem);
    }
    return { contextItems };
  }

  /**
   * Legacy public wrapper. 후속 턴 context 정본은 `buildFollowupContext()` 하나다.
   * 이 helper도 더 이상 soulstream_session을 만들지 않고, 일반 후속 턴 delta + running_sessions를
   * 반환한다.
   */
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
    const pageAnchored = await this.pageContextResolver.hasPageAnchor(task, agent);
    const { folderPrompt } = await this._resolveFolder(task);
    const agentAtomMarkdown = await this._fetchAgentAtomContext(agent);
    return this._composeSystemPrompt({
      agentAtomMarkdown,
      folderPrompt: pageAnchored ? undefined : folderPrompt,
      taskSystemPrompt: task.systemPrompt,
    });
  }

  /**
   * Python `build(task, claude_runner)` 정본.
   *
   * 호출 시점은 task_executor의 *신규 첫 turn 진입 전* (interventionQueue 비어있을 때).
   * Auto-resume·intervention turn은 본 helper 호출 안 함 — Python `_resolve_folder` L100
   * (`task.resume_session_id is None`) 정합.
   */
  async build(task: Task, agent: AgentProfile): Promise<PreparedContext> {
    const pageContext = await this.pageContextResolver.resolve(task, agent);
    const pageAnchored = pageContext.kind === "page-anchor";
    const folder = await this._resolveFolder(task);
    const agentAtomMarkdown = await this._fetchAgentAtomContext(agent);
    const atomMarkdown = pageAnchored
      ? null
      : await this._fetchAtomContext(folder.atomContextSpecs);
    const boardWorkspaceItem = pageAnchored
      ? null
      : await fetchBoardWorkspaceContextItem(this.db, this.logger, folder.folderId);
    const primaryContainer = await resolvePrimarySessionContainerContext(
      this.db,
      this.logger,
      task.agentSessionId,
      folder.folderName,
    );
    const runningSessionsItem = await fetchRunningSessionsContextItem(
      this.db,
      this.logger,
      task.agentSessionId,
    );
    const cogitoContextItem = await this._fetchCogitoContext();
    const { workingDir, maxTurns } = this._resolveProfile(task);
    return this._assembleContext({
      task,
      agent,
      folderName: folder.folderName,
      folderPrompt: pageAnchored ? undefined : folder.folderPrompt,
      agentAtomMarkdown,
      atomMarkdown,
      primaryContainer,
      pageContextItem: pageAnchored ? pageContext.contextItem : null,
      suppressRunbookGuidance: pageAnchored,
      boardWorkspaceItem,
      runningSessionsItem,
      cogitoContextItem,
      workingDir,
      maxTurns,
    });
  }

  /**
   * sessions.folder_id → folders row → settings 추출 (Python L73-105).
   *
   * settings는 jsonb dict인 케이스만 통과 (Python isinstance(dict) 가드 정합).
   * 본 PR은 *신규 task에만* 폴더 프롬프트 적용 — 호출자가 이미 분기 보장하므로 본 메서드에서
   * resume 가드는 생략 (Python L100은 호출자 분기와 중복이지만 안전망).
   */
  private async _resolveFolder(task: Task): Promise<{
    folderId?: string;
    folderName?: string;
    folderPrompt?: string;
    atomContextSpecs?: AtomContextSpec[];
  }> {
    let sessionRow;
    try {
      sessionRow = await this.db.getSession(task.agentSessionId);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "_resolveFolder: getSession failed",
      );
      return {};
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
    return { folderId: folderRow.id, folderName, folderPrompt, atomContextSpecs };
  }

  private async _resolveFolderChain(folderRow: {
    id: string;
    parent_folder_id?: string | null;
    settings?: Record<string, unknown>;
  }): Promise<FolderChainEntry[]> {
    const fallback: FolderChainEntry[] = [
      {
        id: folderRow.id,
        parentFolderId: folderRow.parent_folder_id ?? null,
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

  /**
   * folder chain의 settings.atomContextNode가 dict이면 atom API 호출.
   *
   * `{nodeId, depth?, titlesOnly?}` 형식. nodeId 누락 또는 atom 비활성 → null.
   * 실패는 graceful — turn 시작 차단하지 않음 (Python try/except).
   */
  private async _fetchAtomContext(
    specs?: AtomContextSpec[],
  ): Promise<string | null> {
    if (!specs || specs.length === 0) return null;
    if (specs.length > 1) {
      return await fetchAtomContexts(this.cfg.atom, specs, this.logger);
    }
    const spec = specs[0];
    if (!spec) return null;
    return await fetchAtomContext(
      this.cfg.atom,
      spec.nodeId,
      spec.depth,
      spec.titlesOnly,
      this.logger,
    );
  }

  /**
   * agents.yaml `atom_contexts`는 agent profile 정본 지시문이다.
   *
   * CLAUDE.md / AGENTS.md / skills를 대체하는 장기 경로이므로 context_item이 아니라
   * system prompt 맨 앞에 주입한다. 여러 노드를 순서대로 compile하며, 각 노드 실패는
   * fetchAtomContexts 내부에서 skip되어 전체 turn 시작을 막지 않는다.
   */
  private async _fetchAgentAtomContext(agent: AgentProfile): Promise<string | null> {
    const specs = (agent.atom_contexts ?? []).map((ctx) => ({
      nodeId: ctx.node_id,
      depth: ctx.depth,
      titlesOnly: ctx.titles_only,
    }));
    return await fetchAtomContexts(this.cfg.atom, specs, this.logger);
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

  /**
   * profile_id → agent registry 조회 (Python L122-135).
   *
   * codex 노드는 allowed/disallowed_tools를 SDK가 받지 않아 메타만 보존(별건 카드).
   * workspace_dir와 max_turns만 반환.
   */
  private _resolveProfile(task: Task): {
    workingDir?: string;
    maxTurns?: number;
  } {
    if (!task.profileId) return {};
    const profile = this.registry.get(task.profileId);
    if (!profile) return {};
    return {
      workingDir: profile.workspace_dir,
      maxTurns: profile.max_turns,
    };
  }

  /**
   * 최종 PreparedContext 조립 (Python L137-202).
   *
   *   effectiveSystemPrompt = agent.atom_contexts + folder_prompt + task.systemPrompt
   *                           (있는 값만 "\n\n"로 연결)
   *   effectiveWorkspaceDir = profile.workspace_dir ?? agent.workspace_dir
   *   combinedContextItems  = [soulstream_item] + [cogito_context if configured]
   *                           + [atom_context if present] + task.contextItems
   *   assembledPrompt       = assemblePrompt(task.prompt, task.context) — 현재 task.context 없음
   */
  private _assembleContext(args: {
    task: Task;
    agent: AgentProfile;
    folderName?: string;
    folderPrompt?: string;
    agentAtomMarkdown: string | null;
    atomMarkdown: string | null;
    primaryContainer: PrimarySessionContainerContext | null;
    pageContextItem: ContextItem | null;
    suppressRunbookGuidance: boolean;
    boardWorkspaceItem: ContextItem | null;
    runningSessionsItem: ContextItem | null;
    cogitoContextItem: ContextItem | null;
    workingDir?: string;
    maxTurns?: number;
  }): PreparedContext {
    const effectiveSystemPrompt = this._composeSystemPrompt({
      agentAtomMarkdown: args.agentAtomMarkdown,
      folderPrompt: args.folderPrompt,
      taskSystemPrompt: args.task.systemPrompt,
    });

    const effectiveWorkspaceDir = args.workingDir ?? args.agent.workspace_dir;

    const soulstreamItem = buildSoulstreamContextItem({
      agentSessionId: args.task.agentSessionId,
      claudeSessionId: args.task.codexThreadId ?? null,
      workspaceDir: effectiveWorkspaceDir,
      folderName: args.folderName,
      nodeId: this.cfg.nodeId,
      agentId: args.task.profileId,
      callerInfo: args.task.callerInfo,
      container: args.primaryContainer?.container ?? null,
      sourceRunbookItemId: args.primaryContainer?.sourceRunbookItemId ?? null,
      runbookGuidance: args.suppressRunbookGuidance
        ? null
        : args.primaryContainer?.runbookGuidance ?? null,
    });

    const combinedContextItems: ContextItem[] = [soulstreamItem];
    if (args.pageContextItem) {
      combinedContextItems.push(args.pageContextItem);
    }
    if (args.boardWorkspaceItem) {
      combinedContextItems.push(args.boardWorkspaceItem);
    }
    if (args.runningSessionsItem) {
      combinedContextItems.push(args.runningSessionsItem);
    }
    if (args.cogitoContextItem) {
      combinedContextItems.push(args.cogitoContextItem);
    }
    if (args.atomMarkdown) {
      combinedContextItems.push({
        key: "atom_context",
        label: "atom 트리",
        content: args.atomMarkdown,
      });
    }
    combinedContextItems.push(...(args.task.contextItems ?? []));

    const assembledPrompt = assemblePrompt(args.task.prompt, undefined);

    return {
      effectiveSystemPrompt,
      combinedContextItems,
      folderName: args.folderName,
      workingDir: args.workingDir,
      maxTurns: args.maxTurns,
      assembledPrompt,
    };
  }

  private _composeSystemPrompt(args: {
    agentAtomMarkdown: string | null;
    folderPrompt?: string;
    taskSystemPrompt?: string;
  }): string | undefined {
    const systemParts: string[] = [];
    if (args.agentAtomMarkdown) {
      systemParts.push(args.agentAtomMarkdown);
    }
    if (args.folderPrompt) {
      systemParts.push(args.folderPrompt);
    }
    if (args.taskSystemPrompt) {
      systemParts.push(args.taskSystemPrompt);
    }
    return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  }
}

/** Keeps the public and cogito-reflected context composition entrypoint stable. */
export function composeFirstTurnPrompt(ctx: PreparedContext): string {
  return composeFirstTurnPromptImpl(ctx);
}
