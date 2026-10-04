import { createApiClient } from '../fixture-client';
import { createReviewApi, sessions } from '../fixtures';

// Metro runs this client in a browser; jest-expo provides window without location.
beforeAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: { search: '?section=entryShell' } });
});

it('entry shell session lookup inherits the existing array contract', async () => {
  const api = createApiClient();
  expect(await api.getSessionsByIds(['public-running'])).toEqual([sessions[0]]);
  expect(await api.getSessionsByIds(['public-shell-session-0'])).toEqual([]);
});

it.each([
  ['common review API', () => createReviewApi()],
  ['Metro entry shell client', () => createApiClient()],
])('%s supplies the chat transport and initial history contracts', async (_name, create) => {
  const api = create();
  expect(typeof api.sessionEventsUrl).toBe('function');
  expect(typeof api.getTimeline).toBe('function');
  expect(api.sessionEventsUrl('public-shell-session-0')).toBeTruthy();
  expect(await api.getTimeline('public-shell-session-0')).toEqual({ messages: [], next_cursor: null });
  const url = api.sessionEventsUrl('public-shell-session-0');
  const frames = decodeURIComponent(url.split(',')[1]).trim().split('\n\n');
  expect(frames).toHaveLength(3);
  expect(frames[0]).toContain('event: user_message');
  expect(frames[1]).toContain('event: assistant_message');
  expect(frames[0]).toContain('"session_id":"public-shell-session-0"');
  expect(frames[2]).toContain('event: history_sync');
  const resumed = decodeURIComponent(api.sessionEventsUrl('public-shell-session-1', '1').split(',')[1]);
  expect(resumed).not.toContain('event: user_message');
  expect(resumed).toContain('event: assistant_message');
  expect(resumed).toContain('"session_id":"public-shell-session-1"');
});
