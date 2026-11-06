import type { CardReviewPushData, PersistentReportPushData } from '../../../../packages/wire-schema/src/push_notification';
import { parseNotificationTarget } from '../notificationTarget';

const review = { kind: 'card_review', cardId: 'card-1', folderId: 'folder-1' } satisfies CardReviewPushData;
const report = { kind: 'persistent_report', persistentSessionId: 'pas-1', entryKey: 'entry-1', reportKind: 'see' } satisfies PersistentReportPushData;
const question = { ...report, reportKind: 'ask', cardId: 'card-2', questionId: 'question-1', folderId: 'folder-1' } satisfies PersistentReportPushData;

test.each([
  [review, { kind: 'card', cardId: 'card-1' }],
  [question, { kind: 'card', cardId: 'card-2' }],
  [report, { kind: 'report', sessionId: 'pas-1', entryKey: 'entry-1' }],
  [{ sessionId: 'old-1' }, { kind: 'session', sessionId: 'old-1' }],
  [{ ...question, sessionId: 'old-1' }, { kind: 'card', cardId: 'card-2' }],
  [null, null], [{}, null], [{ cardId: '' }, null], [{ sessionId: '' }, null],
  [{ kind: 'persistent_report', persistentSessionId: 'pas-1' }, null],
  [{ kind: 'persistent_report', persistentSessionId: '', entryKey: 'entry-1' }, null],
  [{ kind: 'persistent_report', persistentSessionId: 'pas-1', entryKey: '' }, null],
])('알림 목적지 판별 %#', (data, expected) => {
  expect(parseNotificationTarget(data)).toEqual(expected);
});
