jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: ({ markdown, testID }: { markdown: string; testID?: string }) => (
      React.createElement(Text, { testID }, markdown)
    ),
  };
});

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { TabletMarkdownEditor } from '../TabletMarkdownEditor';

test('iPad 설명은 markdown 읽기와 plain multiline 편집을 명시적으로 전환한다', () => {
  const screen = render(
    <TabletMarkdownEditor
      testID="description"
      value="**서버 설명**"
      draft="**서버 설명**"
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancel={jest.fn()}
      emptyText="설명 없음"
    />,
  );

  expect(screen.getByTestId('description-markdown')).toHaveTextContent('**서버 설명**');
  expect(screen.queryByTestId('description-input')).toBeNull();
  fireEvent.press(screen.getByTestId('description-edit-action'));
  const input = screen.getByTestId('description-input');
  expect(input.props.multiline).toBe(true);
  expect(screen.queryByTestId('description-markdown')).toBeNull();
  expect(screen.queryByTestId('description-save-action')).toBeNull();
});

test('저장은 dirty일 때만 편집 영역 바로 아래 오른쪽에 나타나고 성공 후 숨는다', async () => {
  const save = jest.fn(async () => undefined);
  const change = jest.fn();
  const screen = render(
    <TabletMarkdownEditor
      testID="description"
      value="서버"
      draft="수정"
      onChangeDraft={change}
      onSave={save}
      onCancel={jest.fn()}
      emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));

  const actionsStyle = StyleSheet.flatten(screen.getByTestId('description-actions').props.style);
  expect(actionsStyle.justifyContent).toBe('flex-end');
  expect(screen.getByTestId('description-save-action')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('description-save-action'));
  });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByTestId('description-input')).toBeNull());
});

test('취소는 draft 복구를 호출하고 읽기 markdown으로 돌아간다', () => {
  const cancel = jest.fn();
  const screen = render(
    <TabletMarkdownEditor
      testID="description"
      value="서버"
      draft="수정"
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancel={cancel}
      emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));
  fireEvent.press(screen.getByTestId('description-cancel-action'));

  expect(cancel).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('description-markdown')).toBeTruthy();
});

test('저장 실패는 편집 draft와 재시도 액션을 보존한다', async () => {
  const save = jest.fn(async () => { throw new Error('network'); });
  const screen = render(
    <TabletMarkdownEditor
      testID="description"
      value="서버"
      draft="작성 중"
      onChangeDraft={jest.fn()}
      onSave={save}
      onCancel={jest.fn()}
      emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));

  await act(async () => {
    fireEvent.press(screen.getByTestId('description-save-action'));
  });

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(screen.getByDisplayValue('작성 중')).toBeTruthy();
  expect(screen.getByTestId('description-save-action')).toBeTruthy();
});

test('저장 중 추가 입력은 제출 snapshot만 clean 처리하고 편집기를 dirty로 유지한다', async () => {
  let release!: () => void;
  const save = jest.fn((_submittedDraft: string) => new Promise<void>((resolve) => {
    release = resolve;
  }));
  function Harness() {
    const [value, setValue] = React.useState('서버');
    const [draft, setDraft] = React.useState('첫 제출');
    return (
      <TabletMarkdownEditor
        testID="description"
        value={value}
        draft={draft}
        onChangeDraft={setDraft}
        onSave={async (submittedDraft) => {
          await save(submittedDraft);
          setValue(submittedDraft);
        }}
        onCancel={() => setDraft(value)}
        emptyText="설명 없음"
      />
    );
  }
  const screen = render(<Harness />);
  fireEvent.press(screen.getByTestId('description-edit-action'));
  fireEvent.press(screen.getByTestId('description-save-action'));
  fireEvent.changeText(screen.getByTestId('description-input'), '저장 중 추가 입력');

  await act(async () => { release(); });

  expect(save).toHaveBeenCalledWith('첫 제출');
  expect(screen.getByDisplayValue('저장 중 추가 입력')).toBeTruthy();
  expect(screen.getByTestId('description-save-action')).toBeTruthy();
  expect(screen.queryByTestId('description-markdown')).toBeNull();
});
