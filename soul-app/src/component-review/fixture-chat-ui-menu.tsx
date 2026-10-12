import React from 'react';
import { EventContextMenu as NativeMenu, createEventMenuActions } from '../components/events/EventContextMenu';
export { createEventMenuActions, createEventActionSheetOptions } from '../components/events/EventContextMenu';

/** RN web has no ActionSheetIOS. Expose the real actions at the OS menu boundary. */
export function EventContextMenu(props: React.ComponentProps<typeof NativeMenu>) {
  if (new URLSearchParams(window.location.search).get('section') !== 'chatUiRenderer') return <NativeMenu {...props} />;
  return <div style={{ display: 'contents' }} onContextMenu={event => {
    if (props.selectionActive) return;
    event.preventDefault(); event.stopPropagation();
    const actions = createEventMenuActions(props.sessionId, props.event, props.resultEvent, props.onSelectText, props.getMessageText);
    (window as Window & { __chatUiReviewMenu?: { labels: string[]; choose(label: string): void | Promise<void> } }).__chatUiReviewMenu = {
      labels: actions.map(action => action.text),
      choose: label => actions.find(action => action.text === label)?.run(),
    };
  }}><NativeMenu {...props} /></div>;
}
