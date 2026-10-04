import { createApiClient } from '../fixture-client';
import { createReviewApi, sessions, entryShellCardId, entryShellFolders, entryShellSessions } from '../fixtures';

const setReviewSection = (section: string) => {
  Object.defineProperty(window, 'location', { configurable: true, value: { search: `?section=${section}` } });
};

// Metro runs this client in a browser; jest-expo provides window without location.
beforeAll(() => setReviewSection('entryShell'));

it('entry shell session lookup inherits the existing array contract', async () => {
  const api = createApiClient();
  expect(await api.getSessionsByIds(['public-running'])).toEqual([sessions[0]]);
  expect(await api.getSessionsByIds(['public-unknown'])).toEqual([]);
});

it('entry shell first-row lookup returns the same public list data', async () => {
  const firstRow = entryShellSessions[0];
  expect(firstRow).toMatchObject({ ...sessions[0], agentSessionId: 'public-shell-session-0', displayName: '담당 카드에 연결된 공개 세션', folderId: 'public-shell-folder-0' });
  expect(entryShellSessions).toHaveLength(20);
  expect(sessions).toHaveLength(5);
  expect(await createApiClient().getSessionsByIds([firstRow.agentSessionId])).toEqual([firstRow]);
});

it('entry shell feed samples keep assignee, linked, folder, and standalone data aligned', async () => {
  const api = createApiClient();
  const [assignee, linked, folderOnly, standalone] = entryShellSessions;
  const { cards } = await api.listCards(undefined, { includeCompleted: true });
  const card = cards.find((item) => item.id === entryShellCardId);
  const detail = await api.getCard(entryShellCardId);

  expect(assignee.cardId).toBeUndefined();
  expect(card).toMatchObject({ folderId: entryShellFolders[0].id, assigneeSessionId: assignee.agentSessionId });
  expect(linked).toMatchObject({ cardId: entryShellCardId, callerSessionId: assignee.agentSessionId, folderId: card?.folderId });
  expect(detail.sessions.map((session) => session.agentSessionId)).toEqual([
    assignee.agentSessionId, linked.agentSessionId,
  ]);
  expect(folderOnly).toMatchObject({ folderId: entryShellFolders[2].id });
  expect(standalone.folderId).toBeNull();
  await expect(api.getPlannerFolder(folderOnly.folderId!, { includeCompleted: false }))
    .resolves.toMatchObject({ folder: entryShellFolders[2], page: { id: entryShellFolders[2].projectPageId } });
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

it('native settings review client keeps settings and owned-agent APIs together', async () => {
  setReviewSection('nativeSettings');
  try {
    const api = createApiClient();
    expect(await api.getProviderUsage('public-node')).toMatchObject({ providers: { claude: { status: 'auto' } } });
    expect(await api.listOwnedAgents()).toMatchObject({
      agents: [],
      existingConnection: { configured: true, registered: false },
    });
  } finally {
    setReviewSection('entryShell');
  }
});
