import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import type { SessionReviewPolicyPayload } from '../../../api/settingsEndpoints';
import { SessionReviewPolicySettingsSection } from '../SessionReviewPolicySettingsSection';

const initialPayload: SessionReviewPolicyPayload = {
  policy: {
    key: 'session_review_policy',
    sourceAllowlist: ['slack', 'external-llm'],
    version: 4,
    updatedAt: '2026-09-14T00:00:00.000Z',
    updatedBy: 'admin@example.com',
  },
  conditionalRules: [{
    source: 'browser',
    label: '브라우저',
    description: '브라우저 요청은 user_id, email, display_name 중 하나로 신원이 확인될 때 항상 검수합니다.',
    condition: 'identified_user',
  }],
  sourceCatalog: [
    {
      source: 'slack',
      label: 'Slack',
      description: 'Slack 직접 요청·세션',
      automatic: false,
    },
    {
      source: 'external-llm',
      label: '외부 LLM',
      description: '별도 인증된 외부 LLM ingress의 직접 요청',
      automatic: false,
    },
    {
      source: 'llm',
      label: '일반 공개 MCP',
      description: '범용 공개 MCP 호출이며 자동화가 섞일 수 있음',
      automatic: true,
    },
  ],
};

const api = {
  getSessionReviewPolicy: jest.fn(),
  updateSessionReviewPolicy: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.getSessionReviewPolicy.mockResolvedValue(initialPayload);
  api.updateSessionReviewPolicy.mockReset();
});

test('loads and edits the global review source allowlist', async () => {
  api.updateSessionReviewPolicy.mockResolvedValue({
    ...initialPayload,
    policy: {
      ...initialPayload.policy,
      sourceAllowlist: ['slack', 'clipper'],
      version: 5,
    },
  });
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  expect(await screen.findByTestId(
    'review-policy-source-external-llm',
    undefined,
    { timeout: 10_000 },
  )).toBeTruthy();
  expect(screen.getByText('외부 LLM')).toBeTruthy();
  expect(screen.getByText(/로그인한 브라우저 요청은 이 목록과 관계없이 항상 검수/)).toBeTruthy();
  expect(screen.getByText(/다음 신규 세션부터 모든 노드에 적용/)).toBeTruthy();
  expect(screen.queryByText(/user_id|email|display_name|ingress|MCP|·/)).toBeNull();
  fireEvent(screen.getByTestId('review-policy-switch-external-llm'), 'valueChange', false);
  fireEvent.changeText(screen.getByTestId('review-policy-source-input'), 'clipper');
  fireEvent.press(screen.getByTestId('review-policy-add'));
  fireEvent.press(screen.getByTestId('review-policy-save'));

  await waitFor(() => expect(api.updateSessionReviewPolicy).toHaveBeenCalledWith({
    sourceAllowlist: ['slack', 'clipper'],
    expectedVersion: 4,
  }));
  expect(await screen.findByText(/정책 v5을 저장했습니다/)).toBeTruthy();
}, 15_000);

test('labels an added automatic source and warns before it is saved', async () => {
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  await screen.findByTestId('review-policy-source-slack');
  fireEvent.changeText(screen.getByTestId('review-policy-source-input'), 'LLM');
  fireEvent.press(screen.getByTestId('review-policy-add'));

  expect(screen.getByText('공용 자동 요청')).toBeTruthy();
  expect(screen.getByText(/자동 요청 출처일 수 있으므로 포함 전 확인/)).toBeTruthy();
  expect(screen.getByText(/공용 자동 요청 출처\(llm\)는 기본 검수 대상에서 제외/)).toBeTruthy();
  expect(screen.queryByText(/user_id|email|display_name|ingress|MCP|·/)).toBeNull();
});

test('uses a neutral presentation for a custom source matching an inherited key', async () => {
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  await screen.findByTestId('review-policy-source-slack');
  fireEvent.changeText(screen.getByTestId('review-policy-source-input'), 'constructor');
  fireEvent.press(screen.getByTestId('review-policy-add'));

  expect(screen.getByTestId('review-policy-source-constructor')).toBeTruthy();
  expect(screen.getByText('이 출처에서 새로 만든 세션')).toBeTruthy();
  expect(screen.getByLabelText('constructor 제거')).toBeTruthy();
});

test.each([
  [422, '출처 ID가 올바르지 않습니다.'],
  [503, '검수 정책 저장소를 사용할 수 없습니다.'],
] as const)('shows the structured %i policy error', async (status, message) => {
  api.updateSessionReviewPolicy.mockRejectedValue(
    new ApiHttpError(
      'policy error',
      status,
      JSON.stringify({ detail: { error: { code: 'POLICY_ERROR', message } } }),
    ),
  );
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  await screen.findByTestId('review-policy-source-external-llm');
  fireEvent(screen.getByTestId('review-policy-switch-external-llm'), 'valueChange', false);
  fireEvent.press(screen.getByTestId('review-policy-save'));

  expect(await screen.findByText(message)).toBeTruthy();
});

