import { AccessibilityInfo, findNodeHandle, Platform } from 'react-native';

/** Restore the entry that opened a modal after its native surface unmounts. */
export function restoreAttachmentFocus(target: any): void {
  requestAnimationFrame(() => {
    if (Platform.OS === 'web') {
      target?.focus?.({ preventScroll: true });
      return;
    }
    const handle = findNodeHandle(target);
    if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
  });
}
