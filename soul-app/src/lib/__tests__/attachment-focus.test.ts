import { AccessibilityInfo } from 'react-native';
import * as ReactNative from 'react-native';
import { restoreAttachmentFocus } from '../attachment-focus';

test('여는 쪽이 다음 프레임 전에 사라지면 포커스 복원을 조용히 건너뛴다', () => {
  jest.useFakeTimers();
  const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => undefined);
  jest.spyOn(ReactNative, 'findNodeHandle').mockImplementation(() => { throw new Error('Unable to find node on an unmounted component.'); });
  restoreAttachmentFocus({});
  expect(() => jest.runOnlyPendingTimers()).not.toThrow();
  expect(focus).not.toHaveBeenCalled();
  jest.useRealTimers();
});