test('keeps browser conditional and refetches after a CAS conflict', async () => {
  const latest = {
    ...initialPayload,
    policy: {
      ...initialPayload.policy,
      sourceAllowlist: ['external-llm', 'clipper'],
      version: 5,
    },
  };
  const saved = {
    ...latest,
    policy: {
      ...latest.policy,
      sourceAllowlist: ['clipper'],
      version: 6,
    },
  };
  api.updateSessionReviewPolicy
    .mockRejectedValueOnce(new ApiHttpError('conflict', 409, '{}'))
    .mockResolvedValueOnce(saved);
  api.getSessionReviewPolicy
    .mockResolvedValueOnce(initialPayload)
    .mockResolvedValueOnce(latest);
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  await screen.findByTestId('review-policy-source-slack');
  fireEvent.changeText(screen.getByTestId('review-policy-source-input'), 'browser');
  fireEvent.press(screen.getByTestId('review-policy-add'));
  expect(await screen.findByText(/로그인한 브라우저 요청은 항상 검수/)).toBeTruthy();

  fireEvent(screen.getByTestId('review-policy-switch-external-llm'), 'valueChange', false);
  fireEvent.press(screen.getByTestId('review-policy-save'));
  await waitFor(() => expect(api.getSessionReviewPolicy).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/최신 버전에 내 변경만 다시 적용했습니다/)).toBeTruthy();
  expect(screen.getByText(/현재 v5/)).toBeTruthy();
  expect(screen.getByTestId('review-policy-switch-external-llm').props.value).toBe(false);
  expect(screen.getByTestId('review-policy-switch-slack').props.value).toBe(false);
  expect(screen.getByTestId('review-policy-source-clipper')).toBeTruthy();

  fireEvent.press(screen.getByTestId('review-policy-save'));
  await waitFor(() => expect(api.updateSessionReviewPolicy).toHaveBeenLastCalledWith({
    sourceAllowlist: ['clipper'],
    expectedVersion: 5,
  }));
  expect(await screen.findByText(/정책 v6을 저장했습니다/)).toBeTruthy();
});

test('locks source controls while a save is in flight', async () => {
  let resolveUpdate!: (value: SessionReviewPolicyPayload) => void;
  api.updateSessionReviewPolicy.mockImplementation(() =>
    new Promise<SessionReviewPolicyPayload>((resolve) => {
      resolveUpdate = resolve;
    }));
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  await screen.findByTestId('review-policy-source-external-llm');
  fireEvent(screen.getByTestId('review-policy-switch-external-llm'), 'valueChange', false);
  fireEvent.changeText(screen.getByTestId('review-policy-source-input'), 'clipper');
  fireEvent.press(screen.getByTestId('review-policy-save'));

  await waitFor(() => {
    expect(screen.getByTestId('review-policy-source-input').props.editable).toBe(false);
    expect(screen.getByTestId('review-policy-switch-slack').props.disabled)
      .toBe(true);
    expect(screen.getByTestId('review-policy-add').props.accessibilityState)
      .toEqual({ disabled: true });
  });

  resolveUpdate({
    ...initialPayload,
    policy: {
      ...initialPayload.policy,
      sourceAllowlist: ['slack'],
      version: 5,
    },
  });
  expect(await screen.findByText(/정책 v5을 저장했습니다/)).toBeTruthy();
});

test('locks source controls while a reload is in flight', async () => {
  let resolveReload!: (value: SessionReviewPolicyPayload) => void;
  const latestPayload: SessionReviewPolicyPayload = {
    ...initialPayload,
    policy: {
      ...initialPayload.policy,
      sourceAllowlist: ['clipper'],
      version: 5,
    },
  };
  api.getSessionReviewPolicy
    .mockResolvedValueOnce(initialPayload)
    .mockImplementationOnce(() =>
      new Promise<SessionReviewPolicyPayload>((resolve) => {
        resolveReload = resolve;
      }));
  const screen = render(
    <SessionReviewPolicySettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  await screen.findByTestId('review-policy-source-external-llm');
  fireEvent.changeText(screen.getByTestId('review-policy-source-input'), 'pending-source');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, actions) => { actions?.find(action => action.text === '버리기')?.onPress?.(); });
  fireEvent.press(screen.getByTestId('review-policy-reload'));
  alert.mockRestore();

  await waitFor(() => {
    expect(screen.getByTestId('review-policy-source-input').props.editable).toBe(false);
    expect(screen.getByTestId('review-policy-switch-slack').props.disabled)
      .toBe(true);
    expect(screen.getByTestId('review-policy-add').props.accessibilityState)
      .toEqual({ disabled: true });
    expect(screen.getByTestId('review-policy-reload').props.accessibilityState)
      .toEqual({ disabled: true });
    expect(screen.getByTestId('review-policy-save').props.accessibilityState)
      .toEqual({ disabled: true });
  });

  resolveReload(latestPayload);
  expect(await screen.findByTestId('review-policy-source-clipper')).toBeTruthy();
  expect(screen.getByTestId('review-policy-switch-slack').props.value).toBe(false);
  expect(screen.getByTestId('review-policy-switch-external-llm').props.value).toBe(false);
  expect(screen.getByText(/현재 v5/)).toBeTruthy();
});

test('server catalogue supplies independent switches without changing authority', async () => {
  const screen = render(<SessionReviewPolicySettingsSection flattened serverUrl="https://soul.test"/>);
  const switchControl = await screen.findByTestId('review-policy-switch-llm');
  expect(switchControl.props.value).toBe(false);
  fireEvent(switchControl, 'valueChange', true);
  expect(screen.getByTestId('review-policy-switch-llm').props.value).toBe(true);
  expect(api.updateSessionReviewPolicy).not.toHaveBeenCalled();
});
