import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { render, renderHook } from '@testing-library/react-native';
import { useTokens } from '../../../theme';
import { CompactTouchTarget } from '../../CompactTouchTarget';
import { AttachmentChips } from '../AttachmentChips';
import { makeStyles } from '../ChatBody.styles';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

test('undo centers the wrapping row while the last chip shrinks without growing', () => {
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
  const root = screen.UNSAFE_getAllByType(View)[0];
  expect(StyleSheet.flatten(root.props.style)).toMatchObject({
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
  });
  for (const frame of frames.slice(0, -1)) {
    expect(frame.parent!.parent).toBe(root);
    expect(StyleSheet.flatten(frame.props.style).maxWidth).toBe('70%');
  }
  const last = frames[2];
  expect(last.parent!.parent!.parent!.parent).toBe(root);
  expect(StyleSheet.flatten(last.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
  expect(StyleSheet.flatten(last.props.style).flex).toBeUndefined();
  expect(StyleSheet.flatten(last.props.style).flexGrow).toBeUndefined();
  expect(StyleSheet.flatten(last.parent!.props.style)).toMatchObject({ flexGrow: 1, alignItems: 'center' });
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
  expect(StyleSheet.flatten(screen.UNSAFE_getAllByType(View)[0].props.style)).toEqual(styles.attachmentRow);
  expect(StyleSheet.flatten(screen.UNSAFE_getAllByType(View)[0].props.style).alignItems).toBeUndefined();
});
