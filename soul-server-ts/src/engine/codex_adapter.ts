/**
 * Codex EnginePort 구현 — `@openai/codex-sdk@^0.130.0` SDK 모드 단독.
 *
 * 옵션 D 비대칭 모델 단계 1 (Phase B-2). SDK 채택 정당성: 4차 캐시 §3.2 — "각 백엔드를
 * 그 SDK의 정본 언어에서". subprocess fallback 없음 — TS 정본 우월성 유지.
 *
 * Codex SDK API 표면(/tmp/codex-sdk/package/dist/index.d.ts 정본):
 * - `new Codex({apiKey?, env?, config?, baseUrl?})` — 인스턴스
 * - `codex.startThread({workingDirectory, skipGitRepoCheck, model?})` → Thread
 * - `codex.resumeThread(id, options?)` → Thread
 * - `thread.runStreamed(input, {signal?})` → `{events}` AsyncGenerator<ThreadEvent>
 *
 * 본 PR 범위:
 * - 어댑터 자체 + 이벤트 매핑.
 * - *세션 lifecycle 통합*은 B-3 (task_executor 신설 시 본 어댑터를 주입).
 * - onIntervention: SDK 표면 없음 — 조용히 무시 (interface 시그니처 유지).
 * - onCompact: Codex는 compact 이벤트 없음 — 호출 안 됨.
 */

import { Codex, type Thread, type ThreadEvent, type Input } from "@openai/codex-sdk";
import type { Logger } from "pino";

import { sanitizeCodexEnv } from "./codex_env.js";
import { mapThreadEvent } from "./codex_event_mapper.js";
import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  ReasoningEffort,
  SSEEventPayload,
} from "./protocol.js";

const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";

const NON_REASONING_MODEL_PATTERNS = [
  /^gpt-4o(?:$|[-_.])/i,
  /^gpt-4\.1(?:$|[-_.])/i,
  /^gpt-4(?:$|[-_.])/i,
  /^gpt-3\.5(?:$|[-_.])/i,
];

export function resolveCodexModelReasoningEffort(
  model: string | null | undefined,
  requested: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  const effort = requested ?? DEFAULT_REASONING_EFFORT;
  if (!model) return effort;
  if (NON_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(model))) {
    return undefined;
  }
  return effort;
}

export interface CodexAdapterConfig {
  workspaceDir: string;
  /**
   * Codex API 키. undefined·빈 문자열이면 SDK가 sanitize된 env의 CODEX_API_KEY 또는
   * `~/.codex/auth.json`(ChatGPT OAuth) fallback.
   *
   * 주의: 본 어댑터가 SDK에 env를 명시 전달한 이후로 SDK 내부 `process.env` 상속 경로는
   * 사용되지 않는다 — `codex_env.ts`의 sanitize 결과만 자식 codex CLI에 도달한다.
   */
  apiKey?: string;
  /** Codex CLI 바이너리 경로 override. 운영 노드별 PATH 일관성 필요 시 사용. */
  codexPathOverride?: string;
  /** Codex CLI base URL override (custom endpoint). */
  baseUrl?: string;
  /**
   * Codex CLI 자식 프로세스에 전달할 env의 base. 미지정 시 `process.env`.
   *
   * SDK는 `env` 옵션이 제공되면 process.env를 상속하지 *않고* 이 값만 사용한다
   * (`@openai/codex-sdk` dist/index.js:222-231). 본 어댑터는 빈 문자열 OPENAI_API_KEY /
   * CODEX_API_KEY를 sanitize한 결과를 SDK에 항상 명시 전달하여, pm2 god 등 외부 셸이
   * inject한 빈 키가 codex-rs를 API key 모드로 강제 분기시키는 사고를 차단한다
   * (분석 캐시 `20260517-1157-codex-ts-oauth-401.md`).
   */
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * Codex 백엔드용 EnginePort 구현.
 *
 * lifecycle:
 * 1. constructor: Codex SDK 인스턴스 생성. workspaceDir·apiKey 저장.
 * 2. execute(): turn 1회당 새 AbortController + Thread (start 또는 resume) + runStreamed.
 * 3. interrupt(): 진행 중 AbortController에 abort 신호.
 * 4. close(): 정리. Codex SDK는 명시 close 없음 — flag만 토글.
 *
 * idempotent close + 동시 execute 안전(각 turn이 자체 AbortController).
 */
export class CodexEngineAdapter implements EnginePort {
  public readonly backendId: BackendId = "codex";
  public readonly workspaceDir: string;

