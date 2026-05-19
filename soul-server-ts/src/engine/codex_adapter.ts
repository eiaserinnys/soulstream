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

import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import type { Logger } from "pino";

import { sanitizeCodexEnv } from "./codex_env.js";
import { mapThreadEvent } from "./codex_event_mapper.js";
import {
  classifyAttachment,
  composeCodexInput,
} from "./attachment_converter.js";
import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "./protocol.js";

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
    const threadOptions = {
      workingDirectory: this.workspaceDir,
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      sandboxMode: "danger-full-access" as const,
      ...(params.model ? { model: params.model } : {}),
    };

    let thread: Thread;
    if (params.resumeSessionId) {
      thread = this.codex.resumeThread(params.resumeSessionId, threadOptions);
      this.logger.debug(
        { sessionId: params.resumeSessionId },
        "Resumed Codex thread",
      );
    } else {
      thread = this.codex.startThread(threadOptions);
      this.logger.debug({ workspaceDir: this.workspaceDir }, "Started new Codex thread");
    }

    // 첨부 처리 (Phase 2 — spec-reviewer 보강 1/3·2/3 반영):
    //
    // 정책: rejected 발생 시 *전체 turn abort*.
    //   - 업로드 단계 fileManager.validateFile이 확장자 blacklist + 크기 검증을 이미 통과.
    //   - 본 단계의 rejected는 "codex가 소비 불가한 형식"(.pdf, .docx 등 capability table 미포함).
    //   - 사용자 명시 첨부 중 일부만 처리하면 의도 어긋남 → design-principles §4 명시 실패.
    //   → assistant_error emit + turn 종료. 사용자가 거부된 파일 인지 후 재시도 결정.
    //
    // emit 방식: *yield 전용* (spec-reviewer 보강 2/3 — params.onEvent 사용 금지).
    //   onEvent는 부가 콜백이며 yield 없이 onEvent만 호출하면 wire·DB에 기록되지 않음
    //   (task_executor._processEvent가 persist + broadcaster + side-effect 3단계를 수행).
    const conversions = (params.attachmentPaths ?? []).map(classifyAttachment);
    const rejected = conversions.filter((c) => c.kind === "rejected");
    if (rejected.length > 0) {
      // 🔵 #9 — 거부 시 assistant_error emit + turn 종료
      yield {
        type: "assistant_error",
        message: `첨부 거부: ${rejected.map((r) => (r as Extract<typeof r, { kind: "rejected" }>).reason).join(", ")}`,
        fatal: false,
      } as SSEEventPayload;
      this.currentTurn = null;
      return;
    }
    const textConvs = conversions.filter((c) => c.kind === "text-reference");
    if (textConvs.length > 0) {
      // 🟡 #7 — 텍스트 변환 알림 (yield → task_executor._processEvent가 persist + broadcast)
      yield {
        type: "system_message",
        text: `다음 첨부를 텍스트 인용으로 전달했습니다:\n${textConvs.map((c) => "- " + (c as Extract<typeof c, { kind: "text-reference" }>).path).join("\n")}`,
      } as SSEEventPayload;
    }
    // prompt + text-reference 인용 합성 → Input (image 있으면 UserInput[], 없으면 string)
    const codexInput = composeCodexInput(params.prompt, conversions);

    // 새 thread면 첫 yield는 thread.started → session SSE.
    // 기존 thread resume이면 thread.id가 이미 있음 — onSession 콜백 호출.
    let streamedTurn;
    try {
      streamedTurn = await thread.runStreamed(codexInput, {
        signal: controller.signal,
      });
    } catch (err) {
      this.logger.warn({ err }, "thread.runStreamed throw");
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      } as SSEEventPayload;
      this.currentTurn = null;
      return;
    }

    try {
      for await (const threadEvent of streamedTurn.events) {
        // thread.started 발견 시 onSession 콜백 (호출자가 task에 영속).
        if (threadEvent.type === "thread.started" && params.onSession) {
          await params.onSession(threadEvent.thread_id);
        }

        const ssePayloads = mapThreadEvent(threadEvent);
        for (const payload of ssePayloads) {
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
          message: err instanceof Error ? err.message : String(err),
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
