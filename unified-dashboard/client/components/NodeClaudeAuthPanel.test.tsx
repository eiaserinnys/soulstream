/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NodeClaudeAuthPanel } from './NodeClaudeAuthPanel';

vi.mock('../hooks/useClaudeAuthFlow', () => ({ useClaudeAuthFlow: () => ({ loadingStatus: false, tokenStatus: { has_token: false } }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('omits legacy Gemini entries while keeping Antigravity usage in the node settings', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const request = vi.fn(async () => Response.json({ generatedAt: '', providers: {
    gemini: { status: 'not_configured', quotas: [] },
    antigravity: { status: 'auto', planType: null, quotas: [] },
  } })) as unknown as typeof fetch;
  try {
    act(() => root.render(<NodeClaudeAuthPanel nodeId="legacy" request={request} />));
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '사용량')!.click());
    expect(host.textContent).toContain('Antigravity');
    expect(host.textContent).not.toContain('Gemini');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
