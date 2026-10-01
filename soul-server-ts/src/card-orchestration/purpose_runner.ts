import type { AgentProfile } from '../agent_registry.js';
import { buildSystemCallerInfo } from '../caller_info.js';
import type { EventPersistence } from '../db/event_persistence.js';
import type { SSEEventPayload } from '../engine/protocol.js';
import type { ModelCatalog } from '../model_catalog.js';
import type { TaskManager } from '../task/task_manager.js';
import type { Task } from '../task/task_models.js';
import type { DecisionExecutor, DecisionExecutionResult } from './decision_executor.js';
import type { CompiledDecisionInstructions } from './decision_instructions.js';

export interface PurposeDecisionCommand {
  agentSessionId: string; runId: string; leaseToken: string;
  profileId: string; modelPreset: string; folderId: string;
  prompt: string; instructionsRevision: string; outputSchema: Record<string, unknown>;
}
export interface PurposeDecisionRunnerDeps {
  nodeId: string; taskManager: Pick<TaskManager, 'createTask' | 'finalizeTask'>;
  persistence: Pick<EventPersistence, 'enqueueEvent' | 'handleSideEffects'>;
  modelCatalog: Pick<ModelCatalog, 'resolve'>;
  resolveProfile: (id: string) => Promise<Pick<AgentProfile, 'id' | 'atom_contexts'> | undefined>;
  compileInstructions: (profile: Pick<AgentProfile, 'id' | 'atom_contexts'>) => Promise<CompiledDecisionInstructions>;
  executor: Pick<DecisionExecutor, 'execute' | 'prepare'>;
  authorize: (command: PurposeDecisionCommand) => Promise<boolean>;
  transitionRunning: (sessionId: string, runId: string) => Promise<void>;
  timeoutMs: number;
  onPersistenceError?: (sessionId: string) => void;
}

/** Registers a visible canonical session, but never enters TaskExecutor or a general task engine. */
export class PurposeDecisionRunner {
  private readonly pending = new Map<string, { identity: string; task: Promise<Task>; abort: AbortController }>();
  constructor(private readonly deps: PurposeDecisionRunnerDeps) {}

  async prepare(input: Pick<PurposeDecisionCommand, 'profileId' | 'modelPreset'>): Promise<
    { status: 'ready'; instructionsRevision: string } | { status: 'unavailable'; reason: string }> {
    try {
      const { instructions } = await this.prepareInputs(input);
      return { status: 'ready', instructionsRevision: instructions.revision };
    } catch (error) { return { status: 'unavailable', reason: error instanceof Error ? error.message : 'decision_prepare_unavailable' }; }
  }

  create(command: PurposeDecisionCommand): Promise<Task> {
    const identity = JSON.stringify([command.runId, command.leaseToken, command.profileId,
      command.modelPreset, command.folderId, command.instructionsRevision]);
    const existing = this.pending.get(command.agentSessionId);
    if (existing) {
      if (existing.identity !== identity) return Promise.reject(new Error('Conflicting decision identity'));
      return existing.task;
    }
    const abort = new AbortController();
    const task = this.createOnce(command, abort);
    this.pending.set(command.agentSessionId, { identity, task, abort });
    void task.catch(() => this.pending.delete(command.agentSessionId));
    return task;
  }

  cancel(sessionId: string): boolean {
    const run = this.pending.get(sessionId);
    if (!run) return false;
    run.abort.abort(); return true;
  }

