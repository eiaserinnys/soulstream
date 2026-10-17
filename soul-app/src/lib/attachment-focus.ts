import { AccessibilityInfo, findNodeHandle, Platform } from 'react-native';

/** Restore the entry that opened a modal after its native surface unmounts. */
export function restoreAttachmentFocus(target: any): void {
  requestAnimationFrame(() => {
    if (Platform.OS === 'web') {
      target?.focus?.({ preventScroll: true });
      return;
    }
    // The opener can unmount before this frame (its list re-rendered); there is nothing left to focus then.
    let handle: number | null = null;
    try { handle = target ? findNodeHandle(target) : null; } catch { return; }
    if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
  });
}
