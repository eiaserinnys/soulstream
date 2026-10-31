import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { render, renderHook } from '@testing-library/react-native';
import { useTokens } from '../../../theme';
import { CompactTouchTarget } from '../../CompactTouchTarget';
import { AttachmentChips } from '../AttachmentChips';
import { makeStyles } from '../ChatBody.styles';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

test('editable attachments scroll in one row and leave undo accessible', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const styles = makeStyles(tokens);
  const screen = render(<AttachmentChips
    attachments={[0, 1, 2].map(index => ({ path: `/file-${index}`, name: `첨부 ${index}.png` }))}
    styles={styles} textSecondaryColor="#000" textMutedColor="#000" onRemove={() => {}}
    trailingAccessory={<Text>되돌리기</Text>}
  />);
  const frames = screen.UNSAFE_getAllByType(View).filter(view => (
    StyleSheet.flatten(view.props.style)?.position === 'relative'
  ));
  expect(screen.getByTestId('attachment-chips-scroll').props.horizontal).toBe(true);
  expect(screen.getByText('되돌리기')).toBeTruthy();
  expect(frames).toHaveLength(3);
  for (const frame of frames) expect(StyleSheet.flatten(frame.props.style)).toMatchObject({ maxWidth: 180, flexShrink: 0 });
});

test('attachment-only callers retain the existing frame and row styles', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const styles = makeStyles(tokens);
  const screen = render(<AttachmentChips
    attachments={[{ path: '/file', name: '첨부.png' }]}
    styles={styles} textSecondaryColor="#000" textMutedColor="#000" onRemove={() => {}}
  />);
  const frame = screen.UNSAFE_getByType(CompactTouchTarget).parent!;
  expect(StyleSheet.flatten(frame.props.style)).toEqual(styles.attachmentTouchFrame);
  expect(screen.getByTestId('attachment-chips-scroll').props.horizontal).toBe(true);
});

test.each(['default', 'manuscript'] as const)('%s read-only chips fit the chip height and full available width without a remove control', presentation => {
  const tokens = renderHook(() => useTokens()).result.current;
  const styles = makeStyles(tokens);
  const screen = render(<AttachmentChips
    attachments={[{ path: '/file', name: '보고서.txt' }]}
    styles={styles} textSecondaryColor="#000" textMutedColor="#000" onRemove={() => {}} readOnly presentation={presentation}
  />);

  expect(screen.getByText('보고서.txt')).toBeTruthy();
  expect(screen.queryByLabelText('보고서.txt 첨부 제거')).toBeNull();
  expect(screen.queryByTestId('chat-attachment-remove-0')).toBeNull();
  const frame = screen.UNSAFE_getAllByType(View)[1];
  expect(StyleSheet.flatten(frame.props.style)).toMatchObject({
    height: tokens.controlHeight.chip, maxWidth: '100%',
  });
  expect(StyleSheet.flatten(frame.props.style).minHeight ?? 0).toBeLessThanOrEqual(tokens.controlHeight.chip);
});