  private async createOnce(command: PurposeDecisionCommand, abort: AbortController): Promise<Task> {
    if (!await this.deps.authorize(command)) throw new Error('Decision authorization denied');
    const { profile, preset, instructions } = await this.prepareInputs(command);
    if (!command.instructionsRevision || command.instructionsRevision !== instructions.revision) throw new Error('instructions_revision_changed');
    const prompt = `<trusted_orchestration_instructions>\n${instructions.text}\n</trusted_orchestration_instructions>\n`
      + `<queued_card_snapshot_untrusted>\n${command.prompt}\n</queued_card_snapshot_untrusted>`;
    const task = await this.deps.taskManager.createTask({
      agentSessionId: command.agentSessionId, profileId: profile.id,
      prompt, sessionType: 'llm', llmProvider: preset.backend, llmModel: preset.model,
      model: preset.model, modelPreset: preset.id, modelPresetBackend: preset.backend,
      folderId: command.folderId, notifyCompletion: false,
      callerInfo: buildSystemCallerInfo(this.deps.nodeId),
      allowedTools: [], disallowedTools: [], useMcp: false, claudePermissionMode: 'dontAsk',
      orchestrationPurpose: { runId: command.runId, leaseToken: command.leaseToken,
        instructionsRevision: instructions.revision },
    });
    await task.creationEffects;
    await this.deps.transitionRunning(task.agentSessionId, command.runId);
    task.status = 'running';
    task.executionPromise = this.execute(task, { ...command, prompt }, preset.backend, preset.model, abort)
      .catch(() => { this.deps.onPersistenceError?.(task.agentSessionId); })
      .finally(() => { task.executionPromise = undefined; this.pending.delete(task.agentSessionId); });
    return task;
  }

  private async prepareInputs(input: Pick<PurposeDecisionCommand, 'profileId' | 'modelPreset'>) {
    const profile = await this.deps.resolveProfile(input.profileId);
    if (!profile) throw new Error('decision_profile_unavailable');
    const preset = this.deps.modelCatalog.resolve(input.modelPreset);
    if (preset.backend !== 'claude' && preset.backend !== 'codex') throw new Error('decision_backend_unsupported');
    const backend = preset.backend;
    const readiness = await this.deps.executor.prepare(backend);
    if (readiness.status !== 'ready') throw new Error(readiness.reason);
    const instructions = await this.deps.compileInstructions(profile);
    return { profile, preset: { ...preset, backend }, instructions };
  }

  private async execute(task: Task, command: PurposeDecisionCommand, backend: 'claude' | 'codex',
    model: string, abort: AbortController): Promise<void> {
    const timeout = setTimeout(() => abort.abort(), this.deps.timeoutMs);
    try {
      await this.event(task, { type: 'user_message', timestamp: Date.now() / 1000,
        user: 'card_orchestration', text: command.prompt, purpose: 'card_orchestration', run_id: command.runId });
      let result: DecisionExecutionResult;
      try {
        result = await this.deps.executor.execute({ sessionId: task.agentSessionId, runId: command.runId,
          backend, model, prompt: command.prompt, outputSchema: command.outputSchema, signal: abort.signal });
      } catch { result = { status: 'unavailable', reason: 'executor_unavailable' }; }
      if (task.status !== 'running') return;
      if (abort.signal.aborted) result = { status: 'unavailable', reason: 'decision_aborted' };
      if (result.status === 'ready') {
        const content = JSON.stringify(result.output);
        if (content === undefined) throw new Error('Invalid decision output');
        await this.event(task, { type: 'assistant_message', timestamp: Date.now() / 1000,
          content, purpose: 'card_orchestration', run_id: command.runId, structured_output: result.output });
        await this.deps.taskManager.finalizeTask({ agentSessionId: task.agentSessionId, result: content });
      } else {
        await this.event(task, { type: 'error', timestamp: Date.now() / 1000,
          message: result.reason, purpose: 'card_orchestration', run_id: command.runId });
        await this.deps.taskManager.finalizeTask({ agentSessionId: task.agentSessionId, error: result.reason });
      }
    } finally { clearTimeout(timeout); }
  }

  private async event(task: Task, payload: Record<string, unknown>): Promise<void> {
    if (task.executionRegistration) {
      await this.deps.persistence.enqueueEvent(task.agentSessionId, payload as SSEEventPayload,
        undefined, task.executionRegistration.registrationId);
    } else await this.deps.persistence.enqueueEvent(task.agentSessionId, payload as SSEEventPayload);
    await this.deps.persistence.handleSideEffects(task.agentSessionId, payload as SSEEventPayload, task);
  }
}
