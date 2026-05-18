/**
 * ExecutionContextBuilder — B-6 풀세트, Python `service/execution_context_builder.py` 정본 이식.
 *
 * codex task 첫 turn 진입 전에 다음을 조립:
 *   1. _resolveFolder    — sessions.folder_id → folder.settings (folderPrompt·atomContextNode)
 *   2. _fetchAtomContext — atomContextNode가 있고 신규 task면 atom HTTP API → 마크다운
 *   3. _resolveProfile   — agents.yaml profile에서 workspace_dir·max_turns·tools
 *   4. _assembleContext  — folder_prompt + system_prompt + soulstream_item + atom_context를
 *      합쳐 PreparedContext 반환
 *
 * 호출자(task_executor)는 codex SDK가 turn-level systemPrompt를 지원하지 않으므로 (분석 캐시
 * `20260517-2338-codex-ts-context-builder-B-6.md` §B), `composeFirstTurnPrompt` helper로
 * 합성 prompt를 만들어 engine.execute에 넘긴다.
 *
 * 신규 task에만 적용 — auto-resume·intervention turn은 PR #54·#55 흐름 그대로 유지.
 */

import type { Logger } from "pino";

import type { AgentRegistry, AgentProfile } from "../agent_registry.js";
import type { SessionDB } from "../db/session_db.js";
import type { Task } from "../task/task_models.js";

import { fetchAtomContext } from "./atom_context.js";
import {
  assemblePrompt,
  formatContextItems,
  type ContextItem,
} from "./prompt_assembler.js";
import { buildSoulstreamContextItem } from "./soulstream_item.js";

/** Python `_PreparedContext` (execution_context_builder.py:24-34) TS 등가. */
export interface PreparedContext {
  /** folder_prompt prepended (folder_prompt + "\n\n" + task.systemPrompt). */
  effectiveSystemPrompt?: string;
  /** soulstream_item + atom_context + task.contextItems (현재 빈 배열). */
  combinedContextItems: ContextItem[];
  folderName?: string;
  /** profile.workspace_dir (있으면). 호출자가 agent.workspace_dir로 폴백. */
  workingDir?: string;
  /** profile.max_turns (codex SDK 미지원 — 메타 보존). */
  maxTurns?: number;
  /** Python `assembled_prompt` 등가 — 현재 task.prompt 그대로 (task.context wire 별건). */
  assembledPrompt: string;
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
}

