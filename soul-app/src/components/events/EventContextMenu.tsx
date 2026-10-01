import React, { useRef } from 'react';
import {
  ActionSheetIOS,
  Alert,
  findNodeHandle,
  Platform,
  Pressable,
  type ActionSheetIOSOptions,
  type View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { SessionEvent } from '../../api/types';
import { useTokens } from '../../theme';
import {
  buildEventAddress,
  extractEventCopyText,
} from './eventActions';
import {
  createMessageSelectionModel,
  type MessageSelectionModel,
} from './message-selection-model';

export interface EventMenuAction {
  text: string;
  run: () => void | Promise<void>;
}

interface Props {
  sessionId: string;
  event: SessionEvent;
  resultEvent?: SessionEvent;
  children: React.ReactNode;
  onSelectText?: (model: MessageSelectionModel) => void;
  selectionActive?: boolean;
}

function reportCopyFailure(e: any) {
  Alert.alert('복사 실패', e?.message ?? '알 수 없는 오류');
}

function hasStableEventAddress(event: SessionEvent): boolean {
  return (event.data as Record<string, unknown> | undefined)?._live_only !== true;
}

export function createEventMenuActions(
  sessionId: string,
  event: SessionEvent,
  resultEvent?: SessionEvent,
  onSelectText?: (model: MessageSelectionModel) => void,
): EventMenuAction[] {
  const actions: EventMenuAction[] = [
    {
      text: '내용 복사',
      run: async () => {
        const text = extractEventCopyText(event, resultEvent);
        if (!text.trim()) return;
        await Clipboard.setStringAsync(text);
      },
    },
  ];

  const selectionModel = createMessageSelectionModel(event);
  if (selectionModel && onSelectText) {
    actions.push({
      text: '선택하기',
      run: () => onSelectText(selectionModel),
    });
  }

  if (hasStableEventAddress(event)) {
    actions.push({
      text: '이벤트 주소 복사',
      run: async () => {
        await Clipboard.setStringAsync(buildEventAddress(sessionId, event.id));
      },
    });
  }

  return actions;
}

export function createEventActionSheetOptions(
  actions: readonly EventMenuAction[],
  anchor: number | null,
): ActionSheetIOSOptions {
  const options = [...actions.map((action) => action.text), '취소'];
  return {
    options,
    cancelButtonIndex: options.length - 1,
    title: '메시지',
    ...(anchor === null ? {} : { anchor }),
  };
}

export function EventContextMenu({
  sessionId,
  event,
  resultEvent,
  children,
  onSelectText,
  selectionActive = false,
}: Props) {
  const t = useTokens();
  const anchorRef = useRef<View>(null);
  const actions = createEventMenuActions(
    sessionId,
    event,
    resultEvent,
    onSelectText,
  );

  const runAction = (idx: number) => {
    const action = actions[idx];
    if (!action) return;
    try {
      Promise.resolve(action.run()).catch(reportCopyFailure);
    } catch (error) {
      reportCopyFailure(error);
    }
  };

  const openMenu = () => {
    if (Platform.OS !== 'ios' || selectionActive) return;
    const anchor = findNodeHandle(anchorRef.current);
    ActionSheetIOS.showActionSheetWithOptions(
      createEventActionSheetOptions(actions, anchor),
      runAction,
    );
  };

  return (
    <Pressable
      ref={anchorRef}
      testID="event-context-menu-anchor"
      collapsable={false}
      style={{ minWidth: t.foundation.hitTarget, minHeight: t.foundation.hitTarget }}
      onLongPress={selectionActive ? undefined : openMenu}
      delayLongPress={450}
    >
      {children}
    </Pressable>
  );
}
