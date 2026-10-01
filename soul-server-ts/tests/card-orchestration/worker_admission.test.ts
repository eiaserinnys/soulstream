import pino from 'pino';
import { describe, it, expect, vi } from 'vitest';
import { createSessionCommandFamily } from '../../src/upstream/session_command_family.js';
import { createInterventionCommandFamily } from '../../src/upstream/intervention_command_family.js';
import { TaskRuntimeCommands } from '../../src/upstream/task_runtime_commands.js';

function harness(allowed = false) {
  const createTask = vi.fn(async () => ({ agentSessionId: 'session' }));
  const addIntervention = vi.fn(async () => ({ delivered: true }));
  const startNewExecution = vi.fn();
  const authorizeOrchestrationWorker = vi.fn(async () => allowed);
  const commands = new TaskRuntimeCommands({
    agentRegistry: { get: () => ({ id: 'worker', name: 'Worker', backend: 'codex', workspace_dir: '/worker' }) } as never,
    taskManager: { createTask, addIntervention } as never, taskExecutor: { startNewExecution },
    logger: pino({ level: 'silent' }), authorizeOrchestrationWorker,
  });
  return { commands, createTask, addIntervention, startNewExecution, authorizeOrchestrationWorker };
}
const orchestrationAdmission = { cardId: 'card', runId: 'run', executionToken: 'immutable-token' };
describe('orchestrated worker delivery fencing', () => {
  it('requires the host admission before generic worker task creation', async () => {
    const h = harness();
    await expect(h.commands.createSession({ agentSessionId: 'session', profileId: 'worker', prompt: 'work', cardId: 'card', orchestrationAdmission })).rejects.toThrow('Worker admission denied');
    expect(h.createTask).not.toHaveBeenCalled(); expect(h.startNewExecution).not.toHaveBeenCalled();
    expect(h.authorizeOrchestrationWorker).toHaveBeenCalledWith({ sessionId: 'session', ...orchestrationAdmission });
  });
  it('requires the same host admission before limit-resume intervention delivery', async () => {
    const h = harness();
    await expect(h.commands.intervene({ agentSessionId: 'session', text: 'resume', orchestrationAdmission })).rejects.toThrow('Worker admission denied');
    expect(h.addIntervention).not.toHaveBeenCalled();
  });
  it('rejects a mismatched create card before consuming the host token', async () => {
    const h = harness(true);
    await expect(h.commands.createSession({ agentSessionId: 'session', profileId: 'worker', prompt: 'work', orchestrationAdmission })).rejects.toThrow('Worker admission denied');
    expect(h.authorizeOrchestrationWorker).not.toHaveBeenCalled(); expect(h.createTask).not.toHaveBeenCalled();
  });
  it('forwards the marker through both upstream command families', async () => {
    const createSession = vi.fn(async () => ({ agentSessionId: 'session' })); const intervene = vi.fn(async () => ({ delivered: true }));
    const runtime = { createSession, intervene } as unknown as TaskRuntimeCommands;
    const session = createSessionCommandFamily({ send: vi.fn(), logger: pino({ level: 'silent' }), taskManager: {} as never, taskRuntimeCommands: runtime, sessionListCommands: {} as never });
    const intervention = createInterventionCommandFamily({ send: vi.fn(), taskRuntimeCommands: runtime, deliveryCommands: {} as never });
    await session.create_session!({ type: 'create_session', agentSessionId: 'session', profile: 'worker', prompt: 'work', cardId: 'card', orchestrationAdmission });
    await intervention.intervene!({ type: 'intervene', agentSessionId: 'session', text: 'resume', orchestrationAdmission });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ orchestrationAdmission }));
    expect(intervene).toHaveBeenCalledWith(expect.objectContaining({ orchestrationAdmission }));
  });
  it('preserves existing unfenced paths and authorized worker behavior', async () => {
    const h = harness(true);
    await h.commands.createSession({ agentSessionId: 'session', profileId: 'worker', prompt: 'work', cardId: 'card', orchestrationAdmission });
    await h.commands.intervene({ agentSessionId: 'session', text: 'resume', orchestrationAdmission });
    expect(h.authorizeOrchestrationWorker).toHaveBeenCalledTimes(2);
    expect(h.createTask).toHaveBeenCalledTimes(1); expect(h.addIntervention).toHaveBeenCalledTimes(1);
    await h.commands.createSession({ agentSessionId: 'legacy', profileId: 'worker', prompt: 'old' });
    await h.commands.intervene({ agentSessionId: 'legacy', text: 'old' });
    expect(h.authorizeOrchestrationWorker).toHaveBeenCalledTimes(2);
  });
});