export class ExecutionContextBuilder {
  constructor(
    private readonly db: SessionDB,
    private readonly registry: AgentRegistry,
    private readonly cfg: ContextBuilderConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Auto-resume·intervention 흐름이 user_message wire에 박을 context_items를 조립한다.
   *
   * Phase A context 정본 진입점 (atom d7a1ad86 정본 둘 안티패턴 차단):
   * - 첫 턴(`build()` → `_assembleContext` 내부 `buildSoulstreamContextItem`)과 본 method가
   *   *같은 helper `buildSoulstreamContextItem`을 호출*하여 soulstream_session context_item을
   *   조립 — design-principles §3 정본 하나.
   * - 본 method는 system_prompt 합성 / atom_context fetch / 첫 턴 prompt 합성을 *제외*하고
   *   soulstream_item만 만든다. auto-resume은 SDK가 system_prompt를 보유 + atom_context는
   *   신규 task 전용 (Python `task.resume_session_id is None` 정합).
   *
   * 호출자: `TaskManager._addInterventionAutoResume` (terminal-resume 시 user_message context).
   * 실패 격리: 본 method가 throw하면 호출자는 context 없이 user_message만 박는다
   *           (design-principles §8 — context 빌더 실패가 핵심 user_message persist를 막지 않음).
   */
  async buildResumeContextItems(task: Task, agent: AgentProfile): Promise<ContextItem[]> {
    const { folderName } = await this._resolveFolder(task);
    const { workingDir } = this._resolveProfile(task);
    const effectiveWorkspaceDir = workingDir ?? agent.workspace_dir;

    const soulstreamItem = buildSoulstreamContextItem({
      agentSessionId: task.agentSessionId,
      claudeSessionId: task.codexThreadId ?? null,
      workspaceDir: effectiveWorkspaceDir,
      folderName,
      nodeId: this.cfg.nodeId,
      agentId: task.profileId,
      callerInfo: task.callerInfo,
    });
    return [soulstreamItem];
  }

  /**
   * Python `build(task, claude_runner)` 정본.
   *
   * 호출 시점은 task_executor의 *신규 첫 turn 진입 전* (interventionQueue 비어있을 때).
   * Auto-resume·intervention turn은 본 helper 호출 안 함 — Python `_resolve_folder` L100
   * (`task.resume_session_id is None`) 정합.
   */
  async build(task: Task, agent: AgentProfile): Promise<PreparedContext> {
    const { folderName, folderPrompt, folderSettings } = await this._resolveFolder(task);
    const atomMarkdown = await this._fetchAtomContext(folderSettings);
    const { workingDir, maxTurns } = this._resolveProfile(task);
    return this._assembleContext({
      task,
      agent,
      folderName,
      folderPrompt,
      atomMarkdown,
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
    folderName?: string;
    folderPrompt?: string;
    folderSettings?: Record<string, unknown>;
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
    const settings = folderRow.settings;
    const folderPromptValue = settings.folderPrompt;
    const folderPrompt =
      typeof folderPromptValue === "string" && folderPromptValue ? folderPromptValue : undefined;
    return { folderName, folderPrompt, folderSettings: settings };
  }

  /**
   * folder.settings.atomContextNode가 dict이면 atom API 호출 (Python L107-120).
   *
   * `{nodeId, depth?, titlesOnly?}` 형식. nodeId 누락 또는 atom 비활성 → null.
   * 실패는 graceful — turn 시작 차단하지 않음 (Python try/except).
   */
  private async _fetchAtomContext(
    folderSettings?: Record<string, unknown>,
  ): Promise<string | null> {
    if (!folderSettings) return null;
    const cfg = folderSettings.atomContextNode;
    if (!cfg || typeof cfg !== "object") return null;
    const nodeId = (cfg as Record<string, unknown>).nodeId;
    if (typeof nodeId !== "string" || !nodeId) return null;
    const depth = typeof (cfg as Record<string, unknown>).depth === "number"
      ? ((cfg as Record<string, unknown>).depth as number)
      : 3;
    const titlesOnly = Boolean((cfg as Record<string, unknown>).titlesOnly);
    return await fetchAtomContext(
      this.cfg.atom,
      nodeId,
      depth,
      titlesOnly,
      this.logger,
    );
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
   *   effectiveSystemPrompt = folder_prompt + "\n\n" + task.systemPrompt (folder_prompt 있으면)
   *   effectiveWorkspaceDir = profile.workspace_dir ?? agent.workspace_dir
   *   combinedContextItems  = [soulstream_item] + [atom_context if present] + task.contextItems
   *   assembledPrompt       = assemblePrompt(task.prompt, task.context) — 현재 task.context 없음
   */
  private _assembleContext(args: {
    task: Task;
    agent: AgentProfile;
    folderName?: string;
    folderPrompt?: string;
    atomMarkdown: string | null;
    workingDir?: string;
    maxTurns?: number;
  }): PreparedContext {
    const taskSystemPrompt = args.task.systemPrompt;
    let effectiveSystemPrompt: string | undefined = taskSystemPrompt;
    if (args.folderPrompt) {
      effectiveSystemPrompt = taskSystemPrompt
        ? `${args.folderPrompt}\n\n${taskSystemPrompt}`
        : args.folderPrompt;
    }

    const effectiveWorkspaceDir = args.workingDir ?? args.agent.workspace_dir;

    const soulstreamItem = buildSoulstreamContextItem({
      agentSessionId: args.task.agentSessionId,
      claudeSessionId: args.task.codexThreadId ?? null,
      workspaceDir: effectiveWorkspaceDir,
      folderName: args.folderName,
      nodeId: this.cfg.nodeId,
      agentId: args.task.profileId,
      callerInfo: args.task.callerInfo,
    });

    const combinedContextItems: ContextItem[] = [soulstreamItem];
    if (args.atomMarkdown) {
      combinedContextItems.push({
        key: "atom_context",
        label: "atom 트리",
        content: args.atomMarkdown,
      });
    }
    // task.contextItems wire는 별건 카드 — 현재 빈 배열만 처리

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
}

/**
 * codex SDK는 turn-level systemPrompt를 지원하지 않으므로, claude의
 * `system_prompt + context_items + assembled_prompt` 흐름을 *단일 prompt 문자열*로 합성한다.
 *
 * 합성 순서 (분석 캐시 §C-5):
 *   [effectiveSystemPrompt]\n\n[<context>...</context>]\n\n[assembledPrompt]
 *
 * 비어있는 component는 skip. 모두 비면 assembledPrompt만 반환.
 */
export function composeFirstTurnPrompt(ctx: PreparedContext): string {
  const parts: string[] = [];
  if (ctx.effectiveSystemPrompt) {
    parts.push(ctx.effectiveSystemPrompt);
  }
  const contextBlock = formatContextItems(ctx.combinedContextItems);
  if (contextBlock) {
    parts.push(contextBlock);
  }
  parts.push(ctx.assembledPrompt);
  return parts.join("\n\n");
}
