import { getI18n } from "react-i18next";
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../lib/flatten-tree';
import { externalSenderDisplay } from './externalSender';
import { pickMessageAvatarUrl } from './userAvatarSelectors';
import { computeInterventionDisplay } from './InterventionMessage.helpers';
import { UserMessage } from './UserMessage';
import { InterventionMessage } from './InterventionMessage';

const cases = [
  [{ source: 'external', transport: 'access_link', display_name: '연동' }, '연동', 'link', '접속 링크'],
  [{ source: 'external', transport: 'webhook', display_name: '알림' }, '알림', 'webhook', '웹훅'],
  [{ source: 'external', display_name: '이름' }, '이름', 'link', '접속 링크'],
  [{ source: 'external', display_name: '' }, '', 'link', '접속 링크'],
  [{ source: 'external', display_name: '가'.repeat(80) }, '가'.repeat(80), 'link', '접속 링크'],
] as const;

describe('external sender', () => {
  it.each(cases)('uses the shared display rule %#', (caller, name, icon, title) => {
    expect(externalSenderDisplay(caller, getI18n().t)).toEqual({ prefix: '외부 연동', name, icon, title });
    expect(pickMessageAvatarUrl({ ...caller, avatar_url: '/director.png' }, '/director.png')).toBeNull();
  });
  it.each(['browser', 'agent'] as const)('leaves %s callers unchanged', source => {
    expect(externalSenderDisplay({ source }, getI18n().t)).toBeNull();
  });
  it.each(['browser', 'agent'] as const)('does not add a manuscript caption for %s', source => {
    const msg = { id: '2', treeNodeId: '2', treeNodeType: 'user_message', role: 'user', content: '본문', callerInfo: { source } } as ChatMessage;
    expect(renderToStaticMarkup(createElement(UserMessage, { msg, presentation: 'manuscript' }))).not.toContain('외부 연동');
  });
  it.each([
    ['access_link', '접속 링크'],
    ['webhook', '웹훅'],
  ] as const)('exposes the manuscript %s icon to screen readers', (transport, title) => {
    const msg = { id: '3', treeNodeId: '3', treeNodeType: 'user_message', role: 'user', content: '본문', callerInfo: { source: 'external', transport, display_name: '외부 작업자' } } as ChatMessage;
    const html = renderToStaticMarkup(createElement(UserMessage, { msg, presentation: 'manuscript' }));
    expect(html).toContain(`role="img" aria-label="외부 연동 ${title}" title="${title}"`);
  });
  it.each(['user', 'intervention'] as const)('renders %s in both presentations without issuer', role => {
    const msg = { id: '1', treeNodeId: '1', treeNodeType: role, role, content: '본문', callerInfo: { source: 'external', transport: 'webhook', display_name: '알림', issued_by: 'owner@example.com' } } as ChatMessage;
    if (role === 'intervention') expect(computeInterventionDisplay(getI18n().t, msg, '/director.png').portraitUrl).toBeNull();
    for (const presentation of ['default', 'manuscript'] as const) {
      const Component = role === 'user' ? UserMessage : InterventionMessage;
      const html = renderToStaticMarkup(createElement(Component, { msg, presentation }));
      expect(html).toContain('외부 연동');
      expect(html).toContain('알림');
      expect(html).toContain('웹훅');
      expect(html).not.toContain('owner@example.com');
      expect(html).not.toContain('/director.png');
    }
  });
});
