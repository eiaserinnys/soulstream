import {
  composeText,
  evaluate,
  initialState,
  reduce,
  renderParts,
  renderText,
  validateChatUiDocument,
} from '@soulstream/chat-ui';

test('soul-app loads and executes the public chat-ui package contract', () => {
  const validated = validateChatUiDocument({
    schema_version: 1,
    units: { item: { dims: { count: 1 }, symbol: '개', scale: 1 } },
    fields: {
      count: { type: 'number', initial: 2, min: 0, max: 10, step: 1, unit: 'item' },
    },
    computed: {
      doubled: {
        op: 'add',
        args: [
          { op: 'ref', ref: { field: 'count' } },
          { op: 'ref', ref: { field: 'count' } },
        ],
      },
    },
    body: [
      { id: 'summary', kind: 'text', parts: ['수량 ', { value: { field: 'count' }, format: 'plain' }] },
      {
        id: 'compose',
        kind: 'form',
        items: [{ field: 'count', label: '수량' }],
        submitLabel: '적용',
        action: { type: 'compose' },
      },
    ],
  });

  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error('유효한 공개 계약 문서를 거부했습니다.');

  const state = initialState(validated.document);
  expect(evaluate(validated.document, state).computed.doubled).toEqual({
    type: 'number',
    base: 4,
    dims: { count: 1 },
  });
  expect(renderParts(validated.document, state, [{ value: { computed: 'doubled' }, format: 'plain' }]))
    .toBe('4');
  expect(renderText(validated.document, state)).toContain('수량 2');
  expect(composeText(validated.document, state, 'compose')).toContain('2');

  const updated = reduce(validated.document, state, { type: 'set', field: 'count', value: 3 });
  expect(evaluate(validated.document, updated).computed.doubled).toEqual({
    type: 'number',
    base: 6,
    dims: { count: 1 },
  });
  expect(renderText(validated.document, updated)).toContain('수량 3');
});
