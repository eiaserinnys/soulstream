import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import {
  readClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import { readClaudeSdkSessionMetadata } from
  "../engine/claude_sdk_session_metadata.js";
import { readClaudeResultReceiptMetadata } from
  "../engine/claude_result_receipt_metadata.js";
import type { ClaudeDeliveryTranscriptReceiptReader } from
  "../engine/claude_delivery_transcript_receipt.js";

import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskManager } from "./task_manager.js";
import { isTerminalTaskStatus, type Task } from "./task_models.js";
import { buildClaudeRuntimeFollowupDelivery } from "./claude_runtime_followup_delivery.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import {
  buildClaudeRuntimeTaskFollowupPrompt,
  buildFollowupKey,
  type PendingRuntimeTaskFollowup,
} from "./claude_runtime_task_followup_prompt.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "./claude_background_generation_identity.js";
import { CLAUDE_BACKGROUND_UNRECOVERABLE_SENTENCE } from
  "./claude_background_retention_notice.js";
import { hasPendingClaudeBackgroundRuntimeWork } from "./claude_runtime_state.js";
import type { ClaudeBackgroundConsumptionProof } from
  "./claude_background_result_consumption.js";
import { parseClaudeNativeTaskNotification } from
  "./claude_native_task_notification.js";
import {
  normalizeRuntimeEventRevision as normalizeEventRevision,
  normalizeRuntimeRevision as normalizeRevision,
  runtimeRecord as asRecord,
  runtimeString as asString,
} from "./claude_runtime_followup_utils.js";

export const CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE = "claude_runtime_task_followup";

/** native 알림 턴이 소울스트림 턴으로 이어지기를 기다리는 기본 시한(2분). */
export const DEFAULT_CLAUDE_BACKGROUND_FOLLOWUP_DEADLINE_MS = 120_000;

export { buildClaudeRuntimeTaskFollowupPrompt } from
  "./claude_runtime_task_followup_prompt.js";

export interface ClaudeRuntimeTaskFollowupPort {
  /** 등록한 백그라운드 세대의 generationKey. 완료 사건이 아니면 undefined. */
  collect(task: Task, event: SSEEventPayload): string | undefined;
  flush(task: Task): Promise<void>;
  collectDetached(task: Task, event: SSEEventPayload): Promise<void>;
  reconcileTranscriptAppend(task: Task): Promise<void>;
  retireConsumedProof?(task: Task, proof: ClaudeBackgroundConsumptionProof): void;
}

export interface ClaudeRuntimeTaskFollowupDeps {
  taskManager: Pick<TaskManager, "addIntervention"> &
    Partial<Pick<TaskManager, "getDeliveryConsumptionRecorder">>;
  onResume: StartExecutionCallback;
  releaseRetainedRunner(task: Task): Promise<void>;
  /** 보유가 followup 없이 풀렸을 때 부른 세션에 알린다(R3/R5). */
  notifyBackgroundStopped?(task: Task, firstSentence: string): Promise<void>;
  transcriptReceipt?: Pick<
    ClaudeDeliveryTranscriptReceiptReader,
    "inspectInput" | "inspectNativeTaskNotification"
  >;
  logger: Logger;
  deliveryV2Enabled?: boolean;
  sourceNode: string;
  /**
   * native 소유권 대기 시한. 넘기면 그 턴을 기다리지 않고 followup을 보낸다(R1).
   */
  followupDeadlineMs?: number;
}

interface NativeDeliveryOwnership {
  sessionId: string;
  generationKey: string;
  taskId: string;
  initiatingToolUseId: string;
  phase:
    | "awaiting-input"
    | "awaiting-assistant"
    | "awaiting-result"
    | "awaiting-transcript"
    | "native-visible-unsettled";
  inputUuid?: string;
  assistantUuid?: string;
  proofEpoch: number;
}

