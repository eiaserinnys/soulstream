import React from 'react';
import { EventContextMenu } from '../events/EventContextMenu';
import { createMessageSelectionModel } from '../events/message-selection-model';
import { useChatUiMessageText } from './ChatUiControllerProvider';

/** Only UI message menus subscribe to the screen's interactive state. */
export function ChatUiEventContextMenu(props: React.ComponentProps<typeof EventContextMenu>) {
  const getMessageText = useChatUiMessageText(props.event.data);
  const selectable = createMessageSelectionModel(props.event, getMessageText?.());
  return <EventContextMenu {...props} getMessageText={getMessageText}
    onSelectText={selectable ? props.onSelectText : undefined} />;
}
