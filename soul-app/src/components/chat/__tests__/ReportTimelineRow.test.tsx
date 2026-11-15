import { fireEvent, render } from '@testing-library/react-native';
import { ReportTimelineRow } from '../ReportTimelineRow';
import { useCardStore } from '../../../store/cardStore';
import { cardFixture } from '../../../test-support/cards';
import type { ReportTimelineLine } from '../../../../../packages/wire-schema/src/persistent_report';

const mockOpenLink = jest.fn();

jest.mock('../../../hooks/useOpenContentLink', () => ({
  useOpenContentLink: () => mockOpenLink,
}));
jest.mock('../../planner/CardRow', () => ({
  CardStatusChip: ({ label }: { label: string }) => {
    const ReactModule = jest.requireActual('react');
    const Native = jest.requireActual('react-native');
    return ReactModule.createElement(Native.Text, null, label);
  },
}));
jest.mock('../../../theme', () => ({
  useTokens: () => ({
    spacing: { xs: 4, lg: 16 },
    uiSpacing: { xxs: 2, xs: 4 },
    hitTarget: { min: 44 },
    chatFontSize: { meta: 14 },
    lineHeightRatio: 1.3,
    foundation: { typography: { meta: { fontSize: 13, lineHeight: 18 } } },
    colors: { textPrimary: 'black', textMuted: 'gray' },
  }),
}));

const line = (overrides: Partial<ReportTimelineLine> = {}): ReportTimelineLine => ({
  line_key: 'card-1', status: 'review', title: '검수 제목', detail: '한 줄 상세',
  card_id: 'card-1', card_number: 881, ...overrides,
});

describe('ReportTimelineRow', () => {
  beforeEach(() => {
    mockOpenLink.mockClear();
    useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
  });

  it('연결된 카드 행 전체를 링크로 만들고 카드 id를 전달한다', () => {
    const onOpenCard = jest.fn();
    const view = render(<ReportTimelineRow line={line()} onOpenCard={onOpenCard} />);

    fireEvent.press(view.getByRole('link'));

    expect(onOpenCard).toHaveBeenCalledWith('card-1');
    expect(view.getByText('검수 대기')).toBeTruthy();
    expect(view.getByText('#881')).toBeTruthy();
    expect(view.getByText('한 줄 상세')).toBeTruthy();
  });

  it('스토어의 라이브 카드 상태·제목·상황으로 기록된 줄을 덮어쓴다', () => {
    useCardStore.setState({ rows: { 'card-1': cardFixture({
      id: 'card-1', status: 'running', title: '실행 중 카드', version: 2,
      now: { text: '작업 중', turn: 'agent', ask: null, updatedAt: '2026-10-01T00:00:00Z', sessionId: 'session' },
    }) } });
    const view = render(<ReportTimelineRow line={line()} />);

    expect(view.getByText('실행 중')).toBeTruthy();
    expect(view.getByText('실행 중 카드')).toBeTruthy();
    expect(view.getByText('작업 중')).toBeTruthy();
    expect(view.queryByText('한 줄 상세')).toBeNull();
  });

  it('끝난 카드는 상황 글을 비우고, 질문으로 막힌 카드는 질문으로 표시한다', () => {
    useCardStore.setState({ rows: { 'card-1': cardFixture({ id: 'card-1', status: 'done', title: '끝난 카드', version: 2 }) } });
    const done = render(<ReportTimelineRow line={line()} />);
    expect(done.getByText('완료')).toBeTruthy();
    expect(done.getByText('끝난 카드')).toBeTruthy();
    expect(done.queryByText('한 줄 상세')).toBeNull();
    done.unmount();

    useCardStore.setState({ rows: { 'card-1': cardFixture({ id: 'card-1', status: 'blocked', blockedKind: 'question', version: 3 }) } });
    const blocked = render(<ReportTimelineRow line={line({ status: 'running' })} />);
    expect(blocked.getByText('질문')).toBeTruthy();
    blocked.unmount();
  });

  it('질문 줄과 보고 줄은 기록된 상태를 그대로 그린다', () => {
    useCardStore.setState({ rows: { 'card-1': cardFixture({ id: 'card-1', status: 'running', version: 2 }) } });
    const questionView = render(<ReportTimelineRow line={line({ status: 'question', question_id: 'q-1', title: '질문 카드' })} />);
    expect(questionView.getByText('질문')).toBeTruthy();
    expect(questionView.getByText('질문 카드')).toBeTruthy();
    questionView.unmount();

    const reportView = render(<ReportTimelineRow line={line({ status: 'report', title: '보고 줄' })} />);
    expect(reportView.getByText('보고')).toBeTruthy();
    expect(reportView.getByText('보고 줄')).toBeTruthy();
  });

  it('카드가 없으면 링크가 아니며 status label만으로 중립 상태를 표시한다', () => {
    const view = render(<ReportTimelineRow line={line({
      line_key: 'unlinked', status: 'report', title: '연결 없는 보고', detail: '', card_id: null, card_number: null,
    })} />);

    expect(view.queryByRole('link')).toBeNull();
    expect(view.getByText('보고')).toBeTruthy();
    expect(mockOpenLink).not.toHaveBeenCalled();
  });
});
