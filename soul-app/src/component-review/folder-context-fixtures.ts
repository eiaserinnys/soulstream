import type { ApiClient } from '../api/client';
import type { PageReadResult, PageSessionDefaults } from '../api/pageEndpoints';
import type { PlannerBlock } from '../api/plannerTypes';

// Public folder-context sample: the project page owns guidance, one reference and the
// execution defaults; the child page owns two guidance blocks and two references.
const PROJECT_PAGE = 'public-page';
const CHILD_PAGE = 'public-child-page';

const block = (pageId: string, id: string, blockType: string, text: string, properties: Record<string, unknown>): PlannerBlock => ({
  id, pageId, parentId: null, positionKey: id, blockType, text, properties, collapsed: false,
});

export const folderContextBlocks: Record<string, PlannerBlock[]> = {
  [PROJECT_PAGE]: [
    block(PROJECT_PAGE, 'public-guidance', 'guidance', '결정은 실제 근거와 함께 기록하고, 구현 뒤 다크와 라이트 화면을 모두 검증한다. 화면을 바꾸면 검수 창 견본도 함께 고친다.', { enabled: true, scope: 'project' }),
    block(PROJECT_PAGE, 'public-atom-root', 'atom_ref', '', { instance: 'atom', nodeId: 'public-atom-soulstream', nodeTitle: 'soulstream', depth: 5, titlesOnly: false }),
    block(PROJECT_PAGE, 'public-defaults', 'session_defaults', '', { scope: 'session', nodeId: 'public-node', agentId: 'public-agent', modelPreset: 'public-model' }),
  ],
  [CHILD_PAGE]: [
    block(CHILD_PAGE, 'public-child-guidance-1', 'guidance', '화면 검수는 아이폰과 아이패드 폭에서 함께 본다.', { enabled: true, scope: 'folder' }),
    block(CHILD_PAGE, 'public-child-guidance-2', 'guidance', '시안과 다른 배치는 먼저 묻는다.', { enabled: true, scope: 'project' }),
    block(CHILD_PAGE, 'public-atom-frontend', 'atom_ref', '', { instance: 'atom', nodeId: 'public-atom-frontend', nodeTitle: '프론트엔드 아키텍처', depth: 2, titlesOnly: true, limit: 20, mode: 'index' }),
    block(CHILD_PAGE, 'public-atom-ui', 'atom_ref', '', { instance: 'atom', nodeId: 'public-atom-ui', nodeTitle: 'UI 디자인 기준', depth: 1, titlesOnly: false }),
  ],
};

const atomChildren = ['시스템 아키텍처', '세션', 'API 레퍼런스', '프론트엔드 아키텍처', '개발 가이드', '실수 사례']
  .map((title, index) => ({ id: `public-atom-child-${index + 1}`, title }));

const manyAtomChildren = Array.from({ length: 24 }, (_, index) => ({ id: `public-atom-mistake-${index + 1}`, title: `공개 예시 사례 ${index + 1}` }));

/** Adds folder context reads to a public review api without touching its other methods. */
export function withFolderContext<T extends Pick<ApiClient, 'getPage'>>(api: T): T & Pick<ApiClient,
  'getPageSessionDefaults' | 'listAtomRootNodes' | 'listAtomNodeChildren'> {
  const getPage = async (pageId: string): Promise<PageReadResult> => {
    const result = await api.getPage(pageId);
    const blocks = folderContextBlocks[pageId];
    return blocks ? { ...result, blocks: [...result.blocks.filter((item) => item.blockType === 'paragraph' || item.blockType === 'heading'), ...blocks] } : result;
  };
  const getPageSessionDefaults = async (pageId: string): Promise<PageSessionDefaults | null> => {
    const own = folderContextBlocks[pageId]?.find((item) => item.blockType === 'session_defaults');
    const source = own ?? (pageId === CHILD_PAGE ? folderContextBlocks[PROJECT_PAGE]!.find((item) => item.blockType === 'session_defaults') : undefined);
    return source ? {
      agentId: source.properties.agentId as string,
      nodeId: source.properties.nodeId as string,
      modelPreset: (source.properties.modelPreset as string | undefined) ?? null,
      sourcePageId: source.pageId,
      sourceBlockId: source.id,
    } : null;
  };
  return {
    ...api,
    getPage,
    getPageSessionDefaults,
    listAtomRootNodes: async () => ({ nodes: [{ id: 'public-atom-soulstream', title: 'soulstream' }] }),
    listAtomNodeChildren: async (nodeId: string) => ({ children: nodeId === 'public-atom-soulstream' ? atomChildren
      : nodeId === 'public-atom-child-6' ? manyAtomChildren : [] }),
  };
}

/** The same api whose folder context reads all fail, for the failure states of the sheets. */
export function withFailingFolderContext<T extends Pick<ApiClient, 'getPage'>>(api: T): ReturnType<typeof withFolderContext<T>> {
  const fail = async (): Promise<never> => { throw new Error('공개 예시: 맥락을 불러오지 못했습니다.'); };
  return { ...withFolderContext(api), getPage: fail, getPageSessionDefaults: fail, listAtomRootNodes: fail, listAtomNodeChildren: fail };
}
