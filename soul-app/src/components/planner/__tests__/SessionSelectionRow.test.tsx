import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { SessionSelectionRow } from '../SessionSelectionRow';

const styles = { selectionRow: {}, fieldLabel: {}, selectionValue: {} } as any;

describe('SessionSelectionRow', () => {
  const valueLines = (props: { valueLines?: number }) => {
    const screen = render(<SessionSelectionRow testID="row" label="모델" value="값" onPress={jest.fn()} styles={styles} {...props} />);
    return screen.UNSAFE_getAllByType(Text).find(text => text.props.children === '값')!.props.numberOfLines;
  };

  test('값은 기본으로 한 줄이고 valueLines를 받으면 그 줄 수까지 보인다', () => {
    expect(valueLines({})).toBe(1);
    expect(valueLines({ valueLines: 2 })).toBe(2);
  });
});
