import type { SessionWorkspaceResponse } from '../../../packages/wire-schema/src/session_workspace';
const baseFile = { orig_path: null, added: null, deleted: null, session_added: null, session_deleted: null, size: 1100, wrote: false, read: false, committed: false, last_activity_at: null };
export const reviewWorkspace: SessionWorkspaceResponse = {
  session_id: 'review-files', root: '/workspace/soulstream', node: { id: 'example', status: 'ok' }, attribution: 'full',
  snapshot: { state: 'ready', observed_at: '2026-11-22T06:12:00Z', refreshing: false, branch: 'card1802-outbox-backoff', head: null, upstream: null, ahead: 1, behind: 0, truncated: false },
  files: [
    { ...baseFile, path: 'soul-server-ts/src/config.ts', git_status: 'modified', added: 3, deleted: 1 },
    { ...baseFile, path: 'soul-server-ts/src/upstream/event_outbox_types.ts', git_status: null, wrote: true, committed: true, session_added: 142, session_deleted: 27 },
    { ...baseFile, path: 'soul-server-ts/src/upstream/event_outbox.ts', git_status: 'modified', wrote: true, added: 42, deleted: 18 },
    { ...baseFile, path: 'soul-server-ts/src/upstream/outbox_retry.ts', git_status: 'untracked', wrote: true, added: 33, deleted: 0 },
    { ...baseFile, path: 'soul-server-ts/tests/upstream/event_outbox.test.ts', git_status: 'modified', wrote: true, added: 61, deleted: 4 },
  ],
  read_only: [{ path: 'soul-server-ts/src/upstream/dispatcher.ts', size: null, last_read_at: null }, { path: 'packages/db-schema/sql/schema.sql', size: 1100, last_read_at: null }],
};
