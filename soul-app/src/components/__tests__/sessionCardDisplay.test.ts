import {
  resolveSessionCardAvatar,
  resolveSessionCardCaller,
  resolveSessionModelLabel,
} from '../sessionCardDisplay';
import type { Session } from '../../api/types';

function session(overrides: Partial<Session>): Session {
  return {
    agentSessionId: 'sess-1',
    displayName: null,
    status: 'idle',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveSessionCardAvatar', () => {
  it('keeps absolute agent portrait URLs and uses the agent-name fallback char', () => {
    expect(
      resolveSessionCardAvatar(
        session({
          agentName: '로젤린',
          agentPortraitUrl: 'https://cdn.example.com/agents/roselin.png',
        }),
        'https://soul.example.com',
      ),
    ).toEqual({
      uri: 'https://cdn.example.com/agents/roselin.png',
      fallbackChar: '로',
    });
  });

  it('prepends serverUrl to relative agent portrait URLs', () => {
    expect(
      resolveSessionCardAvatar(
        session({
          agentName: 'Roselin',
          agentPortraitUrl: '/api/nodes/eias/agents/roselin/portrait',
        }),
        'https://soul.example.com/',
      ),
    ).toEqual({
      uri: 'https://soul.example.com/api/nodes/eias/agents/roselin/portrait',
      fallbackChar: 'R',
    });
  });

  it('falls back to agent id then shortened session id when no portrait is resolvable', () => {
    expect(
      resolveSessionCardAvatar(
        session({ agentName: null, agentId: 'roselin_codex', agentPortraitUrl: null }),
        'https://soul.example.com',
      ),
    ).toEqual({ uri: null, fallbackChar: 'r' });

    expect(
      resolveSessionCardAvatar(
        session({ agentName: null, agentPortraitUrl: '/relative/portrait' }),
        null,
      ),
    ).toEqual({ uri: null, fallbackChar: '1' });
  });
});

describe('resolveSessionModelLabel', () => {
  it('uses and trims the server model-catalog label before any backend fallback', () => {
    expect(resolveSessionModelLabel(session({
      modelLabel: '  Codex - 5.6 Sol  ',
      backend: 'claude',
    }))).toBe('Codex - 5.6 Sol');
  });

  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['openai-agents', 'OpenAI Agents'],
  ])('formats the supported backend %s as %s while the server field is absent', (
    backend,
    expected,
  ) => {
    expect(resolveSessionModelLabel(session({ backend }))).toBe(expected);
  });

  it('returns null when neither source can supply a label', () => {
    expect(resolveSessionModelLabel(session({ backend: null, modelLabel: null }))).toBeNull();
  });
});

describe('resolveSessionCardCaller', () => {
  it('does not expose caller identity without callerSessionId even when caller fields exist', () => {
    expect(
      resolveSessionCardCaller(
        session({
          callerSessionId: null,
          userName: '서소영',
          userPortraitUrl: '/api/nodes/eias/agents/seosoyoung/portrait',
        }),
        'https://soul.example.com',
      ),
    ).toEqual({
      showIdentity: false,
      requestLabel: null,
      accessibilityLabel: null,
    });
  });

  it('integrates a named caller into the request identity copy', () => {
    expect(
      resolveSessionCardCaller(
        session({
          callerSessionId: 'sess-caller',
          userName: '서소영',
          userPortraitUrl: '/api/nodes/eias/agents/seosoyoung/portrait',
        }),
        'https://soul.example.com/',
      ),
    ).toEqual({
      showIdentity: true,
      requestLabel: '요청 서소영',
      accessibilityLabel: '요청 서소영',
    });
  });

  it('preserves portrait-only caller semantics without adding a visual row', () => {
    expect(
      resolveSessionCardCaller(
        session({
          callerSessionId: 'sess-caller',
          userName: null,
          userPortraitUrl: 'https://avatars.example.com/u.png',
        }),
        'https://soul.example.com',
      ),
    ).toEqual({
      showIdentity: true,
      requestLabel: '피위임 요청',
      accessibilityLabel: '피위임 요청',
    });
  });

  it('does not depend on portrait URL resolution for caller semantics', () => {
    expect(
      resolveSessionCardCaller(
        session({
          callerSessionId: 'sess-caller',
          userName: null,
          userPortraitUrl: '/api/nodes/eias/agents/anon/portrait',
        }),
        null,
      ),
    ).toEqual({
      showIdentity: true,
      requestLabel: '피위임 요청',
      accessibilityLabel: '피위임 요청',
    });
  });
});
