import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { TABLET_CHAT_TYPOGRAPHY, DESIGN_SPACING } from '../../../theme';
import { LIGHT_COLORS } from '../../../theme/colors';
import { CollapsibleCaption } from '../CollapsibleCaption';
import { LabeledDivider } from '../LabeledDivider';

describe('CollapsibleCaption', () => {
  test('기본 접힘, 제목 접근성, 펼침 상태와 처음 상태의 mount 한정 적용', () => {
    const screen = render(
      <CollapsibleCaption title="Jev 후보 3">
        <Text>요약 내용</Text>
      </CollapsibleCaption>,
    );
    const button = screen.getByRole('button', { name: 'Jev 후보 3' });
    expect(button.props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByText('요약 내용')).toBeNull();

    fireEvent.press(button);
    expect(screen.getByRole('button', { name: 'Jev 후보 3' }).props.accessibilityState)
      .toEqual({ expanded: true });
    expect(screen.getByText('요약 내용')).toBeTruthy();

    screen.rerender(
      <CollapsibleCaption title="Jev 후보 3" initiallyCollapsed>
        <Text>요약 내용</Text>
      </CollapsibleCaption>,
    );
    expect(screen.getByRole('button', { name: 'Jev 후보 3' }).props.accessibilityState)
      .toEqual({ expanded: true });
  });

  test('처음부터 펼침과 제목 말줄임을 지원한다', () => {
    const title = '아주 긴 제목은 화면 너비를 넘어도 한 줄로 끝에서 잘립니다';
    const screen = render(
      <CollapsibleCaption title={title} initiallyCollapsed={false}>
        <Text>내용</Text>
      </CollapsibleCaption>,
    );
    const titleText = screen.getByText(title);
    expect(titleText.props.numberOfLines).toBe(1);
    expect(titleText.props.ellipsizeMode).toBe('tail');
    expect(screen.getByText('내용')).toBeTruthy();
    expect(screen.getByRole('button', { name: title }).props.accessibilityState)
      .toEqual({ expanded: true });
    const wrapper = screen.UNSAFE_getAllByType(View).find((view) =>
      view.props.accessibilityRole === 'button');
    expect(wrapper).toBeTruthy();
  });
});

describe('LabeledDivider', () => {
  test('기존 메타 타이포그래피로 가운데 라벨과 접근성에서 빠진 양쪽 hairline을 렌더한다', () => {
    const screen = render(<LabeledDivider label="새 세대" />);
    const label = screen.getByText('새 세대');
    expect(StyleSheet.flatten(label.props.style)).toMatchObject({
      color: LIGHT_COLORS.textPlaceholder,
      fontSize: TABLET_CHAT_TYPOGRAPHY.meta,
      lineHeight: TABLET_CHAT_TYPOGRAPHY.meta * 1.3,
    });
    const decorativeLines = screen.UNSAFE_getAllByType(View)
      .filter((view) => view.props.accessibilityElementsHidden === true);
    expect(decorativeLines).toHaveLength(2);
    for (const line of decorativeLines) {
      expect(StyleSheet.flatten(line.props.style)).toMatchObject({
        height: StyleSheet.hairlineWidth,
        backgroundColor: LIGHT_COLORS.border,
        flex: 1,
        minWidth: 0,
      });
      expect(line.props.importantForAccessibility).toBe('no');
    }
    const row = screen.UNSAFE_getAllByType(View)[0];
    expect(StyleSheet.flatten(row.props.style).gap).toBe(DESIGN_SPACING.md);
  });
});
