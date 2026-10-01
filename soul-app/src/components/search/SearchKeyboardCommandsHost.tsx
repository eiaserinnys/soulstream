import React from 'react';
import {
  SearchCommandsView,
  type SearchCommandEvent,
} from '../../../modules/soul-app-search-commands/src';
import { applySearchKeyboardCommand } from '../../store/searchKeyboardCommands';
import { useSearchStore } from '../../store/searchStore';

export function SearchKeyboardCommandsHost({
  children,
}: {
  children: React.ReactNode;
}) {
  const resultCount = useSearchStore((state) => state.resultCount);
  return (
    <SearchCommandsView
      onCommand={(event: SearchCommandEvent) =>
        applySearchKeyboardCommand(event, resultCount)
      }
    >
      {children}
    </SearchCommandsView>
  );
}
