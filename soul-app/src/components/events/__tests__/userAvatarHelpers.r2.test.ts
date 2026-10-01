/**
 * R-2 fix(2026-05-10) 핵심 안전망 — atom 7583fabd (G-4):
 *
 * soulstream 측 R-2 fix(Fix A·D)로 task.caller_info에 최소한 source가 박힌 wire가
 * soul-app까지 도달한다. soul-app은 *코드 변경 0건*으로 정상 동작해야 한다 — 즉
 * extractMessageCaller가 source-only caller_info를 caller 객체로 반환하고,
 * pickUserAvatarUri가 caller가 있으면 본인(profile.picture) 아바타로 fallback
 * 하지 않는다.
 *
 * 본 회귀가 깨지면 R-2 fix 의도가 무력화된다 (위임 메시지가 본인 아바타로 표시).
 */
import {
  extractMessageCaller,
  pickUserAvatarUri,
  type MessageCaller,
} from '../userAvatarHelpers';
import type { GoogleProfile } from '../../../auth/jwt-payload';
import type { SessionEvent } from '../../../api/types';

const SERVER = 'https://soul.example.com';

const PROFILE: GoogleProfile = {
  email: 'eiaserinnys@gmail.com',
  name: 'Jubok Kim',
  picture: 'https://lh3.googleusercontent.com/a/SELF',
};

function makeEvent(data: Record<string, unknown>): SessionEvent {
  return { id: 'e-r2', type: 'user_message', data } as SessionEvent;
}

describe('R-2 — extractMessageCaller treats source-only caller_info as a caller', () => {
  it('nested caller_info with only source returns a caller (not null)', () => {
    const event = makeEvent({ caller_info: { source: 'agent' } });
    const caller = extractMessageCaller(event);
    expect(caller).not.toBeNull();
    expect(caller?.source).toBe('agent');
  });

  it('flat (top-level) caller fields with only source returns a caller', () => {
    const event = makeEvent({ source: 'system' });
    const caller = extractMessageCaller(event);
    expect(caller).not.toBeNull();
    expect(caller?.source).toBe('system');
  });

  it.each(['agent', 'system', 'slack', 'soul-app', 'browser', 'api'] as const)(
    'every v1 source promotes to caller object — %s',
    (source) => {
      const event = makeEvent({ caller_info: { source } });
      const caller = extractMessageCaller(event);
      expect(caller).not.toBeNull();
      expect(caller?.source).toBe(source);
    },
  );
});

describe('R-2 — pickUserAvatarUri does NOT fall back to profile.picture when caller exists', () => {
  it('source-only caller (agent) → uri null, not profile.picture (G-4 안전망)', () => {
    const caller: MessageCaller = { source: 'agent' };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result.uri).toBeNull();
    // 본인 profile.picture로 fallback 절대 금지 — caller가 있으면 본인이 아닌 다른 발신자.
    expect(result.uri).not.toBe(PROFILE.picture);
  });

  it('source-only caller (system) → uri null, not profile.picture', () => {
    const caller: MessageCaller = { source: 'system' };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result.uri).toBeNull();
    expect(result.uri).not.toBe(PROFILE.picture);
  });

  it('caller with avatar_url returns that avatar (not profile.picture)', () => {
    const caller: MessageCaller = {
      source: 'agent',
      avatar_url: '/api/nodes/node-1/agents/ag-x/portrait',
    };
    const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result.uri).toContain('/api/nodes/node-1/agents/ag-x/portrait');
    expect(result.uri).not.toBe(PROFILE.picture);
  });

  it('caller=null still falls back to profile.picture (회귀 보존)', () => {
    const result = pickUserAvatarUri(null, PROFILE, '/api/users/me/portrait', SERVER);
    expect(result.uri).toBe(PROFILE.picture);
  });

  it.each(['agent', 'system', 'slack', 'soul-app'] as const)(
    'identity-bearing source %s never falls to profile.picture',
    (source) => {
      const caller: MessageCaller = { source };
      const result = pickUserAvatarUri(caller, PROFILE, '/api/users/me/portrait', SERVER);
      expect(result.uri).not.toBe(PROFILE.picture);
    },
  );
});
