import type { Session } from '../../api/types';
import {
  isSessionOnDisconnectedNode,
  projectVisibleSessions,
  type SessionNodeConnectivity,
} from '../session-node-projection';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: overrides.agentSessionId ?? 'session',
    displayName: 'session',
    status: 'running',
    nodeId: 'node-a',
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

const connected: SessionNodeConnectivity = {
  ready: true,
  connectedNodeIds: new Set(['node-a']),
};

describe('session node projection', () => {
  test.each([
    ['not-ready', { ready: false, connectedNodeIds: new Set<string>() }, makeSession(), false],
    ['connected running', connected, makeSession(), false],
    ['disconnected running', { ready: true, connectedNodeIds: new Set<string>() }, makeSession(), true],
    ['missing nodeId', { ready: true, connectedNodeIds: new Set<string>() }, makeSession({ nodeId: undefined }), false],
    ['blank nodeId', { ready: true, connectedNodeIds: new Set<string>() }, makeSession({ nodeId: '   ' }), false],
    ['non-running', { ready: true, connectedNodeIds: new Set<string>() }, makeSession({ status: 'completed' }), false],
  ] as const)('%s', (_name, connectivity, session, expected) => {
    expect(isSessionOnDisconnectedNode(session, connectivity)).toBe(expected);
  });

  test('projection은 source 배열과 session 객체를 변경하지 않는다', () => {
    const online = makeSession({ agentSessionId: 'online', nodeId: 'node-a' });
    const offline = makeSession({ agentSessionId: 'offline', nodeId: 'node-b' });
    const source = Object.freeze([online, offline]);

    const visible = projectVisibleSessions(source, connected);

    expect(visible).toEqual([online]);
    expect(source).toEqual([online, offline]);
    expect(visible[0]).toBe(online);
  });
});
