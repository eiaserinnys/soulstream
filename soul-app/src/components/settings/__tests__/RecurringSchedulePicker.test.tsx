import React, { useState } from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { RecurringSchedulePicker } from '../RecurringSchedulePicker';
import { defaultRecurringSchedule } from '../recurringSchedule';

function Harness() {
  const [schedule, setSchedule] = useState(defaultRecurringSchedule());
  return <RecurringSchedulePicker value={schedule} onChange={setSchedule} />;
}

test('offers structured schedules and reveals raw cron only for advanced mode', () => {
  const screen = render(<Harness />);
  expect(screen.getByTestId('recurring-schedule-mode-daily')).toBeTruthy();
  expect(screen.getByTestId('recurring-schedule-mode-weekdays')).toBeTruthy();
  expect(screen.getByTestId('recurring-schedule-mode-weekly')).toBeTruthy();
  expect(screen.getByTestId('recurring-schedule-mode-monthly')).toBeTruthy();
  expect(screen.queryByLabelText('고급 cron')).toBeNull();

  fireEvent.press(screen.getByTestId('recurring-schedule-add-time'));
  expect(screen.getByTestId('recurring-schedule-time-1')).toBeTruthy();
  fireEvent.press(screen.getByTestId('recurring-schedule-mode-weekly'));
  expect(screen.getByTestId('recurring-schedule-weekday-1')).toBeTruthy();
  fireEvent.press(screen.getByTestId('recurring-schedule-mode-monthly'));
  expect(screen.getByTestId('recurring-schedule-month-day-1')).toBeTruthy();
  fireEvent.press(screen.getByTestId('recurring-schedule-mode-advanced'));
  expect(screen.getByLabelText('고급 cron')).toBeTruthy();
});

test('keeps a time input mounted across sequential text changes', () => {
  const screen = render(<Harness />);
  const initialInput = screen.getByTestId('recurring-schedule-time-0');

  fireEvent.changeText(initialInput, '0');
  const afterFirstCharacter = screen.getByTestId('recurring-schedule-time-0');
  expect(afterFirstCharacter).toBe(initialInput);
  expect(afterFirstCharacter.props.value).toBe('0');

  fireEvent.changeText(afterFirstCharacter, '09');
  const afterSecondCharacter = screen.getByTestId('recurring-schedule-time-0');
  expect(afterSecondCharacter).toBe(initialInput);
  expect(afterSecondCharacter.props.value).toBe('09');
});
