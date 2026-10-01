import { ActionSheetIOS, Alert, Platform } from 'react-native';
import type { PlannerContextMenuAction } from '../../lib/planner-context-menu-model';

export function showAppContextMenu(
  actions: readonly PlannerContextMenuAction[],
  title?: string,
) {
  if (Platform.OS === 'ios') {
    const options = [
      ...actions.map((action) => action.disabled && action.disabledReason
        ? `${action.label} — ${action.disabledReason}`
        : action.label),
      '취소',
    ];
    const cancelButtonIndex = options.length - 1;
    ActionSheetIOS.showActionSheetWithOptions({
      title,
      options,
      cancelButtonIndex,
      destructiveButtonIndex: actions
        .map((action, index) => action.destructive ? index : -1)
        .filter((index) => index >= 0),
      disabledButtonIndices: actions
        .map((action, index) => action.disabled ? index : -1)
        .filter((index) => index >= 0),
    }, (index) => {
      const action = actions[index];
      if (action && !action.disabled) void action.onSelect();
    });
    return;
  }

  Alert.alert(title ?? '메뉴', undefined, [
    ...actions.map((action) => ({
      text: action.disabled && action.disabledReason
        ? `${action.label} — ${action.disabledReason}`
        : action.label,
      style: action.destructive ? 'destructive' as const : 'default' as const,
      onPress: action.disabled
        ? () => Alert.alert(action.disabledReason ?? '현재 실행할 수 없습니다.')
        : () => { void action.onSelect(); },
    })),
    { text: '취소', style: 'cancel' as const },
  ]);
}

export function AppContextMenu() {
  return null;
}
