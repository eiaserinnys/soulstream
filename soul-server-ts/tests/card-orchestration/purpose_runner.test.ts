import { describe, it, expect, vi } from 'vitest';
import { PurposeDecisionRunner } from '../../src/card-orchestration/purpose_runner.js';

const command = { agentSessionId: 'visible', runId: 'run', leaseToken: 'fence', profileId: 'ariella-orchestrator', modelPreset: 'opus', folderId: 'system-folder', prompt: 'trusted instructions + untrusted snapshot', instructionsRevision: 'server-revision', outputSchema: { type: 'object' } };
function harness(allowed = true) {
  const task = { agentSessionId: command.agentSessionId, status: 'initializing', executionRegistration: undefined };
  const createTask = vi.fn(async () => task);
  const finalizeTask = vi.fn(async () => task);
  const enqueueEvent = vi.fn(async () => 1);
  const handleSideEffects = vi.fn(async () => undefined);
  const execute = vi.fn(async () => ({ status: 'ready' as const, output: { order: [] } }));
  const authorize = vi.fn(async () => allowed);
  const runner = new PurposeDecisionRunner({ nodeId: 'node', taskManager: { createTask, finalizeTask },
    persistence: { enqueueEvent, handleSideEffects },
    modelCatalog: { resolve: () => ({ id: 'opus', model: 'actual-opus', backend: 'claude', env: { COMMON_SECRET: 'must-not-inherit' } }) },
    resolveProfile: async () => ({ id: 'ariella-orchestrator' }),
    compileInstructions: async () => ({ text: 'server compiled instructions', revision: 'server-revision' }),
    authorize, executor: { execute, prepare: vi.fn(async () => ({ status: 'ready' as const })) }, transitionRunning: vi.fn(async () => undefined), timeoutMs: 30000 });
  return { runner, task, createTask, finalizeTask, enqueueEvent, execute, authorize };
}

describe('canonical one-shot purpose runner', () => {
  it('denied host fence never creates a session or invokes the model', async () => {
    const h = harness(false);
    await expect(h.runner.create(command)).rejects.toThrow('Decision authorization denied');
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('read-only prepare reports a fresh revision without creating sessions or invoking a model', async () => {
    const h = harness();
    expect(await h.runner.prepare({ profileId: command.profileId, modelPreset: command.modelPreset })).toEqual({ status: 'ready', instructionsRevision: 'server-revision' });
    expect(h.createTask).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });

  it('refuses revision changes between prepare and execution before session registration', async () => {
    const h = harness();
    await expect(h.runner.create({ ...command, instructionsRevision: 'stale-revision' })).rejects.toThrow('instructions_revision_changed');
    expect(h.createTask).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });

  it('registers visible purpose with no generic-engine/env authority and preserves structured terminal evidence', async () => {
    const h = harness();
    const task = await h.runner.create(command);
    await task.executionPromise;
    expect(h.createTask).toHaveBeenCalledWith(expect.objectContaining({ sessionType: 'llm', notifyCompletion: false,
      profileId: command.profileId, folderId: command.folderId, modelPreset: command.modelPreset,
      orchestrationPurpose: { runId: 'run', leaseToken: 'fence', instructionsRevision: 'server-revision' } }));
    expect(h.createTask.mock.calls[0]?.[0]).not.toHaveProperty('modelPresetEnv');
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({ model: 'actual-opus', backend: 'claude', outputSchema: command.outputSchema }));
    expect(h.execute.mock.calls[0]?.[0].prompt).toContain('server compiled instructions');
    expect(h.enqueueEvent).toHaveBeenCalledWith('visible', expect.objectContaining({ type: 'assistant_message', content: '{"order":[]}' }));
    expect(h.finalizeTask).toHaveBeenCalledWith({ agentSessionId: 'visible', result: '{"order":[]}' });
  });

  it('coalesces duplicate commands while a run is live', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.runner.create(command), h.runner.create(command)]);
    expect(a).toBe(b);
    await a.executionPromise;
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.createTask).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
