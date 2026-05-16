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

import { mapThreadEvent } from "./codex_event_mapper.js";
import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "./protocol.js";

export interface CodexAdapterConfig {
  workspaceDir: string;
  /** Codex API 키. undefined면 SDK가 process.env.CODEX_API_KEY 또는 ~/.codex/auth.json fallback. */
  apiKey?: string;
  /** Codex CLI 바이너리 경로 override. 운영 노드별 PATH 일관성 필요 시 사용. */
  codexPathOverride?: string;
  /** Codex CLI base URL override (custom endpoint). */
  baseUrl?: string;
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
    });
    this.logger = logger;
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    if (this.closed) {
      throw new Error("CodexEngineAdapter.execute called after close()");
    }

    const controller = new AbortController();
    this.currentTurn = controller;

    // Thread 시작 또는 재개.
    // ThreadOptions에 workingDirectory + skipGitRepoCheck=true 박음.
    // Codex CLI는 기본적으로 git 리포 강제 — soulstream의 workspaceDir이 git 리포 아닐 수 있어 명시 우회.
    const threadOptions = {
      workingDirectory: this.workspaceDir,
      skipGitRepoCheck: true,
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

    // systemPrompt는 Codex SDK ThreadOptions에 직접 표면 없음 — base_instructions config로 주입.
    // 0.130.0 d.ts: CodexOptions.config로 `--config base_instructions=...`. ThreadOptions에는 없음.
    // 본 PR 범위: systemPrompt 미지원 (B-3에서 config 주입 시 명시 처리). 호출자가 prompt에 prepend 가능.
    if (params.systemPrompt && this.logger) {
      this.logger.debug(
        "systemPrompt 옵션은 Phase B-2 어댑터에서 미반영 — B-3에서 Codex({config: {base_instructions}}) 도입",
      );
    }

    // 새 thread면 첫 yield는 thread.started → session SSE.
    // 기존 thread resume이면 thread.id가 이미 있음 — onSession 콜백 호출.
    let streamedTurn;
    try {
      streamedTurn = await thread.runStreamed(params.prompt, {
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

/** 진단·테스트용 헬퍼 — turn 진행 중인가. */
export function isCodexEngineRunning(engine: CodexEngineAdapter): boolean {
  return (
    !engine["closed"] &&
    (engine as unknown as { currentTurn: AbortController | null }).currentTurn !==
      null
  );
}
