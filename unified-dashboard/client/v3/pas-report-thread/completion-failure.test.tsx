/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardDetail } from '@seosoyoung/soul-ui/cards/card-types';
import type { PersistentReportEntry } from '../../../../packages/wire-schema/src/persistent_report';
import { usePersistentCardCompletion } from '../usePersistentCardCompletion';

// 보고 창은 모달이라 말풍선 알림이 가려진다. 완료와 되돌리기 실패 문구를 호출한 쪽이 받고, 되돌림 성공 여부를 알 수 있어야 한다.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cardId = 'card-for-window-completion';
const entry: PersistentReportEntry & { card_id: string; card_status: string } = {
  key: `card_${cardId}`, kind: 'see', title: '검수 장', card_numbers: [1871], card_id: cardId, card_status: 'review',
  context: '', action: '', options: [], state: 'open', answer: '', updated_at: 'review',
};
let host: HTMLDivElement;
let root: Root;
let completion: ReturnType<typeof usePersistentCardCompletion>;
const notify = vi.fn();
function Harness() { completion = usePersistentCardCompletion(notify); return null; }

beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks();
  const card = { id: cardId, status: 'review', version: 8 } as CardDetail['card'];
  useCardStore.setState({ loadCard: vi.fn().mockResolvedValue({ card } as CardDetail), mutate: vi.fn().mockResolvedValue({ card } as CardDetail) });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('routes a failed completion to the caller instead of the bubble notice', async () => {
  const onFailure = vi.fn();
  vi.mocked(useCardStore.getState().mutate).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { expect(await completion.complete(entry, undefined, 'on_hold', onFailure)).toBe(false); });
  expect(onFailure).toHaveBeenCalledWith('카드를 보류하지 못했어.');
  expect(notify).not.toHaveBeenCalled();
});

it('tells whether undo took effect and routes its failure to the caller', async () => {
  const onFailure = vi.fn();
  await act(async () => completion.complete(entry));
  vi.mocked(useCardStore.getState().loadCard).mockResolvedValue({ card: { id: cardId, status: 'done', version: 9 } } as CardDetail);
  vi.mocked(useCardStore.getState().mutate).mockRejectedValueOnce(new Error('offline'));
  let restored: boolean | undefined;
  await act(async () => { restored = await completion.undo(onFailure); });
  expect(restored).toBe(false);
  expect(onFailure).toHaveBeenCalledWith('되돌리지 못했어.');
  expect(notify).not.toHaveBeenCalled();
  expect(completion.recent?.cardId).toBe(cardId);
  await act(async () => { restored = await completion.undo(onFailure); });
  expect(restored).toBe(true);
  expect(completion.recent).toBeNull();
  await act(async () => { restored = await completion.undo(onFailure); });
  expect(restored).toBe(false);
});
