import {
  extractMessageCaller,
  pickFallbackChar,
  pickUserAvatarUri,
  type MessageCaller,
} from '../userAvatarHelpers';
import type { GoogleProfile } from '../../../auth/jwt-payload';
import type { Session, SessionEvent } from '../../../api/types';

const SERVER = 'https://soul.example.com';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'sess-test',
    node_id: 'node-1',
    agent_id: 'agent-1',
    created_at: '2026-01-01T00:00:00Z',
    display_name: 'test session',
    userName: 'Jubok Kim',
    userPortraitUrl: '/api/users/me/portrait',
    ...overrides,
  } as Session;
}

const PROFILE: GoogleProfile = {
  email: 'eiaserinnys@gmail.com',
  name: 'Jubok Kim',
  picture: 'https://lh3.googleusercontent.com/a/ABC123',
};

function makeEvent(data: Record<string, unknown>): SessionEvent {
  return { id: 'e-1', type: 'user_message', data } as SessionEvent;
}

// ---------------------------------------------------------------------------
// extractMessageCaller — 신규
// ---------------------------------------------------------------------------

describe('extractMessageCaller', () => {
  it('returns null when event is undefined', () => {
    expect(extractMessageCaller(undefined)).toBeNull();
  });

  it('returns null for empty event.data', () => {
    expect(extractMessageCaller(makeEvent({}))).toBeNull();
  });

  it('returns null when event.data has no caller-related fields', () => {
    expect(extractMessageCaller(makeEvent({ user: 'x', text: 'hi' }))).toBeNull();
  });

  it('extracts nested caller_info source/agent_node/agent_id/agent_name/avatar_url', () => {
    const ev = makeEvent({
      text: 'hi',
      caller_info: {
        source: 'agent',
        agent_node: 'eias-shopping',
        agent_id: 'roselin',
        agent_name: '로젤린',
        avatar_url: '/api/nodes/eias-shopping/agents/roselin/portrait',
        display_name: '로젤린',
      },
    });
    expect(extractMessageCaller(ev)).toEqual({
      source: 'agent',
      agent_node: 'eias-shopping',
      agent_id: 'roselin',
      agent_name: '로젤린',
      avatar_url: '/api/nodes/eias-shopping/agents/roselin/portrait',
      display_name: '로젤린',
    });
  });

  it('extracts flat top-level fields when caller_info absent', () => {
    const ev = makeEvent({
      text: 'hi',
      source: 'agent',
      agent_node: 'eias-shopping',
      agent_id: 'roselin',
      agent_name: '로젤린',
    });
    const result = extractMessageCaller(ev);
    expect(result?.source).toBe('agent');
    expect(result?.agent_node).toBe('eias-shopping');
    expect(result?.agent_id).toBe('roselin');
    expect(result?.agent_name).toBe('로젤린');
  });

  it('prefers nested caller_info over flat top-level when both present', () => {
    const ev = makeEvent({
      text: 'hi',
      source: 'agent',           // flat (ignored)
      agent_id: 'flat-fallback', // flat (ignored)
      caller_info: {
        source: 'slack',
        avatar_url: 'https://avatars.slack-edge.com/foo.png',
      },
    });
    const result = extractMessageCaller(ev);
    expect(result?.source).toBe('slack');
    expect(result?.avatar_url).toBe('https://avatars.slack-edge.com/foo.png');
    expect(result?.agent_id).toBeUndefined();
  });

  it('extracts slack source with avatar_url and slack sub-dict', () => {
    const ev = makeEvent({
      caller_info: {
        source: 'slack',
        display_name: '서소영',
        avatar_url: 'https://avatars.slack-edge.com/abc.png',
        slack: { channel_id: 'C01', user_id: 'U02', thread_ts: '123.456' },
      },
    });
    const result = extractMessageCaller(ev);
    expect(result?.source).toBe('slack');
    expect(result?.display_name).toBe('서소영');
    expect(result?.avatar_url).toBe('https://avatars.slack-edge.com/abc.png');
    expect(result?.slack).toEqual({
      channel_id: 'C01',
      user_id: 'U02',
      thread_ts: '123.456',
    });
  });

  it('treats agent_id null as explicit (not silently dropped)', () => {
    // 서버는 agent_id를 명시적으로 null로 보낼 수 있다 (caller_profile=None 케이스).
    const ev = makeEvent({
      caller_info: { source: 'agent', agent_node: 'n1', agent_id: null },
    });
    const result = extractMessageCaller(ev);
    expect(result?.agent_id).toBeNull();
  });

  it('extracts system source passthrough — F-11H 시스템 발신 wire', () => {
    // F-11 (2026-05-09, atom F-11): build_system_caller_info가 박은 wire 페이로드가
    // extractMessageCaller를 통과해 source==='system'으로 보존되어야 UserMessage가
    // 로컬 정적 자산(icon-symbol.png) 분기로 떨어진다 (TI1 회귀 보호).
    const ev = makeEvent({
      caller_info: {
        source: 'system',
        agent_node: 'eias-shopping',
        display_name: 'Soulstream',
        user_id: null,
        avatar_url: null,
      },
    });
    const result = extractMessageCaller(ev);
    expect(result?.source).toBe('system');
    expect(result?.display_name).toBe('Soulstream');
    // extractor 정책: avatar_url은 string만 추출(L77). null/undefined → 결과에서 제외.
    // UserMessage의 isSystem 분기는 source만 검사하므로 avatar_url 부재가 정상 동작.
    expect(result?.avatar_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pickUserAvatarUri — caller-aware (신규) + caller=null (PR #7 보존, 케이스 4 정정)
// ---------------------------------------------------------------------------

describe('pickUserAvatarUri (caller present — 본인 아닌 발신자)', () => {
  it('source=agent + avatar_url relative → server prepend with Bearer', () => {
    const caller: MessageCaller = {
      source: 'agent',
      agent_node: 'eias-shopping',
      agent_id: 'roselin',
      avatar_url: '/api/nodes/eias-shopping/agents/roselin/portrait',
    };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({
      uri: 'https://soul.example.com/api/nodes/eias-shopping/agents/roselin/portrait',
      useBearer: true,
    });
  });

  it('source=agent + avatar_url null (no portrait) → null uri (fallback char)', () => {
    const caller: MessageCaller = {
      source: 'agent',
      agent_node: 'n1',
      agent_id: 'a1',
      // avatar_url 없음 — 서버가 portrait_path 없는 에이전트라 비채움
    };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({ uri: null, useBearer: false });
  });

  it('source=slack + avatar_url https → external no Bearer', () => {
    const caller: MessageCaller = {
      source: 'slack',
      avatar_url: 'https://avatars.slack-edge.com/foo.png',
    };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({
      uri: 'https://avatars.slack-edge.com/foo.png',
      useBearer: false,
    });
  });

  it('source=browser + avatar_url https → external no Bearer (also overrides own profile)', () => {
    // 다른 사람의 browser 세션으로 보낸 메시지 — 본인 picture를 덮어쓰면 안 됨
    const caller: MessageCaller = {
      source: 'browser',
      avatar_url: 'https://lh3.googleusercontent.com/other-user',
    };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({
      uri: 'https://lh3.googleusercontent.com/other-user',
      useBearer: false,
    });
  });

  it('caller present + avatar_url relative + serverUrl null → null uri', () => {
    const caller: MessageCaller = {
      source: 'agent',
      avatar_url: '/api/nodes/n/agents/a/portrait',
    };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', null);
    expect(result).toEqual({ uri: null, useBearer: false });
  });

  it('caller present + avatar_url empty string → null uri (treated as missing)', () => {
    const caller: MessageCaller = { source: 'agent', avatar_url: '' };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({ uri: null, useBearer: false });
  });

  it('caller present + no avatar_url → null uri even though profile.picture exists', () => {
    // 본인이 아닌 발신자에게 본인 picture 표시 *금지* — 결함의 본질
    const caller: MessageCaller = { source: 'agent', agent_id: 'a1' };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result.uri).toBeNull();
  });

  it('strips trailing slash from serverUrl when joining caller relative avatar_url', () => {
    const caller: MessageCaller = {
      source: 'agent',
      avatar_url: '/api/nodes/n/agents/a/portrait',
    };
    const result = pickUserAvatarUri(
      caller,
      PROFILE,
      '/api/users/me/portrait',
      'https://soul.example.com/',
    );
    expect(result.uri).toBe(
      'https://soul.example.com/api/nodes/n/agents/a/portrait',
    );
  });
});

// PR #7 기존 9개 케이스 — 새 시그니처로 mechanical 변환.
// 케이스 4 (`falls back to absolute session userPortraitUrl unchanged`)는 expected
// useBearer를 false로 변경 (외부 URL 일관성 정책, plan.json §1 ⚠️).
describe('pickUserAvatarUri (caller=null — 본인 발신, PR #7 흐름)', () => {
  it('returns Google picture when profile is available (no Bearer)', () => {
    const result = pickUserAvatarUri(null, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({
      uri: 'https://lh3.googleusercontent.com/a/ABC123',
      useBearer: false,
    });
  });

  it('prefers Google picture over fallback portrait', () => {
    const result = pickUserAvatarUri(null, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result.uri).toBe('https://lh3.googleusercontent.com/a/ABC123');
    expect(result.useBearer).toBe(false);
  });

  it('falls back to fallbackPortraitUrl (relative) with Bearer when profile is null', () => {
    const result = pickUserAvatarUri(null, null, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({
      uri: 'https://soul.example.com/api/users/me/portrait',
      useBearer: true,
    });
  });

  it('falls back to absolute fallbackPortraitUrl unchanged WITHOUT Bearer (case 4 정정 — external URL 정책 일관)', () => {
    const result = pickUserAvatarUri(
      null,
      null,
      'https://other.example.com/img.png',
      SERVER,
    );
    expect(result).toEqual({
      uri: 'https://other.example.com/img.png',
      useBearer: false,
    });
  });

  it('strips trailing slash from serverUrl when joining relative portrait', () => {
    const result = pickUserAvatarUri(
      null,
      null,
      '/api/users/me/portrait',
      'https://soul.example.com/',
    );
    expect(result.uri).toBe('https://soul.example.com/api/users/me/portrait');
  });

  it('returns null uri when profile null + no fallbackPortraitUrl', () => {
    const result = pickUserAvatarUri(null, null, null, SERVER);
    expect(result).toEqual({ uri: null, useBearer: false });
  });

  it('returns null uri when profile null + serverUrl is null (cannot resolve relative)', () => {
    const result = pickUserAvatarUri(null, null, '/api/users/me/portrait', null);
    expect(result).toEqual({ uri: null, useBearer: false });
  });

  it('returns null uri when profile null + fallbackPortraitUrl undefined', () => {
    const result = pickUserAvatarUri(null, null, undefined, SERVER);
    expect(result).toEqual({ uri: null, useBearer: false });
  });

  it('treats empty profile picture as missing — falls through to fallback portrait', () => {
    const profileNoPic: GoogleProfile = { ...PROFILE, picture: '' };
    const result = pickUserAvatarUri(null, profileNoPic, '/api/users/me/portrait', SERVER);
    expect(result).toEqual({
      uri: 'https://soul.example.com/api/users/me/portrait',
      useBearer: true,
    });
  });
});

// ---------------------------------------------------------------------------
// pickFallbackChar — caller-aware (신규) + caller=null (PR #7 보존)
// ---------------------------------------------------------------------------

describe('pickFallbackChar (caller present)', () => {
  it('caller.display_name first char wins over profile.name', () => {
    const caller: MessageCaller = { source: 'slack', display_name: '서소영' };
    expect(pickFallbackChar(caller, PROFILE, 'Jubok Kim', '나')).toBe('서');
  });

  it('caller.agent_name used when display_name absent', () => {
    const caller: MessageCaller = { source: 'agent', agent_name: '로젤린' };
    expect(pickFallbackChar(caller, PROFILE, 'Jubok Kim', '나')).toBe('로');
  });

  it('falls through to profile.name when caller fields empty', () => {
    const caller: MessageCaller = { source: 'agent' };
    expect(pickFallbackChar(caller, PROFILE, 'Jubok Kim', '나')).toBe('J');
  });

  it('falls through to fallbackName when caller and profile null/empty', () => {
    const caller: MessageCaller = { source: 'agent' };
    expect(pickFallbackChar(caller, null, 'Soyoung', '·')).toBe('S');
  });

  it('returns defaultChar when all sources empty', () => {
    const caller: MessageCaller = { source: 'agent' };
    expect(pickFallbackChar(caller, null, null, '·')).toBe('·');
  });
});

describe('pickFallbackChar (caller=null — PR #7 보존)', () => {
  it('uses profile.name first character when available', () => {
    expect(pickFallbackChar(null, PROFILE, 'OtherName', '나')).toBe('J');
  });

  it('falls back to fallbackName first character when profile is null', () => {
    expect(pickFallbackChar(null, null, 'Soyoung', '나')).toBe('S');
  });

  it('returns defaultChar when profile null and fallbackName null', () => {
    expect(pickFallbackChar(null, null, null, '나')).toBe('나');
  });

  it('returns defaultChar when profile null and fallbackName undefined', () => {
    expect(pickFallbackChar(null, null, undefined, '나')).toBe('나');
  });

  it('uses fallbackName when profile.name is empty string', () => {
    const profileNoName: GoogleProfile = { ...PROFILE, name: '' };
    expect(pickFallbackChar(null, profileNoName, 'Soyoung', '나')).toBe('S');
  });

  it('returns defaultChar when profile.name and fallbackName are both empty', () => {
    const profileNoName: GoogleProfile = { ...PROFILE, name: '' };
    expect(pickFallbackChar(null, profileNoName, '', '나')).toBe('나');
  });

  it('AssistantMessage usage — defaultChar="·"', () => {
    expect(pickFallbackChar(null, null, null, '·')).toBe('·');
  });
});
