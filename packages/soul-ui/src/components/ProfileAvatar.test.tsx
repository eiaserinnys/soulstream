/** @vitest-environment jsdom */
import { act } from 'react';import { createRoot } from 'react-dom/client';import { expect,it } from 'vitest';import { ProfileAvatar } from './ProfileAvatar';import { useAgentPortraitStore } from '../stores/agent-portrait-store';import { buildAgentPortraitDictionary } from '../lib/agent-portrait';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
it('keeps the rounded default and adds a circle without changing avatar size',()=>{const host=document.createElement('div');const root=createRoot(host);act(()=>root.render(<ProfileAvatar role="assistant" hasPortrait portraitUrl="/portrait" fallbackEmoji="🤖"/>));expect(host.querySelector('img')?.className).toBe('w-8 h-8 rounded-floor shrink-0 object-cover');act(()=>root.render(<ProfileAvatar role="assistant" hasPortrait portraitUrl="/portrait" fallbackEmoji="🤖" shape="circle"/>));expect(host.querySelector('img')?.className).toBe('w-8 h-8 rounded-full shrink-0 object-cover');act(()=>root.unmount());});

it('shows the image again after its address changes, even if the old address failed',()=>{
  const host=document.createElement('div');const root=createRoot(host);
  act(()=>root.render(<ProfileAvatar role="assistant" hasPortrait portraitUrl="/broken" fallbackEmoji="🤖"/>));
  act(()=>{host.querySelector('img')!.dispatchEvent(new Event('error'));});
  expect(host.querySelector('img')).toBeNull();expect(host.textContent).toBe('🤖');
  act(()=>root.render(<ProfileAvatar role="assistant" hasPortrait portraitUrl="/api/agent-portraits/x?v=new" fallbackEmoji="🤖"/>));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/agent-portraits/x?v=new');
});

it('turns old node addresses into the central version address once the list is loaded',()=>{
  const sha='b'.repeat(64);
  const host=document.createElement('div');const root=createRoot(host);
  act(()=>root.render(<ProfileAvatar role="assistant" hasPortrait portraitUrl="/api/nodes/silent-manari-ts/agents/blossom/portrait" fallbackEmoji="🤖"/>));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/nodes/silent-manari-ts/agents/blossom/portrait');
  act(()=>useAgentPortraitStore.setState({loaded:true,dictionary:buildAgentPortraitDictionary({portraits:[{agent_id:'blossom',sha256:sha,mime:'image/png',byte_size:1,updated_at:'x',url:`/api/agent-portraits/blossom?v=${sha}`}]})}));
  expect(host.querySelector('img')?.getAttribute('src')).toBe(`/api/agent-portraits/blossom?v=${sha}`);
  act(()=>root.render(<ProfileAvatar role="assistant" hasPortrait portraitUrl="/api/nodes/n/agents/nobody/portrait" fallbackEmoji="🤖"/>));
  expect(host.querySelector('img')).toBeNull();
  act(()=>useAgentPortraitStore.setState({loaded:false,dictionary:new Map()}));
});
