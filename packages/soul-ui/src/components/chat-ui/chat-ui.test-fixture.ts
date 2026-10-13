import { validateChatUiDocument, type ChatUiDocumentV1 } from '@soulstream/chat-ui';

export const fixture: ChatUiDocumentV1 = {
  schema_version: 1, title: '검수 문서',
  units: { count: { dims: { count: 1 }, symbol: '명', scale: 1 } },
  fields: {
    seats: { type: 'number', initial: 8, min: 1, max: 50, step: 1, unit: 'count' },
    memo: { type: 'text', initial: '', maxLength: 20 },
    annual: { type: 'boolean', initial: false },
    order: { type: 'choice', initial: 'app', options: [{ id: 'app', label: '앱 먼저' }, { id: 'web', label: '웹 먼저' }] },
    checks: { type: 'selection', initial: ['focus'], options: [{ id: 'focus', label: '입력창 포커스' }, { id: 'reset', label: '전체 초기화' }] },
  },
  sources: {
    link: { type: 'external_link', label: '원문', url: 'https://example.com/source' },
    note: { type: 'assumption', label: '요금 가정', note: '실제 요금이 아니야.' },
  },
  assumptions: ['세금 제외'],
  body: [
    { id: 'heading', kind: 'heading', level: 3, parts: ['조건'] },
    { id: 'text', kind: 'text', emphasis: 'strong', parts: [{ value: { field: 'seats' } }] },
    { id: 'caption', kind: 'caption', parts: ['예시'] },
    { id: 'hint', kind: 'text', visibleWhen: { op: 'ref', ref: { field: 'annual' } }, parts: ['할인 적용'] },
    { id: 'group', kind: 'group', layout: 'stack', children: [
      { id: 'slider', kind: 'slider', field: 'seats', label: '인원수' },
      { id: 'checkbox', kind: 'checkbox', field: 'annual', label: '연간 결제' },
      { id: 'citation', kind: 'citation', source: 'link' },
    ] },
    { id: 'form', kind: 'form', items: [
      { field: 'seats', label: '인원수 입력' }, { field: 'memo', label: '메모' },
      { field: 'annual', label: '결제 확인' }, { field: 'order', label: '진행 순서' }, { field: 'checks', label: '확인할 것' },
    ], submitLabel: '이 값으로 요청', action: { type: 'compose' } },
    { id: 'entity', kind: 'entity', label: '자료 상세', details: ['상세 내용'], source: 'link' },
    { id: 'set', kind: 'button', label: '12명으로', action: { type: 'set', field: 'seats', value: 12 } },
    { id: 'reset', kind: 'button', label: '초기화', action: { type: 'reset' } },
    { id: 'copy', kind: 'button', label: '복사', action: { type: 'copy' } },
    { id: 'compose', kind: 'button', label: '질문', action: { type: 'compose', parts: ['질문: ', { value: { field: 'seats' } }] } },
    { id: 'open', kind: 'button', label: '출처 열기', action: { type: 'open_source', source: 'link' } },
    { id: 'assumption', kind: 'button', label: '가정 보기', action: { type: 'open_source', source: 'note' } },
  ],
};

const result = validateChatUiDocument(fixture);
if (!result.ok) throw new Error(JSON.stringify(result.errors));
export const documentFixture = result.document;
export const envelope = { schema_version: 1, revision: 1, ui_id: 'ui_' + 'a'.repeat(32), hash: 'a'.repeat(64), document: fixture };
