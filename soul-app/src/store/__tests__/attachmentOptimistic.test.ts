import type { SessionEvent } from '../../api/types';
import type { PendingOptimisticEvent } from '../chatStore';
import { useChatStore } from '../chatStore';
import { matchesAttachmentPending } from '../../lib/attachment-message-match';

const SID = 'attachment-optimistic-test';
const NODE_ID = 'node-1';
const PATHS = ['/incoming/photo.png', '/incoming/notes.txt'];

function note(path: string): string {
  return `[첨부 파일 로컬 경로: ${path}]`;
}

function makePending(body: string, paths: readonly string[] = PATHS): PendingOptimisticEvent {
  const notes = paths.map(note).join('\n');
  const text = notes.length === 0 ? body : body ? `${body}\n\n${notes}` : notes;
  return {
    id: 'optimistic-user-test',
    type: 'user_message',
    data: {
      text,
      attachments: [...paths],
      node_id: NODE_ID,
    },
    originalText: body,
    attachmentItems: paths.map((path) => ({ path })),
  };
}

function makeEvent(
  body: string,
  options: { paths?: readonly string[]; notes?: boolean; nodeId?: string } = {},
): SessionEvent {
  const paths = options.paths ?? PATHS;
  const text = options.notes
    ? [body, ...paths.map(note)].filter(Boolean).join('\n\n')
    : body;
  return {
    id: '12',
    type: 'user_message',
    data: {
      text,
      attachments: [...paths],
      ...(options.nodeId === undefined ? { node_id: NODE_ID } : { node_id: options.nodeId }),
      ...(options.notes ? {} : { attachment_ids: paths.map((_, index) => `attachment-${index}`) }),
    },
  };
}

function reset(): void {
  useChatStore.getState().clearSession(SID);
  useChatStore.setState({ pendingOptimisticBySession: {} });
}

describe('matchesAttachmentPending', () => {
  it.each([
    ['첨부만', ''],
    ['본문과 첨부', '이 파일을 확인해줘'],
  ])('%s 전송은 ID 확정 이벤트에서 관리 경로 note를 무시한다', (_label, body) => {
    expect(matchesAttachmentPending(makePending(body), makeEvent(body))).toBe(true);
  });

  it('legacy durable 이벤트가 관리 경로 note를 유지해도 첨부와 본문이 맞으면 확정한다', () => {
    expect(matchesAttachmentPending(
      makePending('이 파일을 확인해줘'),
      makeEvent('이 파일을 확인해줘', { notes: true }),
    )).toBe(true);
  });

  it('첨부가 없는 메시지는 기존 본문 완전 일치만 인정한다', () => {
    const pending = makePending('같은 본문', []);
    const matching: SessionEvent = { id: '20', type: 'user_message', data: { text: '같은 본문' } };
    const different: SessionEvent = { id: '21', type: 'user_message', data: { text: '다른 본문' } };

    expect(matchesAttachmentPending(pending, matching)).toBe(true);
    expect(matchesAttachmentPending(pending, different)).toBe(false);
  });

  it('다른 첨부 경로나 본문은 확정하지 않는다', () => {
    const pending = makePending('같은 본문');
    expect(matchesAttachmentPending(pending, makeEvent('같은 본문', { paths: ['/incoming/other.png'] }))).toBe(false);
    expect(matchesAttachmentPending(pending, makeEvent('다른 본문'))).toBe(false);
  });

  it('node snapshot이 다르면 같은 경로라도 확정하지 않는다', () => {
    expect(matchesAttachmentPending(makePending('같은 본문'), makeEvent('같은 본문', { nodeId: 'node-2' }))).toBe(false);
  });

  it('사용자가 직접 쓴 동일한 경로 note는 본문으로 보존한다', () => {
    const body = note(PATHS[0]!);
    const pending = makePending(body, [PATHS[0]!]);
    pending.originalText = `  ${body}  `;
    expect(matchesAttachmentPending(
      pending,
      makeEvent('', { paths: [PATHS[0]!] }),
    )).toBe(false);
  });
});

describe('chatStore attachment optimistic confirmation', () => {
  beforeEach(reset);

  it.each([
    ['첨부만', ''],
    ['본문과 첨부', '이 파일을 확인해줘'],
  ])('%s는 늦게 도착한 ID SSE와 한 행으로 확정한다', (_label, body) => {
    const pending = makePending(body);
    useChatStore.getState().setPendingOptimistic(SID, pending, true);
    useChatStore.getState().mergeEvents(SID, [makeEvent(body)]);

    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(1);
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
  });

  it.each([
    ['첨부만', ''],
    ['본문과 첨부', '이 파일을 확인해줘'],
  ])('%s는 history가 먼저 도착하면 optimistic 슬롯을 만들지 않는다', (_label, body) => {
    useChatStore.getState().mergeEvents(SID, [makeEvent(body, { notes: true })]);
    useChatStore.getState().setPendingOptimistic(SID, makePending(body));

    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(1);
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
  });
});