  private readonly codex: Codex;
  private readonly logger: Logger;
  private readonly codexPathOverride: string | undefined;
  private closed = false;

  /** 가장 최근 turn의 AbortController. interrupt() 시 사용. */
  private currentTurn: AbortController | null = null;

  constructor(config: CodexAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.codex = new Codex({
      apiKey: config.apiKey,
      codexPathOverride: config.codexPathOverride,
      baseUrl: config.baseUrl,
      // env를 명시 전달하면 SDK가 process.env를 상속하지 않는다 — pm2 god 셸의 빈
      // OPENAI_API_KEY/CODEX_API_KEY 누수를 어댑터 경계에서 차단 (design-principles §1·§6).
      env: sanitizeCodexEnv(config.processEnv ?? process.env),
    });
    this.logger = logger;
    this.codexPathOverride = config.codexPathOverride;
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    if (this.closed) {
      throw new Error("CodexEngineAdapter.execute called after close()");
    }
    // 동시 execute 가드 — 첫 turn 진행 중 두 번째 호출 차단 (P2-3, design-principles §4 명시 실패).
    // 첫 turn의 controller가 currentTurn 덮어쓰기로 *고립*되면 interrupt() 불가능.
    // 호출자(B-3 task_executor)는 한 어댑터 인스턴스당 한 번에 하나의 turn만 실행해야 한다.
    if (this.currentTurn) {
      throw new Error(
        "CodexEngineAdapter.execute: concurrent turn not supported — call interrupt()+drain previous turn first",
      );
    }

    if (params.systemPrompt) {
      // Codex SDK 0.130.0 ThreadOptions에 systemPrompt 표면 없음 — CodexOptions.config.base_instructions로
      // 주입해야 하나 본 어댑터 인스턴스 단위 config는 constructor에서 받음. turn-level systemPrompt 주입은
      // B-3에서 task_executor가 호출자 책임으로 prompt에 prepend하거나, 본 어댑터를 재생성하는 패턴.
      // design-principles §4 (명시적 실패) — debug 대신 warn으로 격상하여 호출자 가시화 (P2-2).
      this.logger.warn(
        { hasSystemPrompt: true },
        "CodexEngineAdapter: systemPrompt is ignored — Codex SDK turn-level systemPrompt 미지원. 호출자가 prompt에 prepend 필요 (B-3에서 정밀화)",
      );
    }

    const controller = new AbortController();
    this.currentTurn = controller;

    // Thread 시작 또는 재개.
    // ThreadOptions — Python claude `permission_mode="bypassPermissions"` 의미 등가:
    //   - workingDirectory + skipGitRepoCheck=true: workspaceDir이 git 리포 아닐 수 있어 명시 우회.
    //   - sandboxMode="danger-full-access": codex CLI 0.130.0 `exec` 모드의 MCP tool call은
    //     `workspace-write`·`read-only` 모드에서 자동 cancel된다 — approval gate가 stdin 채널 없는
    //     exec 모드에서 자동 deny. `approval_policy="never"`는 *shell command*만 통제하고 *MCP
    //     tool call*은 sandbox 모드와 결합된 별 게이트라 풀리지 않음. `danger-full-access`만
    //     MCP를 허용. 분석 캐시 `20260518-1115-codex-network-retry-sync.md` §A-r2 매트릭스:
    //       - workspace-write + network_access=true + approval=never → MCP cancel
    //       - danger-full-access + approval=never → MCP 결과 반환
    //       - --dangerously-bypass-approvals-and-sandbox → MCP 결과 반환
    //     Python claude `client_lifecycle.py:238 permission_mode="bypassPermissions"`가 의미상
    //     같은 자세 — codex 노드 user 권한 범위로 격리되며, workspaceDir 격리는 *논리적*이고
    //     model이 destructive 시도를 자율로 안 하는 가정에 의존(claude 정합).
    //   - approvalPolicy="never": shell command approval bypass. danger-full-access로 이미
    //     우회되므로 본질적으로 *불필요*이나 안전망으로 유지. codex CLI 도움말 권고:
    //     "Prefer `never` for non-interactive runs".
    //
    // PR #60 (`workspace-write` + `networkAccessEnabled=true`) 라이브 실효 결손 — 본 PR fix-forward.
    // PR #60의 진단(`networkAccessEnabled`가 MCP cancel을 푼다는 가설)이 부분 오진단이었음 —
    // `networkAccessEnabled`는 *shell command outbound*에만 영향하지 MCP tool과 무관.
    // 진정한 root cause는 sandbox 모드의 MCP 게이트.
    const model = typeof params.model === "string" && params.model.trim()
      ? params.model.trim()
      : undefined;
    const modelReasoningEffort = resolveCodexModelReasoningEffort(
      model,
      params.reasoningEffort,
    );
    const threadOptions = {
      workingDirectory: this.workspaceDir,
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      sandboxMode: "danger-full-access" as const,
      ...(model ? { model } : {}),
      ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    };
    if (model && !modelReasoningEffort) {
      this.logger.warn(
        { model, reasoningEffort: params.reasoningEffort ?? DEFAULT_REASONING_EFFORT },
        "CodexEngineAdapter: dropping reasoning effort for non-reasoning model",
      );
    }

    let thread: Thread;
    if (params.resumeSessionId) {
      try {
        thread = this.codex.resumeThread(params.resumeSessionId, threadOptions);
      } catch (err) {
        if (isNoRolloutFoundResumeError(err)) {
          this.logger.warn(
            { err, sessionId: params.resumeSessionId },
            "Codex resume skipped: rollout not found",
          );
          this.currentTurn = null;
          return;
        }
        throw err;
      }
      this.logger.debug(
        { sessionId: params.resumeSessionId },
        "Resumed Codex thread",
      );
    } else {
      thread = this.codex.startThread(threadOptions);
      this.logger.debug({ workspaceDir: this.workspaceDir }, "Started new Codex thread");
    }

    // 새 thread면 첫 yield는 thread.started → session SSE.
    // 기존 thread resume이면 thread.id가 이미 있음 — onSession 콜백 호출.
    let streamedTurn;
    try {
      streamedTurn = await thread.runStreamed(buildCodexInput(params), {
        signal: controller.signal,
      });
    } catch (err) {
      if (params.resumeSessionId && isNoRolloutFoundResumeError(err)) {
        this.logger.warn(
          { err, sessionId: params.resumeSessionId },
          "Codex resume skipped: rollout not found",
        );
        this.currentTurn = null;
        return;
      }
      this.logger.warn({ err }, "thread.runStreamed throw");
      yield {
        type: "error",
        message: formatCodexExecutionErrorMessage(err, this.codexPathOverride),
        fatal: true,
      } as SSEEventPayload;
      this.currentTurn = null;
      return;
    }

    // F3 (PR fix/soul-server-ts-chat-sse-python-parity): turn 단위 lastAgentText 추적.
    // codex SDK 0.130.0 `Turn.finalResponse: string` 필드(`dist/index.d.ts:176`)와 의미 등가 —
    // streamed 모드에서는 events generator만 제공되므로 adapter가 직접 추적.
    // turn.completed 이벤트의 SDK docstring: "Emitted when a turn is completed. Typically right
    // after the assistant's response." (`dist/index.d.ts:129-133`) → agent_message item.completed
    // 이후 turn.completed 순서가 보장된다. 따라서 turn.completed payload에 lastAgentText를
    // `result`로 enrichment해도 race 없음. graceful: 없으면 result 키 omit (soul-ui node-factory.ts:167
    // `e.result ?? "Session completed"` 폴백이 그대로 동작 → PR 이전 behavior).
    let lastAgentText: string | undefined;
    try {
      for await (const threadEvent of streamedTurn.events) {
        // thread.started 발견 시 onSession 콜백 (호출자가 task에 영속).
        if (threadEvent.type === "thread.started" && params.onSession) {
          await params.onSession(threadEvent.thread_id);
        }

        // last agent_message text 추적 — turn.completed 시점에 complete.result로 주입.
        // codex_event_mapper.ts:213-233에 따르면 item.completed(agent_message)는 텍스트 누적값을
        // 운반한다 (codex-rs는 progressive streaming을 안 emit). 한 turn에 agent_message가
        // 여러 번 오면 *마지막 값*이 turn의 최종 답.
        if (
          threadEvent.type === "item.completed" &&
          threadEvent.item.type === "agent_message"
        ) {
          lastAgentText = threadEvent.item.text;
        }

        const ssePayloads = mapThreadEvent(threadEvent);
        for (const payload of ssePayloads) {
          // F3 enrichment: complete payload에 lastAgentText를 `result`로 주입.
          // Python `complete` 이벤트의 `result` 키와 정합 (mcp_session_query PREVIEW_FIELD_MAP
          // `["complete"]="result"` + soul-ui node-factory.ts:167 `e.result ?? "Session completed"`).
          // mapper는 stateless 유지 (모듈 docstring 정본) — turn-level 상태는 adapter 책임.
          if (
            (payload as { type: string }).type === "complete" &&
            lastAgentText !== undefined
          ) {
            (payload as Record<string, unknown>).result = lastAgentText;
          }
          // onEvent 부가 콜백 — yield와 *별도로* 같은 페이로드 발행.
          if (params.onEvent) {
            await params.onEvent(payload);
          }
          yield payload;
        }
      }
    } catch (err) {
      // for await 도중 abort 또는 stream 오류.
      if (controller.signal.aborted) {
        this.logger.info("Codex turn aborted by interrupt()");
      } else {
        this.logger.warn({ err }, "Codex stream error mid-turn");
        yield {
          type: "error",
          message: formatCodexExecutionErrorMessage(err, this.codexPathOverride),
          fatal: true,
        } as SSEEventPayload;
      }
    } finally {
      this.currentTurn = null;
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.currentTurn) {
      this.logger.debug("interrupt called with no active turn — no-op");
      return false;
    }
    this.currentTurn.abort();
    this.logger.info("Codex turn interrupt requested");
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // 진행 중 turn 있으면 abort.
    if (this.currentTurn) {
      this.currentTurn.abort();
      this.currentTurn = null;
    }
    // Codex SDK 0.130.0은 명시 close 없음 — flag로만 lifecycle 표시.
  }
}

function isNoRolloutFoundResumeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return lower.includes("thread/resume") && lower.includes("no rollout found");
}

export function formatCodexExecutionErrorMessage(
  err: unknown,
  codexPathOverride: string | undefined,
): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const isEarlyStdinFailure =
    lower.includes("stream was destroyed") ||
    lower.includes("write after end") ||
    lower.includes("epipe") ||
    lower.includes("child process has no stdin");
  if (!isEarlyStdinFailure) {
    return message;
  }

  const pathHint = codexPathOverride
    ? `codexPathOverride=${codexPathOverride}`
    : "codexPathOverride not set";
  return [
    "Codex CLI exited before Soulstream could write the prompt",
    `(${pathHint})`,
    message,
    "Check CODEX_CLI_PATH/PATH and run codex --version on the node.",
  ].join(": ");
}

function buildCodexInput(params: EngineExecuteParams): Input {
  if (!params.imageAttachmentPaths || params.imageAttachmentPaths.length === 0) {
    return params.prompt;
  }
  return [
    { type: "text", text: params.prompt },
    ...params.imageAttachmentPaths.map((path) => ({
      type: "local_image" as const,
      path,
    })),
  ];
}
