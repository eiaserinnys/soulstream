import { useEffect } from 'react';
import { captureAuthScope } from '../lib/auth-scope';
import { useSearchStore } from '../store/searchStore';
import { usePersistentDraft } from './usePersistentDraft';

/** searchStore remains the runtime owner; draftStore is its only query persistence. */
export function usePersistentSearch() {
  const draft = usePersistentDraft('session-search', [], '');
  useEffect(() => {
    if (!draft.ready) return;
    const scope = captureAuthScope();
    useSearchStore.setState({ query: draft.value, selectedResultIndex: 0 });
    return useSearchStore.subscribe((next, previous) => {
      if (captureAuthScope().generation !== scope.generation) return;
      if (next.query !== previous.query) draft.setValue(next.query);
    });
    // A scope change restores once. Query changes then come from searchStore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.key, draft.ready]);
}
