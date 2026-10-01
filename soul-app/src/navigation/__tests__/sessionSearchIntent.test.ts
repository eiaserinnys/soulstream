import { parseSessionSearchIntentUrl } from '../sessionSearchIntent';

test('app scheme accepts an optional exact event anchor', () => {
  expect(parseSessionSearchIntentUrl('soulstream:///?session=session-a&event=42'))
    .toEqual({ kind: 'intent', intent: { sessionId: 'session-a', eventId: 42 } });
  expect(parseSessionSearchIntentUrl('soulstream:///?session=session-a'))
    .toEqual({ kind: 'intent', intent: { sessionId: 'session-a' } });
});

test('universal root links and legacy feed links preserve the session intent', () => {
  expect(parseSessionSearchIntentUrl('https://example.test/?session=session-a'))
    .toEqual({ kind: 'intent', intent: { sessionId: 'session-a' } });
  expect(parseSessionSearchIntentUrl('https://example.test/v1#/feed/session-b?event=9'))
    .toEqual({ kind: 'intent', intent: { sessionId: 'session-b', eventId: 9 } });
});

test('malformed event and unrelated links are not opened as a session', () => {
  expect(parseSessionSearchIntentUrl('soulstream:///?session=session-a&event=nope'))
    .toEqual({ kind: 'invalid', reason: 'invalid_event' });
  expect(parseSessionSearchIntentUrl('soulstream://usage')).toBeNull();
  expect(parseSessionSearchIntentUrl('https://example.test/planner?session=session-a'))
    .toBeNull();
});