const TERMINAL_RUNTIME_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export class ClaudeRuntimeTaskFollowupController implements ClaudeRuntimeTaskFollowupPort {
  private readonly pendingBySession = new Map<string, Map<string, PendingRuntimeTaskFollowup>>();
  private readonly flushedGenerationKeys = new Set<string>();
  private readonly durableDeliveryByGenerationKey =
    new Map<string, ClaudeBackgroundDeliveryMetadata>();
  private readonly nativeOwnershipByGenerationKey =
    new Map<string, NativeDeliveryOwnership>();
  private readonly nativeTranscriptTailByGenerationKey =
    new Map<string, Promise<boolean>>();
  private readonly ownershipDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sequence = 0;

  constructor(private readonly deps: ClaudeRuntimeTaskFollowupDeps) {}

  /**
   * 백그라운드 완료 사건을 등록하고 그 세대의 generationKey를 돌려준다.
   * 사건이 완료 통지가 아니면 undefined.
   */
  collect(task: Task, event: SSEEventPayload): string | undefined {
    const payload = event as Record<string, unknown>;
    const type = asString(payload.type);
    if (
      type !== "claude_runtime_task_notification" &&
      type !== "claude_runtime_task_updated"
    ) {
      return undefined;
    }

    const taskId = asString(payload.task_id);
    if (!taskId) return undefined;
    const runtimeTask = task.claudeRuntime?.tasks[taskId];
    const patch = type === "claude_runtime_task_updated"
      ? asRecord(payload.patch) ?? {}
      : {};
    const sdkSessionId = task.codexThreadId;
    const eventSdkSessionId = asString(payload.session_id) ??
      readClaudeSdkSessionMetadata(event)?.sessionId;
    if (eventSdkSessionId && eventSdkSessionId !== sdkSessionId) return undefined;
    const durableDelivery = readClaudeBackgroundDeliveryMetadata(event);
    const initiatingToolUseId = asString(payload.tool_use_id) ??
      asString(patch.tool_use_id) ?? durableDelivery?.initiatingToolUseId ??
      runtimeTask?.toolUseId;
    if (!sdkSessionId || !initiatingToolUseId) return undefined;
    const identity = buildClaudeBackgroundGenerationIdentity({
      sourceNode: this.deps.sourceNode,
      agentSessionId: task.agentSessionId,
      sdkSessionId,
      sdkTaskId: taskId,
      initiatingToolUseId,
    });
    if (this.flushedGenerationKeys.has(identity.generationKey)) return undefined;
    const exactRuntimeTask = runtimeTask?.toolUseId === initiatingToolUseId
      ? runtimeTask
      : undefined;
    const status = asString(payload.status) ?? asString(patch.status) ??
      exactRuntimeTask?.status;
    if (!status || !TERMINAL_RUNTIME_TASK_STATUSES.has(status)) return undefined;
    const isBackgrounded =
      Boolean(readClaudeBackgroundProvenance(event)) ||
      runtimeTask?.isBackgrounded === true ||
      patch.is_backgrounded === true;
    if (!isBackgrounded) return undefined;
    if (
      this.deps.deliveryV2Enabled === true &&
      readClaudeBackgroundProvenance(event) === "sdk_membership" &&
      !durableDelivery
    ) return undefined;
    if (durableDelivery) {
      if (
        durableDelivery.relationKey !== identity.relationKey ||
        durableDelivery.completionId !== identity.completionId ||
        durableDelivery.deliveryId !== identity.deliveryId
      ) {
        throw new Error(`Claude background generation identity mismatch: ${taskId}`);
      }
      this.durableDeliveryByGenerationKey.set(identity.generationKey, durableDelivery);
    }

    const pending = this.getPendingMap(task.agentSessionId);
    const previous = pending.get(identity.generationKey);
    pending.set(identity.generationKey, {
      ...identity,
      sdkSessionId,
      initiatingToolUseId,
      taskId,
      status,
      outputFile:
        asString(payload.output_file) ?? asString(patch.output_file) ??
        exactRuntimeTask?.outputFile ?? previous?.outputFile,
      summary:
        asString(payload.summary) ?? asString(patch.summary) ??
        exactRuntimeTask?.summary ?? previous?.summary,
      description:
        asString(patch.description) ?? exactRuntimeTask?.description ?? previous?.description,
      toolUseId: initiatingToolUseId,
      error:
        asString(payload.error) ?? asString(patch.error) ??
        exactRuntimeTask?.error ?? previous?.error,
      terminalRevision:
        normalizeEventRevision(payload._event_id) ??
        normalizeEventRevision(patch._event_id) ??
        normalizeRevision(exactRuntimeTask?.endTime ?? exactRuntimeTask?.updatedAt) ??
        previous?.terminalRevision ??
        `${status}:unknown`,
      firstSeen: previous?.firstSeen ?? this.sequence++,
    });
    if (
      readClaudeBackgroundProvenance(event) === "sdk_membership" &&
      durableDelivery?.initiatingToolUseId === initiatingToolUseId
    ) {
      this.nativeOwnershipByGenerationKey.set(identity.generationKey, {
        sessionId: task.agentSessionId,
        generationKey: identity.generationKey,
        taskId,
        initiatingToolUseId,
        phase: "awaiting-input",
        proofEpoch: 0,
      });
      // R1: native 쪽이 이 완료를 이어받든 아니든 시한 안에 정산한다.
      this.scheduleOwnershipDeadline(task, identity.generationKey);
    }
    return identity.generationKey;
  }

  async flush(task: Task): Promise<void> {
    // interrupt()가 먼저 terminal status를 박은 뒤 현재 execution이 이 메서드에 도달할 수 있다.
    // 이때 addIntervention()은 auto-resume 경로에서 같은 executionPromise를 기다리므로
    // 자기대기 교착이 된다. Pending은 지우지 않고 다음 정상 running turn까지 보존한다.
    if (task.status !== "running") return;
    if (hasPendingClaudeBackgroundRuntimeWork(task)) return;
    await this.flushPending(task);
  }

  async collectDetached(task: Task, event: SSEEventPayload): Promise<void> {
    const generationKey = this.collect(task, event);
    const ownershipBefore = this.nativeOwnershipByGenerationKey.size;
    await this.observeNativeEvent(task, event);
    if (hasPendingClaudeBackgroundRuntimeWork(task)) return;
    if (generationKey === undefined) {
      const flushed = await this.flushPending(task);
      const wasRetained = task.runnerRetainedForDetachedWork === true;
      await this.deps.releaseRetainedRunner(task);
      const released = wasRetained && task.runnerRetainedForDetachedWork !== true;
      // R3/R5: 완료 사건인데 followup을 세우지 못해 보유가 풀렸다. native가
      // 이미 이어받았거나(native 소유 중/이번 사건에서 소비) 새 턴이 도는
      // 세션은 알리지 않는다 — 이어받은 세대는 그 턴이 다시 보고한다.
      const nativeContinued = this.nativeOwnershipByGenerationKey.size < ownershipBefore;
      if (
        flushed === 0 &&
        released &&
        isTerminalTaskStatus(task.status) &&
        isTerminalCompletionEvent(event) &&
        !nativeContinued &&
        !this.hasNativeOwnership(task.agentSessionId)
      ) {
        await this.notifyUnrecoverable(task);
      }
      return;
    }
    const pending = this.pendingBySession.get(task.agentSessionId);
    if (!pending?.has(generationKey)) {
      await this.flushPending(task);
      await this.deps.releaseRetainedRunner(task);
      return;
    }
    if (this.nativeOwnershipByGenerationKey.has(generationKey)) {
      // R1/R2: native 알림 턴이 전달을 쥐고 있다. 시한이 정산하므로 여기서는
      // 보유도 followup도 건드리지 않는다.
      return;
    }
    if (task.status === "running") {
      await this.flushPending(task);
      return;
    }
    const flushed = await this.flushPending(task);
    if (flushed > 0) return;
    if (this.pendingBySession.get(task.agentSessionId)?.size) return;
    await this.deps.releaseRetainedRunner(task);
  }

  async reconcileTranscriptAppend(task: Task): Promise<void> {
    const candidates = [...this.nativeOwnershipByGenerationKey.values()].filter((item) =>
      item.sessionId === task.agentSessionId && item.assistantUuid && (
        item.phase === "awaiting-transcript" ||
        (item.phase === "awaiting-result" && item.inputUuid)
      )
    );
    const consumed = await Promise.all(
      candidates.map(async (candidate) => await this.reconcileNativeTranscript(task, candidate)),
    );
    if (consumed.some(Boolean)) await this.deps.releaseRetainedRunner(task);
  }

  retireConsumedProof(task: Task, proof: ClaudeBackgroundConsumptionProof): void {
    const candidates = [...this.nativeOwnershipByGenerationKey.values()].filter((item) =>
      item.sessionId === task.agentSessionId && item.taskId === proof.taskId &&
      (proof.kind !== "exact_generation" ||
        item.initiatingToolUseId === proof.initiatingToolUseId)
    );
    if (candidates.length === 1) this.retireNativeOwnership(task, candidates[0]!);
  }

  private async flushPending(task: Task): Promise<number> {
    const pending = this.pendingBySession.get(task.agentSessionId);
    if (!pending || pending.size === 0) return 0;

    const items = Array.from(pending.values())
      .filter((item) => !this.nativeOwnershipByGenerationKey.has(item.generationKey))
      .sort((a, b) => a.firstSeen - b.firstSeen);
    if (items.length === 0) return 0;
    const durableItems = items.filter((item) =>
      this.durableDeliveryByGenerationKey.has(item.generationKey)
    );
    for (const item of durableItems) {
      await this.flushItems(task, pending, [item]);
    }
    const remaining = items.filter((item) => !durableItems.includes(item));
    for (const item of remaining) {
      await this.flushItems(task, pending, [item]);
    }
    if (pending.size === 0) {
      this.pendingBySession.delete(task.agentSessionId);
    }
    return items.length;
  }

  /**
   * R1: native 알림 턴이 소울스트림 턴으로 이어지기를 기다리는 시한. 넘기면
   * native 소유를 놓고 followup을 직접 보낸다.
   */
  private scheduleOwnershipDeadline(task: Task, generationKey: string): void {
    const deadlineMs = this.deps.followupDeadlineMs ??
      DEFAULT_CLAUDE_BACKGROUND_FOLLOWUP_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
    if (this.ownershipDeadlineTimers.has(generationKey)) return;
    const timer = setTimeout(() => {
      this.ownershipDeadlineTimers.delete(generationKey);
      void this.onOwnershipDeadline(task, generationKey);
    }, deadlineMs);
    (timer as { unref?: () => void }).unref?.();
    this.ownershipDeadlineTimers.set(generationKey, timer);
  }

  private clearOwnershipDeadline(generationKey: string): void {
    const timer = this.ownershipDeadlineTimers.get(generationKey);
    if (!timer) return;
    this.ownershipDeadlineTimers.delete(generationKey);
    clearTimeout(timer);
  }

  private async onOwnershipDeadline(task: Task, generationKey: string): Promise<void> {
    if (!this.nativeOwnershipByGenerationKey.has(generationKey)) return;
    this.nativeOwnershipByGenerationKey.delete(generationKey);
    try {
      await this.flushPending(task);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, generationKey },
        "Claude background follow-up deadline flush failed",
      );
    }
  }

  private async flushItems(
    task: Task,
    pending: Map<string, PendingRuntimeTaskFollowup>,
    items: PendingRuntimeTaskFollowup[],
  ): Promise<void> {
    const durable =
      items.length === 1
        ? this.durableDeliveryByGenerationKey.get(items[0]!.generationKey)
        : undefined;
    const storedMessage = durable
      ? readCanonicalDeliveryPayload(durable.storedPayload)
      : undefined;
    const delivery = durable
      ? {
          deliveryId: durable.deliveryId,
          completionId: durable.completionId,
          relationKey: durable.relationKey,
          deliveryIntent: "runtime_followup" as const,
          producerTerminalRevision: durable.producerTerminalRevision,
          deliveryCreatedAt: durable.deliveryCreatedAt,
          storedDeliveryPayload: durable.storedPayload,
          storedDeliveryPayloadHash: durable.storedPayloadHash,
        }
      : this.deps.deliveryV2Enabled === true
        ? buildClaudeRuntimeFollowupDelivery(items)
        : {};
    const intervention = {
      agentSessionId: task.agentSessionId,
      text: storedMessage?.text ?? buildClaudeRuntimeTaskFollowupPrompt(items),
      user: storedMessage?.user ?? "system",
      callerInfo: storedMessage?.callerInfo ??
        { source: "system" as const, display_name: "Soulstream" },
      attachmentPaths: storedMessage?.attachmentPaths,
      attachmentIds: storedMessage?.attachmentIds,
      attachmentBindings: storedMessage?.attachmentBindings,
      context: storedMessage?.context,
      source: durable?.source ?? CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: 1,
      followupKey: buildFollowupKey(task.agentSessionId, items),
      followupTaskIds:
        storedMessage?.followupTaskIds ?? items.map((item) => item.taskId),
      ...delivery,
    };
    // Claim ownership before crossing into addIntervention: that call can resume the
    // target synchronously and re-enter collectDetached for the same completion.
    const ownedItems = items.map((item) => {
      const generationKey = item.generationKey;
      const durableDelivery = this.durableDeliveryByGenerationKey.get(generationKey);
      pending.delete(generationKey);
      this.flushedGenerationKeys.add(generationKey);
      this.durableDeliveryByGenerationKey.delete(generationKey);
      return { item, generationKey, durableDelivery };
    });
    try {
      await this.deps.taskManager.addIntervention(
        intervention,
        this.deps.onResume,
      );
    } catch (err) {
      for (const { item, generationKey, durableDelivery } of ownedItems) {
        this.flushedGenerationKeys.delete(generationKey);
        pending.set(generationKey, item);
        if (durableDelivery) {
          this.durableDeliveryByGenerationKey.set(generationKey, durableDelivery);
        }
      }
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, taskIds: items.map((item) => item.taskId) },
        "Claude runtime task follow-up intervention failed",
      );
      throw err;
    }
  }

  /** native 알림 턴이 아직 전달을 쥐고 있는 세션인가. */
  private hasNativeOwnership(sessionId: string): boolean {
    for (const item of this.nativeOwnershipByGenerationKey.values()) {
      if (item.sessionId === sessionId) return true;
    }
    return false;
  }

  private async notifyUnrecoverable(task: Task): Promise<void> {
    const notify = this.deps.notifyBackgroundStopped;
    if (!notify) return;
    try {
      await notify(task, CLAUDE_BACKGROUND_UNRECOVERABLE_SENTENCE);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "Claude background stopped notice failed",
      );
    }
  }

  private getPendingMap(sessionId: string): Map<string, PendingRuntimeTaskFollowup> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, PendingRuntimeTaskFollowup>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }

  private async observeNativeEvent(task: Task, event: SSEEventPayload): Promise<void> {
    const payload = event as Record<string, unknown>;
    if (payload.type === "claude_runtime_remote_trigger") {
      if (asString(payload.origin_kind) !== "task-notification") return;
      const prompt = asString(payload.prompt);
      const inputUuid = asString(payload.trigger_id);
      const parsed = prompt ? parseClaudeNativeTaskNotification(prompt) : undefined;
      if (!inputUuid || !parsed) return;
      const candidates = [...this.nativeOwnershipByGenerationKey.values()].filter((item) =>
        item.sessionId === task.agentSessionId && item.phase === "awaiting-input" &&
        item.taskId === parsed.taskId && item.initiatingToolUseId === parsed.toolUseId
      );
      if (candidates.length !== 1) return;
      candidates[0]!.phase = "awaiting-assistant";
      candidates[0]!.inputUuid = inputUuid;
      return;
    }
    if (payload.type === "assistant_message") {
      const assistantUuid = assistantUuidFromDedupeKey(asString(payload._dedupe_key));
      if (!assistantUuid) return;
      const sessionCandidates = [...this.nativeOwnershipByGenerationKey.values()].filter((item) =>
        item.sessionId === task.agentSessionId
      );
      const readyCandidates = sessionCandidates.filter((item) =>
        item.phase === "awaiting-assistant" ||
        (item.phase === "awaiting-result" && item.assistantUuid === assistantUuid)
      );
      if (readyCandidates.length > 1) return;
      let candidate = readyCandidates[0];
      if (!candidate) {
        const awaitingInputCandidates = sessionCandidates.filter((item) =>
          item.phase === "awaiting-input"
        );
        if (awaitingInputCandidates.length !== 1) return;
        candidate = awaitingInputCandidates[0]!;
      }
      if (candidate.phase === "awaiting-input") {
        if (!this.deps.transcriptReceipt) return;
        candidate.assistantUuid = assistantUuid;
        candidate.phase = "awaiting-transcript";
        candidate.proofEpoch += 1;
        await this.reconcileNativeTranscript(task, candidate);
        return;
      }
      if (candidate.phase === "awaiting-assistant") candidate.proofEpoch += 1;
      candidate.phase = "awaiting-result";
      candidate.assistantUuid = assistantUuid;
      if (!candidate.inputUuid || !this.deps.transcriptReceipt) return;
      await this.reconcileNativeTranscript(task, candidate);
      return;
    }
    if (payload.type !== "result") return;
    const receipt = readClaudeResultReceiptMetadata(event);
    if (!receipt) {
      for (const item of this.nativeOwnershipByGenerationKey.values()) {
        if (item.sessionId !== task.agentSessionId || item.phase !== "awaiting-result") {
          continue;
        }
        item.proofEpoch += 1;
        item.phase = "awaiting-assistant";
        item.assistantUuid = undefined;
      }
      return;
    }
    const sessionCandidates = [...this.nativeOwnershipByGenerationKey.values()].filter((item) =>
      item.sessionId === task.agentSessionId && item.phase === "awaiting-result"
    );
    for (const item of sessionCandidates) {
      if (item.inputUuid === receipt.inputUuid) continue;
      item.proofEpoch += 1;
      item.phase = "awaiting-assistant";
      item.assistantUuid = undefined;
    }
    const candidates = sessionCandidates.filter((item) =>
      item.inputUuid === receipt.inputUuid && item.assistantUuid
    );
    if (candidates.length !== 1) {
      const assistantless = [...this.nativeOwnershipByGenerationKey.values()].filter((item) =>
        item.sessionId === task.agentSessionId &&
        item.inputUuid === receipt.inputUuid && item.phase === "awaiting-assistant"
      );
      for (const item of assistantless) item.phase = "native-visible-unsettled";
      return;
    }
    const candidate = candidates[0]!;
    const snapshot = this.nativeProofSnapshot(candidate);
    await this.runInNativeProofTail(candidate, async () => {
      if (!this.isCurrentNativeProof(candidate, snapshot)) return false;
      await this.consumeNativeAssistant(task, candidate, snapshot.assistantUuid!);
      return !this.nativeOwnershipByGenerationKey.has(candidate.generationKey);
    });
  }

  private async consumeNativeAssistant(
    task: Task,
    candidate: NativeDeliveryOwnership,
    assistantUuid: string,
  ): Promise<void> {
    const recorder = this.deps.taskManager.getDeliveryConsumptionRecorder?.();
    let consumed = false;
    try {
      consumed = await recorder?.recordRuntimeFollowupRelationConsumed(
        task,
        {
          kind: "exact_generation",
          taskId: candidate.taskId,
          initiatingToolUseId: candidate.initiatingToolUseId,
        },
        assistantUuid,
      ) ?? false;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, taskId: candidate.taskId },
        "Claude native task-notification consumption failed",
      );
    }
    if (!consumed) {
      candidate.phase = "native-visible-unsettled";
      return;
    }
    this.retireNativeOwnership(task, candidate);
  }

  private retireNativeOwnership(task: Task, candidate: NativeDeliveryOwnership): void {
    this.nativeOwnershipByGenerationKey.delete(candidate.generationKey);
    this.clearOwnershipDeadline(candidate.generationKey);
    const pending = this.pendingBySession.get(task.agentSessionId);
    pending?.delete(candidate.generationKey);
    if (pending?.size === 0) this.pendingBySession.delete(task.agentSessionId);
    this.durableDeliveryByGenerationKey.delete(candidate.generationKey);
    this.flushedGenerationKeys.add(candidate.generationKey);
  }

  private async reconcileNativeTranscript(
    task: Task,
    candidate: NativeDeliveryOwnership,
  ): Promise<boolean> {
    return await this.runInNativeProofTail(candidate, async () => {
      if (!this.deps.transcriptReceipt) return false;
      const snapshot = this.nativeProofSnapshot(candidate);
      if (!snapshot.assistantUuid || (
        snapshot.phase !== "awaiting-transcript" &&
        (snapshot.phase !== "awaiting-result" || !snapshot.inputUuid)
      )) return false;
      if (!this.isCurrentNativeProof(candidate, snapshot)) return false;
      try {
        const proof = snapshot.phase === "awaiting-transcript"
          ? await this.deps.transcriptReceipt.inspectNativeTaskNotification(
              task.agentSessionId,
              {
                taskId: candidate.taskId,
                initiatingToolUseId: candidate.initiatingToolUseId,
                expectedAssistantUuid: snapshot.assistantUuid,
              },
            )
          : await this.deps.transcriptReceipt.inspectInput(
              task.agentSessionId,
              snapshot.inputUuid!,
              snapshot.assistantUuid,
            );
        if (
          !proof || proof.kind !== "completed" ||
          proof.inputUuid !== (snapshot.inputUuid ?? proof.inputUuid) ||
          proof.assistantMessageUuid !== snapshot.assistantUuid ||
          !this.isCurrentNativeProof(candidate, snapshot)
        ) return false;
        candidate.inputUuid = proof.inputUuid;
        candidate.phase = "awaiting-result";
        await this.consumeNativeAssistant(task, candidate, snapshot.assistantUuid);
        return !this.nativeOwnershipByGenerationKey.has(candidate.generationKey);
      } catch (err) {
        this.logTranscriptReceiptFailure(err, task, candidate);
        return false;
      }
    });
  }

  private async runInNativeProofTail(
    candidate: NativeDeliveryOwnership,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    const previous = this.nativeTranscriptTailByGenerationKey.get(candidate.generationKey) ??
      Promise.resolve(false);
    const current = previous.catch(() => false).then(operation);
    this.nativeTranscriptTailByGenerationKey.set(candidate.generationKey, current);
    try {
      return await current;
    } finally {
      if (this.nativeTranscriptTailByGenerationKey.get(candidate.generationKey) === current) {
        this.nativeTranscriptTailByGenerationKey.delete(candidate.generationKey);
      }
    }
  }

  private nativeProofSnapshot(candidate: NativeDeliveryOwnership) {
    return {
      epoch: candidate.proofEpoch,
      phase: candidate.phase,
      inputUuid: candidate.inputUuid,
      assistantUuid: candidate.assistantUuid,
    };
  }

  private isCurrentNativeProof(
    candidate: NativeDeliveryOwnership,
    snapshot: ReturnType<ClaudeRuntimeTaskFollowupController["nativeProofSnapshot"]>,
  ): boolean {
    return this.nativeOwnershipByGenerationKey.get(candidate.generationKey) === candidate &&
      candidate.proofEpoch === snapshot.epoch && candidate.phase === snapshot.phase &&
      candidate.inputUuid === snapshot.inputUuid &&
      candidate.assistantUuid === snapshot.assistantUuid;
  }

  private logTranscriptReceiptFailure(
    err: unknown,
    task: Task,
    candidate: NativeDeliveryOwnership,
  ): void {
    this.deps.logger.warn(
      { err, sessionId: task.agentSessionId, taskId: candidate.taskId },
      "Claude native task-notification transcript receipt failed",
    );
  }

}

/** 완료 통지 꼴(터미널 상태)인 사건인가 — 이을 수 없음(R5) 판정의 전제. */
function isTerminalCompletionEvent(event: SSEEventPayload): boolean {
  const payload = event as Record<string, unknown>;
  const type = asString(payload.type);
  if (
    type !== "claude_runtime_task_notification" &&
    type !== "claude_runtime_task_updated"
  ) return false;
  if (!asString(payload.task_id)) return false;
  const patch = type === "claude_runtime_task_updated"
    ? asRecord(payload.patch) ?? {}
    : {};
  const status = asString(payload.status) ?? asString(patch.status);
  return status !== undefined && TERMINAL_RUNTIME_TASK_STATUSES.has(status);
}

function assistantUuidFromDedupeKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^claude-sdk:assistant:(.+):\d+$/.exec(value);
  return match?.[1];
}
