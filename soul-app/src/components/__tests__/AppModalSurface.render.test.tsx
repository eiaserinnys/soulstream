import React from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { render } from '@testing-library/react-native';

import {
  AppModalSurface,
  resolveAppModalPresentation,
} from '../AppModalSurface';
import {
  bindSessionDiagnosticsSink,
  type SessionDiagnosticsSink,
} from '../../lib/session-diagnostics-api';

test('compact modal is one content-fit bottom glass surface over a transparent host', () => {
  const screen = render(
    <AppModalSurface
      visible
      variant="compact"
      modalId="modal_settings"
      onRequestClose={jest.fn()}
      surfaceTestID="compact-surface"
      safeAreaTestID="compact-safe-area"
    >
      <View testID="compact-content" />
    </AppModalSurface>,
  );

  expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({
    transparent: true,
    presentationStyle: 'overFullScreen',
    animationType: 'slide',
  });
  expect(StyleSheet.flatten(screen.getByTestId('app-modal-viewport').props.style))
    .toMatchObject({ justifyContent: 'flex-end' });
  expect(StyleSheet.flatten(screen.getByTestId('compact-surface').props.style))
    .toMatchObject({ width: '100%', maxHeight: '60%', flexShrink: 1 });
  expect(screen.getByTestId('compact-safe-area')).toBeTruthy();
  expect(screen.getByTestId('compact-content')).toBeTruthy();
});

test('expanded modal keeps the requested native presentation in the same surface owner', () => {
  const screen = render(
    <AppModalSurface
      visible
      variant="expanded"
      modalId="modal_morning_review"
      presentationStyle="formSheet"
      animationType="fade"
      onRequestClose={jest.fn()}
      surfaceTestID="expanded-surface"
    >
      <View />
    </AppModalSurface>,
  );

  expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({
    transparent: false,
    presentationStyle: 'formSheet',
    animationType: 'fade',
  });
  expect(StyleSheet.flatten(screen.getByTestId('expanded-surface').props.style))
    .toMatchObject({
      flex: 1,
      backgroundColor: expect.any(String),
      borderRadius: 0,
    });
  expect(screen.UNSAFE_getByType(Modal).props.supportedOrientations)
    .toEqual(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']);
});

test('popover modal anchors a compact glass surface at the tablet top edge', () => {
  const screen = render(
    <AppModalSurface
      visible
      variant="popover"
      modalId="modal_search_filter"
      onRequestClose={jest.fn()}
      surfaceTestID="popover-surface"
      safeAreaTestID="popover-safe-area"
    >
      <View />
    </AppModalSurface>,
  );

  expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({
    transparent: true,
    presentationStyle: 'overFullScreen',
  });
  expect(StyleSheet.flatten(screen.getByTestId('app-modal-viewport').props.style))
    .toMatchObject({
      alignItems: 'flex-end',
      justifyContent: 'flex-start',
      paddingTop: 72,
    });
  expect(StyleSheet.flatten(screen.getByTestId('popover-surface').props.style))
    .toMatchObject({ width: 360, maxWidth: '92%', maxHeight: '78%' });
  expect(screen.getByTestId('popover-safe-area').props.edges).toEqual({
    top: 'off',
    right: 'off',
    bottom: 'off',
    left: 'off',
  });
});

test('modal visibility records the fixed call-site enum', () => {
  const recordModal = jest.fn();
  bindSessionDiagnosticsSink({
    recordRoute: jest.fn(),
    recordModal,
    recordSseConnection: jest.fn(),
    recordSseMessage: jest.fn(),
    recordStoreUpdate: jest.fn(),
    recordFeedRender: jest.fn(),
    beginOperation: jest.fn(),
    endOperation: jest.fn(),
  } as unknown as SessionDiagnosticsSink);

  try {
    render(
      <AppModalSurface
        visible
        variant="compact"
        modalId="modal_settings"
        onRequestClose={jest.fn()}
      >
        <View />
      </AppModalSurface>,
    );
    expect(recordModal).toHaveBeenCalledWith('modal_settings', 'compact', true);
  } finally {
    bindSessionDiagnosticsSink(null);
  }
});

test('modal host와 표면 종류는 레이어 책임에 따라 한 계약으로 결정한다', () => {
  expect(resolveAppModalPresentation('compact')).toEqual({
    transparent: true,
    presentationStyle: 'overFullScreen',
    surfaceRole: 'modal',
  });
  expect(resolveAppModalPresentation('expanded', 'pageSheet')).toEqual({
    transparent: false,
    presentationStyle: 'pageSheet',
    surfaceRole: 'nativeSheet',
  });
  expect(resolveAppModalPresentation('expanded', 'formSheet')).toEqual({
    transparent: false,
    presentationStyle: 'formSheet',
    surfaceRole: 'nativeSheet',
  });
  expect(resolveAppModalPresentation('popover')).toEqual({
    transparent: true,
    presentationStyle: 'overFullScreen',
    surfaceRole: 'modal',
  });
});
