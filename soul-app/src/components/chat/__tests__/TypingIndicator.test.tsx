import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { TypingIndicator } from '../TypingIndicator';

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
});
