// 카드 #1871: 태블릿의 보고 창 겹침. 열 때마다 새 창으로 서고, 뒤로 가기는 창 안에서 열린 것부터 닫는다.
const mockBound: { starts: (string | null)[]; mounts: number; back: jest.Mock } = { starts: [], mounts: 0, back: jest.fn(() => false) };
jest.mock('../PasReportWindowBound', () => {
  const ReactModule = require('react');
  return { PasReportWindowBound: ReactModule.forwardRef((props: { startCardId: string | null; onOpenCard(id: string): void }, ref: unknown) => {
    ReactModule.useEffect(() => { mockBound.mounts += 1; }, []);
    mockBound.starts.push(props.startCardId);
    ReactModule.useImperativeHandle(ref, () => ({ back: () => mockBound.back() }));
    const { Text } = require('react-native');
    return ReactModule.createElement(Text, { testID: 'bound', onPress: () => props.onOpenCard('card-9') }, String(props.startCardId));
  }) };
});
jest.mock('../../planner/FolderWorkspaceReadOverlay', () => ({
  CardPanelOverlayFrame: ({ visible, children, onClose }: { visible: boolean; children: unknown; onClose(): void }) =>
    require('react').createElement(require('react-native').View, { testID: 'frame', accessibilityState: { expanded: visible }, onTouchEnd: onClose }, children),
}));

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PasReportWindowOverlay, type PasReportWindowOverlayHandle } from '../PasReportWindowOverlay';

function overlay(open: { startCardId: string | null } | null, extra: { onOpenCard?: jest.Mock; ref?: React.Ref<PasReportWindowOverlayHandle> } = {}) {
  return <PasReportWindowOverlay ref={extra.ref} open={open} bottomSafeAreaInset={0} onClose={jest.fn()} onOpenCard={extra.onOpenCard ?? jest.fn()} />;
}

beforeEach(() => { mockBound.starts = []; mockBound.mounts = 0; mockBound.back = jest.fn(() => false); });

test('닫혀 있으면 아무것도 읽거나 그리지 않고, 열면 시작 안건으로 선다', () => {
  const view = render(overlay(null));
  expect(view.queryByTestId('frame')).toBeNull();
  expect(mockBound.mounts).toBe(0);
  view.rerender(overlay({ startCardId: 'card-3' }));
  expect(view.getByTestId('bound').props.children).toBe('card-3');
  expect(mockBound.mounts).toBe(1);
});

test('다시 열면 새 창으로 서서 새 시작 안건에서 시작한다', () => {
  const view = render(overlay({ startCardId: 'card-3' }));
  view.rerender(overlay(null));
  view.rerender(overlay({ startCardId: 'card-4' }));
  expect(view.getByTestId('bound').props.children).toBe('card-4');
  expect(mockBound.mounts).toBe(2);
});

test('카드 패널 열기는 PAS 화면이 카드를 여는 길(onOpenCard)로 넘긴다', () => {
  const onOpenCard = jest.fn();
  const view = render(overlay({ startCardId: 'card-3' }, { onOpenCard }));
  fireEvent.press(view.getByTestId('bound'));
  expect(onOpenCard).toHaveBeenCalledWith('card-9');
});

test('뒤로 가기는 창 안에서 열린 것을 닫았으면 true, 닫을 것이 없거나 닫혀 있으면 false', () => {
  const ref = React.createRef<PasReportWindowOverlayHandle>();
  const view = render(overlay(null, { ref }));
  expect(ref.current!.back()).toBe(false);
  view.rerender(overlay({ startCardId: 'card-3' }, { ref }));
  mockBound.back = jest.fn(() => true);
  act(() => { expect(ref.current!.back()).toBe(true); });
  mockBound.back = jest.fn(() => false);
  expect(ref.current!.back()).toBe(false);
});
