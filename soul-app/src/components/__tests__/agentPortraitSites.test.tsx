jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../menus/AppContextMenu', () => ({ showAppContextMenu: jest.fn() }));
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { EnrichedMarkdownText: (props: any) => React.createElement(Text, props, props.markdown) };
});
import { act, render, waitFor } from '@testing-library/react-native';
import { Image } from 'expo-image';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentPortraitDictionary } from '../../../../packages/soul-ui/src/lib/agent-portrait';
import { cardFixture } from '../../test-support/cards';
import { PostItCard } from '../planner/PostItCard';
import { ExecutionSelectionSheet } from '../planner/ExecutionSelectionSheet';
import { AssistantMessage } from '../events/AssistantMessage';
import { PersistentSessionPortrait } from '../../navigation/PersistentSessionContext';
import { useAgentPortraitStore } from '../../store/agentPortraitStore';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';

const SERVER = 'https://soul.test';
const JWT = 'portrait-test-jwt';
const AUTH = { Authorization: `Bearer ${JWT}` };
const VERSIONED = `${SERVER}/api/agent-portraits/roselin?v=sha-new`;

function readyDictionary() {
  act(() => useAgentPortraitStore.setState({
    dictionary: buildAgentPortraitDictionary({ portraits: [{
      agent_id: 'roselin', sha256: 'sha-new', mime: 'image/png', byte_size: 1, updated_at: 't', url: '/api/agent-portraits/roselin?v=sha-new',
    }] }),
    ready: true,
  }));
}

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: SERVER });
  useAuthStore.setState({ jwt: JWT });
  useSessionStore.setState({ sessions: {} });
  useAgentPortraitStore.getState().deactivate();
});

const sources = (screen: ReturnType<typeof render>) =>
  screen.UNSAFE_queryAllByType(Image).map(({ props }) => props.source);

describe('손으로 만들던 초상 주소', () => {
  const pas = { session_id: 'pas-1', node_id: 'node-1', agent_id: 'roselin', agent_name: '로젤린' } as any;

  test.each([
    ['PostItCard', () => <PostItCard api={null} card={cardFixture({ nodeId: 'node-1', assigneeAgentId: 'roselin' })} onOpen={() => {}} />],
    ['PersistentSessionPortrait', () => <PersistentSessionPortrait session={pas} size={32} />],
  ])('%s는 준비 전에는 노드 id 없는 에이전트 주소를, 준비 뒤에는 사전의 버전 주소를 낸다', (_name, element) => {
    const screen = render(element());
    expect(sources(screen)).toEqual([{ uri: `${SERVER}/api/agents/roselin/portrait`, headers: AUTH }]);
    expect(screen.UNSAFE_getAllByType(Image)[0].props.cachePolicy).toBe('memory');

    readyDictionary();
    screen.rerender(element());
    expect(sources(screen)).toEqual([{ uri: VERSIONED, headers: AUTH }]);
    expect(screen.UNSAFE_getAllByType(Image)[0].props.cachePolicy).toBe('memory-disk');
    expect(JSON.stringify(sources(screen))).not.toContain('/api/nodes/');
  });

  test('사전이 준비됐는데 에이전트가 없으면 그림 대신 이니셜을 보인다', () => {
    readyDictionary();
    const screen = render(<PersistentSessionPortrait session={{ ...pas, agent_id: 'ghost', agent_name: '유령' }} size={32} />);
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
    expect(screen.getByText('유')).toBeTruthy();
  });

  test('세션 행에 저장된 옛 노드 주소는 준비 뒤 버전 주소로 바뀐다', () => {
    useSessionStore.setState({ sessions: { 'pas-1': { agentSessionId: 'pas-1', nodeId: 'node-1', agentId: 'roselin', agentPortraitUrl: '/api/nodes/node-1/agents/roselin/portrait' } as any } });
    const screen = render(<PersistentSessionPortrait session={pas} size={32} />);
    expect(sources(screen)).toEqual([{ uri: `${SERVER}/api/nodes/node-1/agents/roselin/portrait`, headers: AUTH }]);
    readyDictionary();
    screen.rerender(<PersistentSessionPortrait session={pas} size={32} />);
    expect(sources(screen)).toEqual([{ uri: VERSIONED, headers: AUTH }]);
  });
});

describe('노드 이벤트의 옛 avatar_url', () => {
  const event = {
    id: 'a1', type: 'assistant_message',
    data: { text: '안녕', caller_info: { source: 'agent', agent_id: 'roselin', agent_name: '로젤린', avatar_url: '/api/nodes/node-2/agents/roselin/portrait' } },
  } as any;

  test('준비 전에는 그대로, 준비 뒤에는 사전의 버전 주소로 바뀐다', () => {
    const screen = render(<AssistantMessage event={event} />);
    expect(sources(screen)).toEqual([{ uri: `${SERVER}/api/nodes/node-2/agents/roselin/portrait`, headers: AUTH }]);
    readyDictionary();
    screen.rerender(<AssistantMessage event={event} />);
    expect(sources(screen)).toEqual([{ uri: VERSIONED, headers: AUTH }]);
  });

  test('바깥 주소(슬랙 CDN)는 건드리지 않고 토큰도 보내지 않는다', () => {
    readyDictionary();
    const external = { ...event, data: { ...event.data, caller_info: { source: 'slack', display_name: '김', avatar_url: 'https://avatars.slack-edge.com/a.png' } } };
    const screen = render(<AssistantMessage event={external} />);
    expect(sources(screen)).toEqual([{ uri: 'https://avatars.slack-edge.com/a.png' }]);
    expect(screen.UNSAFE_getAllByType(Image)[0].props.cachePolicy).toBe('memory');
  });
});

describe('ExecutionSelectionSheet', () => {
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol', portraitUrl: '/api/agent-portraits/roselin?v=sha-new' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }] }),
  };
  const value = { folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' } as any;

  test('중앙 초상 주소에 서버 출처와 같은 출처 Bearer 머리를 붙인다', async () => {
    const screen = render(<ExecutionSelectionSheet api={api as any} value={value} onSave={jest.fn()} onClose={jest.fn()} />);
    await waitFor(() => expect(sources(screen)).toHaveLength(1));
    expect(sources(screen)).toEqual([{ uri: VERSIONED, headers: AUTH }]);
    expect(screen.UNSAFE_getAllByType(Image)[0].props.cachePolicy).toBe('memory-disk');
  });
});

test('앱 소스에 노드 id로 초상 주소를 만드는 코드가 남지 않는다', () => {
  const root = path.resolve(__dirname, '../..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'test-support' && entry.name !== 'component-review') walk(full);
      } else if (/\.tsx?$/.test(entry.name) && /\/api\/nodes\/\$\{[^`]*portrait/.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
