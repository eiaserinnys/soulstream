import type { Session } from '../../api/types';
import { preserveNewestLastMessage } from '../session-last-message';

function session(timestamp: string, eventId?: number): Session {
  return { agentSessionId: 's', displayName: null, status: 'idle', createdAt: timestamp,
    updatedAt: timestamp, lastMessage: { type: 'assistant_message', preview: 'message', timestamp, eventId } };
}
test('timestamp wins over event ID, including DB microseconds and equivalent offsets', () => {
  const existing = session('2026-10-04T12:00:00.000002Z', 10);
  expect(preserveNewestLastMessage(existing, session('2026-10-04T12:00:00.000001Z', 1002)).lastMessage).toBe(existing.lastMessage);
  const newer = session('2026-10-04T21:00:00.000003+09:00', 1);
  expect(preserveNewestLastMessage(existing, newer)).toBe(newer);
});
test('canonical ties use eventId; legacy writes only replace on later timestamp', () => {
  const existing = session('2026-10-04T12:00:00Z', 1002);
  expect(preserveNewestLastMessage(existing, session(existing.createdAt, 1001)).lastMessage).toBe(existing.lastMessage);
  expect(preserveNewestLastMessage(existing, session(existing.createdAt)).lastMessage).toBe(existing.lastMessage);
  const next = session(existing.createdAt, 1003);
  expect(preserveNewestLastMessage(existing, next)).toBe(next);
  const legacy = session(existing.createdAt);
  expect(preserveNewestLastMessage(legacy, next)).toBe(next);
  const laterLegacy = session('2026-10-04T12:00:01Z');
  expect(preserveNewestLastMessage(existing, laterLegacy)).toBe(laterLegacy);
});
