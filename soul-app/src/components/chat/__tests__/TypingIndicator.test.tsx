import { render, renderHook } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { TypingIndicator } from '../TypingIndicator';
import { useTokens } from '../../../theme';

describe('TypingIndicator', () => {
  it('renders the exact 20px working orb beside the shared Korean label', () => {
    const screen = render(<TypingIndicator />);

    expect(screen.getByText('생각 중입니다…')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('thinking-orb').props.style)).toMatchObject({
      width: 20,
      height: 20,
    });
    expect(screen.getAllByTestId(/^thinking-orb-dot-/)).toHaveLength(39);
    expect(StyleSheet.flatten(screen.getByTestId('typing-indicator-bubble').props.style))
      .toMatchObject({ flexDirection: 'row', alignItems: 'center' });
  });

  it('말풍선 네 모서리는 같은 곡률을 쓴다', () => {
    const t = renderHook(() => useTokens()).result.current;
    const style = StyleSheet.flatten(
      render(<TypingIndicator />).getByTestId('typing-indicator-bubble').props.style,
    );
    expect(style.borderRadius).toBe(t.radius.floor);
    for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
      expect(style).not.toHaveProperty(corner);
    }
  });
});
