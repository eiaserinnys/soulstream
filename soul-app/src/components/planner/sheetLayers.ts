import { Platform, type ViewStyle } from 'react-native';

/**
 * The sheet body stays mounted under a covering layer (the reference picker), so its input and scroll position
 * survive the trip. On the web the covered body is also removed from the tab order.
 */
export const sheetLayerStyles = {
  layer: { flex: 1 } satisfies ViewStyle,
  coveredLayer: { opacity: 0, ...(Platform.OS === 'web' ? { visibility: 'hidden' } : {}) } as ViewStyle,
  pickerLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } satisfies ViewStyle,
};
