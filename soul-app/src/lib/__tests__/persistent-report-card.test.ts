import type { PersistentReportEntry } from '../../../../packages/wire-schema/src/persistent_report';
import { persistentReportStatusCard } from '../persistent-report-card';

const entry: PersistentReportEntry = {
  key: 'card_example', kind: 'see', title: '카드', card_numbers: [1503],
  context: '', action: '', options: [], state: 'open', answer: '', updated_at: '',
  card_id: 'card-id',
};

it('preserves an awaiting verification card', () => {
  expect(persistentReportStatusCard({ ...entry, card_status: 'awaiting_verification' }))
    .toMatchObject({ id: 'card-id', status: 'awaiting_verification' });
});

it('rejects an unknown card status', () => {
  expect(persistentReportStatusCard({ ...entry, card_status: 'unknown' })).toBeNull();
});
