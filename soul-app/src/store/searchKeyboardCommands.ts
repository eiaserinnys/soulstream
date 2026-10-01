import { useSearchStore } from './searchStore';

export interface SearchKeyboardCommand {
  input: string;
  command: boolean;
}

export function applySearchKeyboardCommand(
  event: SearchKeyboardCommand,
  resultCount: number,
): void {
  const store = useSearchStore.getState();
  const input = event.input.toLowerCase();
  if (event.command && (input === 'k' || input === 'f')) {
    store.requestSearchFocus();
    return;
  }
  if (!store.tabletActive) return;
  if (event.input === 'ArrowDown') {
    store.setSelectedResultIndex(
      Math.min(Math.max(0, resultCount - 1), store.selectedResultIndex + 1),
    );
    return;
  }
  if (event.input === 'ArrowUp') {
    store.setSelectedResultIndex(Math.max(0, store.selectedResultIndex - 1));
    return;
  }
  if (event.input === 'Enter' && resultCount > 0) {
    store.requestActivateSelection();
    return;
  }
  if (event.input !== 'Escape') return;
  if (store.query) {
    store.setQuery('');
  } else {
    store.closeTabletSearch();
  }
}
