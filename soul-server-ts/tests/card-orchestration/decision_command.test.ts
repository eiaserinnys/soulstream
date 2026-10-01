import pino from 'pino';
import { describe, it, expect, vi } from 'vitest';
import { createSessionCommandFamily } from '../../src/upstream/session_command_family.js';
import { TaskRuntimeCommands } from '../../src/upstream/task_runtime_commands.js';

describe('dedicated decision command authority', () => {
  it('read-only prepare returns capability/revision and never uses general session creation', async () => {
    const prepareDecisionSession = vi.fn(async () => ({ status: 'ready', instructionsRevision: 'sha256:revision' }));
    const createSession = vi.fn(); const send = vi.fn();
    const family = createSessionCommandFamily({ send, logger: pino({ level: 'silent' }), taskManager: {} as never,
      taskRuntimeCommands: { prepareDecisionSession, createSession } as unknown as TaskRuntimeCommands, sessionListCommands: {} as never });
    await family.prepare_card_orchestration_decision!({ type: 'prepare_card_orchestration_decision', requestId: 'req', profile: 'ariella-orchestrator', model_preset: 'opus' });
    expect(prepareDecisionSession).toHaveBeenCalledWith({ profileId: 'ariella-orchestrator', modelPreset: 'opus' });
    expect(send).toHaveBeenCalledWith({ type: 'card_orchestration_decision_prepared', requestId: 'req', status: 'ready', instructionsRevision: 'sha256:revision' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('routes only the canonical decision payload and strips generic tool/env/credential overrides', async () => {
    const createDecisionSession = vi.fn(async () => ({ agentSessionId: 'visible' }));
    const createSession = vi.fn();
    const send = vi.fn();
    const family = createSessionCommandFamily({ send, logger: pino({ level: 'silent' }), taskManager: {} as never,
      taskRuntimeCommands: { createDecisionSession, createSession } as unknown as TaskRuntimeCommands, sessionListCommands: {} as never });
    await family.create_card_orchestration_decision!({ type: 'create_card_orchestration_decision', requestId: 'req',
      agentSessionId: 'visible', runId: 'run', leaseToken: 'fence', profile: 'ariella-orchestrator', model_preset: 'opus', folderId: 'system-folder',
      prompt: 'snapshot', instructionsRevision: 'revision', outputSchema: { type: 'object' },
      allowedTools: ['Bash'], useMcp: true, oauth_token: 'spoofed', systemPrompt: 'spoofed', attachment_paths: ['/host/secret'] });
    expect(createDecisionSession).toHaveBeenCalledWith({ agentSessionId: 'visible', runId: 'run', leaseToken: 'fence', profileId: 'ariella-orchestrator',
      modelPreset: 'opus', folderId: 'system-folder', prompt: 'snapshot', instructionsRevision: 'revision', outputSchema: { type: 'object' } });
    expect(createSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: 'session_created', requestId: 'req', agentSessionId: 'visible' });
  });

  it('has no general session fallback when the dedicated executor is unavailable', () => {
    const createTask = vi.fn(); const startNewExecution = vi.fn();
    const runtime = new TaskRuntimeCommands({ agentRegistry: {} as never, taskManager: { createTask } as never,
      taskExecutor: { startNewExecution }, logger: pino({ level: 'silent' }) });
    expect(() => runtime.createDecisionSession({} as never)).toThrow('Dedicated decision runtime unavailable');
    expect(createTask).not.toHaveBeenCalled(); expect(startNewExecution).not.toHaveBeenCalled();
  });
});
