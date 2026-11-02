import { fireEvent, render } from '@testing-library/react-native';
import { ReportTimelineRow } from '../ReportTimelineRow';
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
    foundation: { typography: { meta: { fontSize: 13 } } },
    colors: { text: 'black', textMuted: 'gray' },
  }),
}));

const line = (overrides: Partial<ReportTimelineLine> = {}): ReportTimelineLine => ({
  line_key: 'card-1', status: 'review', title: '검수 제목', detail: '한 줄 상세',
  card_id: 'card-1', card_number: 881, ...overrides,
});

describe('ReportTimelineRow', () => {
  beforeEach(() => mockOpenLink.mockClear());

  it('연결된 카드 행 전체를 링크로 만들고 카드 id를 전달한다', () => {
    const onOpenCard = jest.fn();
    const view = render(<ReportTimelineRow line={line()} onOpenCard={onOpenCard} />);

    fireEvent.press(view.getByRole('link'));

    expect(onOpenCard).toHaveBeenCalledWith('card-1');
    expect(view.getByText('검수 대기')).toBeTruthy();
    expect(view.getByText('#881')).toBeTruthy();
    expect(view.getByText('한 줄 상세')).toBeTruthy();
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
