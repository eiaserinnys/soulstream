/**
 * 노드 색상 CSS 변수 — globals.css의 :root / .dark에서 테마별 값이 결정된다.
 * 컴포넌트는 이 상수를 통해 CSS 변수를 참조하므로 테마 전환 시 자동 적용된다.
 */
export const NODE_COLORS = {
  user:         'var(--node-user)',
  response:     'var(--node-response)',
  thinking:     'var(--node-thinking)',
  plan:         'var(--node-plan)',
  tool:         'var(--node-tool)',
  skill:        'var(--node-skill)',
  intervention: 'var(--node-intervention)',
  error:        'var(--node-error)',
  system:       'var(--node-system)',
  inputRequest: 'var(--node-input-request)',
} as const;
