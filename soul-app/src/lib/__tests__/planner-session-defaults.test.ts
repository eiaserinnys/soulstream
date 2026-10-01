import { savePlannerSessionDefaults } from '../planner-session-defaults';

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'uuid'),
}));

test('업무 기본 담당 저장은 서버 preset을 session_defaults properties에 보존한다', async () => {
  const applyPageOperations = jest.fn().mockResolvedValue({ ok: true });
  const api = {
    getPage: jest.fn().mockResolvedValue({
      page: { version: 7 },
      stateVector: 'AQID',
      blocks: [],
    }),
    applyPageOperations,
  };

  await savePlannerSessionDefaults(api as never, 'task-page', {
    blockId: null,
    agentId: 'agent-a',
    nodeId: 'node-a',
    modelPreset: 'server-preset',
  });

  expect(applyPageOperations).toHaveBeenCalledWith(
    'task-page',
    expect.objectContaining({
      expectedVersion: 7,
      expectedStateVector: 'AQID',
      operations: [expect.objectContaining({
        op: 'create_block',
        block_type: 'session_defaults',
        properties: {
          agentId: 'agent-a',
          nodeId: 'node-a',
          modelPreset: 'server-preset',
          scope: 'session',
        },
      })],
    }),
  );
});
