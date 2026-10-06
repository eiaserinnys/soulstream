import type { PersistentSessionResource } from '../api/persistentSessionEndpoints';

export type PersistentSessionEntry =
  | { kind: 'add' | 'home' | 'choose' }
  | { kind: 'open'; session: PersistentSessionResource };

export function resolvePersistentSessionEntry(
  sessions: PersistentSessionResource[], lastSessionId: string | null, startup: boolean,
): PersistentSessionEntry {
  if (sessions.length === 0) return { kind: startup ? 'home' : 'add' };
  if (sessions.length === 1) return { kind: 'open', session: sessions[0] };
  const last = startup ? sessions.find((session) => session.session_id === lastSessionId) : undefined;
  return last ? { kind: 'open', session: last } : { kind: 'choose' };
}
