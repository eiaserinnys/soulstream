import type { Folder } from '../../api/types';
import type { PlannerBlock } from '../../api/plannerTypes';
import {
  folderContextSources,
  mergeFolderContextPages,
  parseFolderPageContext,
} from '../folder-context';

describe('folder context inheritance (web project-context-inheritance와 같은 표본)', () => {
  it('walks only the selected parent chain and silently skips legacy NULL bindings', () => {
    const sources = folderContextSources('dashboard', [
      folder('unrelated', '무관', null, 'page-unrelated'),
      folder('soulstream', '소울스트림', null, 'page-soulstream'),
      folder('legacy', '레거시', 'soulstream', null),
      folder('dashboard', '대시보드', 'legacy', 'page-dashboard'),
    ]);

    expect(sources).toEqual({
      status: 'resolved',
      sources: [
        { folderId: 'soulstream', folderName: '소울스트림', pageId: 'page-soulstream' },
        { folderId: 'dashboard', folderName: '대시보드', pageId: 'page-dashboard' },
      ],
    });
    expect(folderContextSources('missing', [])).toEqual({ status: 'unavailable' });
  });

  it('uses server semantic keys and keeps the selected values in root-to-leaf order', () => {
    const result = mergeFolderContextPages([
      {
        source: { folderId: 'soulstream', folderName: '소울스트림', pageId: 'page-soulstream' },
        details: {
          guidance: [guidance('root-shared', 'root shared', 'shared'), guidance('root-only', 'root only', 'root')],
          atomReferences: [atom('root-same', 'node-same', 5), atom('root-only-atom', 'node-root', 3)],
          sessionDefaults: [defaults('root-defaults', 'project', 'root-agent', 'root-node')],
        },
      },
      {
        source: { folderId: 'dashboard', folderName: '대시보드', pageId: 'page-dashboard' },
        details: {
          guidance: [
            guidance('leaf-shared', 'leaf shared', 'shared'),
            guidance('leaf-shared-later', 'later duplicate', 'shared'),
          ],
          atomReferences: [atom('leaf-same', 'node-same', 2)],
          sessionDefaults: [defaults('leaf-defaults', 'project', 'leaf-agent', 'leaf-node')],
        },
      },
    ]);

    expect(result.guidance.map((item) => [item.text, item.source.folderName])).toEqual([
      ['root only', '소울스트림'],
      ['leaf shared', '대시보드'],
    ]);
    expect(result.atomReferences.map((item) => [item.nodeId, item.depth, item.source.folderName])).toEqual([
      ['node-root', 3, '소울스트림'],
      ['node-same', 2, '대시보드'],
    ]);
    expect(result.sessionDefaults).toEqual([
      expect.objectContaining({ agentId: 'leaf-agent', nodeId: 'leaf-node', source: expect.objectContaining({ folderName: '대시보드' }) }),
    ]);
  });

  it('parses page blocks the same way as the web page details', () => {
    expect(parseFolderPageContext([
      block('g-on', 'guidance', '  지침  ', { enabled: true, scope: 'project' }),
      block('g-off', 'guidance', '꺼진 지침', { enabled: false }),
      block('a', 'atom_ref', '', { instance: 'atom', nodeId: 'n1', nodeTitle: '노드', depth: 2, titlesOnly: true, limit: 7, mode: 'index' }),
      block('a-other', 'atom_ref', '', { instance: 'other', nodeId: 'n2' }),
      block('d', 'session_defaults', '', { scope: 'session', agentId: 'roselin', nodeId: 'eiaserinnys' }),
      block('d-empty', 'session_defaults', '', { scope: 'session' }),
    ])).toEqual({
      guidance: [{ blockId: 'g-on', text: '지침', scope: 'project' }],
      atomReferences: [{
        blockId: 'a', instance: 'atom', nodeId: 'n1', nodeTitle: '노드', depth: 2, titlesOnly: true, limit: 7, mode: 'index',
      }],
      sessionDefaults: [{ blockId: 'd', scope: 'session', agentId: 'roselin', nodeId: 'eiaserinnys', modelPreset: null }],
    });
  });
});

function folder(id: string, name: string, parentFolderId: string | null, projectPageId: string | null): Folder {
  return { status: 'open', version: 1, archived: false, id, name, parentFolderId, projectPageId, sortOrder: 0 };
}

function guidance(blockId: string, text: string, scope: string) {
  return { blockId, text, scope };
}

function atom(blockId: string, nodeId: string, depth: number) {
  return { blockId, instance: 'atom' as const, nodeId, nodeTitle: nodeId, depth, titlesOnly: false };
}

function defaults(blockId: string, scope: string, agentId: string, nodeId: string) {
  return { blockId, scope, agentId, nodeId, modelPreset: null };
}

function block(id: string, blockType: string, text: string, properties: Record<string, unknown>): PlannerBlock {
  return { id, pageId: 'page', parentId: null, positionKey: id, blockType, text, properties, collapsed: false };
}
