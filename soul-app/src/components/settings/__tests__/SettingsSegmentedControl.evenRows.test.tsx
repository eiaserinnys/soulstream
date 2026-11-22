jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, type RenderAPI } from '@testing-library/react-native';
import { SettingsSegmentedControl, evenRowColumns } from '../SettingsSegmentedControl';

const options = [
  { value: '7', label: '지난 7일' }, { value: '30', label: '지난 30일' },
  { value: 'all', label: '전체' }, { value: 'custom', label: '기간 지정' },
] as const;
type Value = typeof options[number]['value'];

// The measuring labels are aria-hidden, so queries must opt into hidden elements.
const hidden = { includeHiddenElements: true };
const layout = (screen: RenderAPI, testID: string, width: number) => act(() => {
  fireEvent(screen.getByTestId(testID, hidden), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } } });
});
const basis = (screen: RenderAPI, value: Value) =>
  StyleSheet.flatten(screen.getByTestId(`settings-segment-even-${value}`).props.style).flexBasis;
const measure = (screen: RenderAPI, trackWidth: number, labelWidth: number) => {
  layout(screen, 'settings-segment-even-track', trackWidth);
  for (const option of options) layout(screen, `settings-segment-even-${option.value}-measure`, labelWidth);
};
const sample = (onChange = jest.fn()) =>
  render(<SettingsSegmentedControl<Value> evenRows id="even" value="7" options={options} onChange={onChange} />);

test('column choice: all in one row when the widest chip fits, otherwise half per row', () => {
  expect(evenRowColumns(4, 400, [60, 70, 30, 70], 10)).toBe(4);
  expect(evenRowColumns(4, 320, [60, 70, 30, 70], 10)).toBe(4);
  expect(evenRowColumns(4, 319, [60, 70, 30, 70], 10)).toBe(2);
  expect(evenRowColumns(4, 222, [60, 70, 30, 70], 10)).toBe(2);
  expect(evenRowColumns(4, 400, [60, undefined, 30, 70], 10)).toBe(2);
  expect(evenRowColumns(4, 0, [60, 70, 30, 70], 10)).toBe(2);
  expect(evenRowColumns(3, 400, [60, 70, 30], 10)).toBe(3);
  expect(evenRowColumns(3, 100, [60, 70, 30], 10)).toBe(2);
});

test('even rows start as two equal columns and wrap whole chips', () => {
  const screen = sample();
  expect(StyleSheet.flatten(screen.getByTestId('settings-segment-even-track').props.style)).toMatchObject({ flexWrap: 'wrap' });
  for (const option of options) {
    expect(StyleSheet.flatten(screen.getByTestId(`settings-segment-even-${option.value}`).props.style))
      .toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: '50%' });
    expect(StyleSheet.flatten(screen.getByTestId(`settings-segment-even-${option.value}-visual`).props.style)).toMatchObject({ width: '100%' });
    expect(screen.getByTestId(`settings-segment-even-${option.value}-label`).props.numberOfLines).toBe(1);
  }
});

test('measured labels choose one row of four on a wide track and two rows of two on a lane', () => {
  const screen = sample();
  measure(screen, 1000, 70);
  expect(options.map(option => basis(screen, option.value))).toEqual(['25%', '25%', '25%', '25%']);
  layout(screen, 'settings-segment-even-track', 226);
  expect(options.map(option => basis(screen, option.value))).toEqual(['50%', '50%', '50%', '50%']);
});

test('the hidden measuring labels use the selected weight and stay out of the accessibility tree', () => {
  const screen = sample();
  expect(screen.queryByTestId('settings-segment-even-30-measure')).toBeNull();
  const measureLabel = screen.getByTestId('settings-segment-even-30-measure', hidden);
  expect(StyleSheet.flatten(measureLabel.props.style).fontWeight).toBe('700');
  expect(measureLabel.props.numberOfLines).toBe(1);
  expect(screen.queryAllByLabelText('지난 30일')).toHaveLength(1);
  const host = screen.getByTestId('settings-segment-even-measure', hidden);
  expect(host.props['aria-hidden']).toBe(true);
  expect(host.props.pointerEvents).toBe('none');
  expect(StyleSheet.flatten(host.props.style)).toMatchObject({ position: 'absolute', height: 0, overflow: 'hidden' });
});

test('even rows keep the hit target height, selection and press behavior', () => {
  const onChange = jest.fn();
  const screen = sample(onChange);
  const custom = screen.getByTestId('settings-segment-even-custom');
  expect(StyleSheet.flatten(custom.props.style).minHeight).toBeGreaterThan(0);
  expect(screen.getByTestId('settings-segment-even-7').props.accessibilityState).toMatchObject({ selected: true });
  fireEvent.press(custom);
  expect(onChange).toHaveBeenCalledWith('custom');
});
