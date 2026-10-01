import { getSessionDisplayName } from '../session-display-name';
import type { Session } from '../../api/types';

function mkSession(overrides: Partial<Session>): Session {
  return {
    agentSessionId: 'sess-abcdef1234567890',
    displayName: null,
    status: 'idle',
    createdAt: '2026-05-05T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
    ...overrides,
  };
}

describe('getSessionDisplayName', () => {
  test('displayName이 있으면 그대로 사용', () => {
    const session = mkSession({ displayName: '내가 정한 이름' });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('내가 정한 이름');
  });

  test('displayName이 빈 문자열이면 폴백으로 진행', () => {
    const session = mkSession({
      displayName: '',
      lastMessage: { preview: '안녕하세요' },
    });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('안녕하세요');
  });

  test('displayName이 null이면 lastMessage.preview 첫 줄 사용', () => {
    const session = mkSession({
      lastMessage: { preview: '첫 줄입니다.\n둘째 줄은 무시.' },
    });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('첫 줄입니다.');
  });

  test('preview가 공백/개행만 있으면 제목 없는 세션 폴백', () => {
    const session = mkSession({
      agentSessionId: 'sess-12345678abcdef',
      lastMessage: { preview: '   \n   ' },
    });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('제목 없는 세션');
  });

  test('preview 첫 줄 좌우 공백은 trim', () => {
    const session = mkSession({
      lastMessage: { preview: '   안녕   \n  다음 줄  ' },
    });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('안녕');
  });

  test('displayName 없고 lastMessage도 없으면 제목 없는 세션', () => {
    const session = mkSession({ agentSessionId: 'sess-abcdef1234567890' });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('제목 없는 세션');
  });

  test('lastMessage는 있지만 preview가 undefined면 제목 없는 세션', () => {
    const session = mkSession({
      agentSessionId: 'sess-xyz12345abcdef',
      lastMessage: { type: 'tool_use' },
    });
    expect(getSessionDisplayName(session, session.agentSessionId)).toBe('제목 없는 세션');
  });

  test('session 자체가 undefined면 제목 없는 세션', () => {
    expect(getSessionDisplayName(undefined, 'sess-routeparam12345')).toBe('제목 없는 세션');
  });

  test('짧은 UUID도 화면에 노출하지 않는다', () => {
    expect(getSessionDisplayName(undefined, 'short')).toBe('제목 없는 세션');
  });
});
