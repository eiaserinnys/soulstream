import { ActionSheetIOS, Alert, Platform } from 'react-native';
import { showAppContextMenu } from '../AppContextMenu';

describe('AppContextMenu native contracts', () => {
  afterEach(() => jest.restoreAllMocks());

  test('iOS preserves cancel, destructive, disabled reason, and selection semantics', () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const selected = jest.fn();
    const disabled = jest.fn();
    let callback: ((index: number) => void) | undefined;
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((options, cb) => {
        callback = cb;
        expect(options).toEqual(expect.objectContaining({
          title: '업무 메뉴',
          options: ['열기', '삭제', '잠김 — 권한 없음', '취소'],
          cancelButtonIndex: 3,
          destructiveButtonIndex: [1],
          disabledButtonIndices: [2],
        }));
      });

    showAppContextMenu([
      { key: 'open', label: '열기', onSelect: selected },
      { key: 'delete', label: '삭제', destructive: true, onSelect: jest.fn() },
      { key: 'locked', label: '잠김', disabled: true, disabledReason: '권한 없음', onSelect: disabled },
    ], '업무 메뉴');
    callback?.(0);
    callback?.(2);
    callback?.(3);

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
  });

  test('non-iOS disabled action explains why without invoking it', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const selected = jest.fn();
    let buttons: any[] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, next) => {
      if (next) buttons = next;
    });

    showAppContextMenu([
      { key: 'locked', label: '잠김', disabled: true, disabledReason: '권한 없음', onSelect: selected },
    ]);
    buttons[0].onPress();

    expect(selected).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenLastCalledWith('권한 없음');
  });
});
