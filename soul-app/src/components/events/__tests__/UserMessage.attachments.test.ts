import {
  extractAttachments,
  resolveAttachmentNodeId,
  buildAttachmentUri,
} from '../UserMessage';
import type { Session, SessionEvent } from '../../../api/types';

/**
 * Phase 2 (atom 260513.02 — chat-inline-attachment): 사용자 발화 말풍선
 * 인라인 첨부 표시 헬퍼 검증.
 */

const ev = (type: string, data: any): SessionEvent => ({
  id: '1',
  type: type as SessionEvent['type'],
  data,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  agentSessionId: 's-1',
  displayName: null,
  status: 'idle',
  createdAt: '2026-05-13T00:00:00Z',
  updatedAt: '2026-05-13T00:00:00Z',
  ...overrides,
});

describe('extractAttachments', () => {
  test('attachments 배열에서 string path만 추출', () => {
    expect(
      extractAttachments(
        ev('user_message', {
          attachments: ['/incoming/s/a.png', '/incoming/s/b.png'],
        }),
      ),
    ).toEqual(['/incoming/s/a.png', '/incoming/s/b.png']);
  });

  test('빈 문자열은 필터링', () => {
    expect(
      extractAttachments(ev('user_message', { attachments: ['/a.png', ''] })),
    ).toEqual(['/a.png']);
  });

  test('attachments 누락 → 빈 배열', () => {
    expect(extractAttachments(ev('user_message', { text: 'hi' }))).toEqual([]);
  });

  test('attachments 비배열(string 등) → 빈 배열', () => {
    expect(
      extractAttachments(ev('user_message', { attachments: '/a.png' })),
    ).toEqual([]);
  });

  test('attachments 배열 안 non-string 필터링', () => {
    expect(
      extractAttachments(
        ev('user_message', { attachments: ['/a.png', 42, null, undefined] as any }),
      ),
    ).toEqual(['/a.png']);
  });
});

describe('resolveAttachmentNodeId', () => {
  test('session.nodeId 우선', () => {
    expect(
      resolveAttachmentNodeId(
        session({ nodeId: 'eias-shopping' }),
        ev('user_message', { node_id: 'event-node' }),
      ),
    ).toBe('eias-shopping');
  });

  test('session.nodeId 없으면 event.data.node_id fallback', () => {
    expect(
      resolveAttachmentNodeId(
        session({}),
        ev('user_message', { node_id: 'event-node' }),
      ),
    ).toBe('event-node');
  });

  test('session 없으면 event.data.node_id fallback', () => {
    expect(
      resolveAttachmentNodeId(undefined, ev('user_message', { node_id: 'evn' })),
    ).toBe('evn');
  });

  test('둘 다 없으면 undefined', () => {
    expect(
      resolveAttachmentNodeId(session({}), ev('user_message', { text: 'x' })),
    ).toBeUndefined();
  });

  test('빈 문자열은 부재로 취급', () => {
    expect(
      resolveAttachmentNodeId(
        session({ nodeId: '' }),
        ev('user_message', { node_id: '' }),
      ),
    ).toBeUndefined();
  });
});

describe('buildAttachmentUri', () => {
  test('정상 인코딩', () => {
    const uri = buildAttachmentUri(
      'https://node.example',
      'eias-shopping',
      '/incoming/sess-1/001 photo.png',
    );
    expect(uri).toBe(
      'https://node.example/api/attachments/files?nodeId=eias-shopping&path=%2Fincoming%2Fsess-1%2F001%20photo.png',
    );
  });

  test('nodeId 없으면 null', () => {
    expect(buildAttachmentUri('https://x', undefined, '/a')).toBeNull();
  });

  test('serverUrl 없으면 null', () => {
    expect(buildAttachmentUri(null, 'n', '/a')).toBeNull();
  });

  test('특수 문자 path 안전하게 인코딩', () => {
    const uri = buildAttachmentUri('https://x', 'n', '/a?b=c&d=e');
    expect(uri).toContain('path=%2Fa%3Fb%3Dc%26d%3De');
  });
});
