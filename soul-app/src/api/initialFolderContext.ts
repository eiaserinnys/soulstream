export interface InitialFolderAtomReference {
  instance: 'atom' | 'atom-nl';
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
}

export interface InitialFolderSessionDefaults {
  agentId: string;
  nodeId: string;
  modelPreset?: string;
}

export interface InitialFolderContext {
  guidance: string;
  atomReferences: InitialFolderAtomReference[];
  sessionDefaults?: InitialFolderSessionDefaults;
}

interface InitialFolderContextWire {
  guidance?: string;
  atom_references?: Array<{
    instance: 'atom' | 'atom-nl';
    node_id: string;
    node_title: string;
    depth: number;
    titles_only: boolean;
  }>;
  session_defaults?: {
    agent_id: string;
    node_id: string;
    model_preset?: string;
  };
}

export function emptyInitialFolderContext(): InitialFolderContext {
  return { guidance: '', atomReferences: [] };
}

export function serializeInitialFolderContext(
  context: InitialFolderContext | undefined,
): InitialFolderContextWire | undefined {
  if (!context) return undefined;
  const guidance = context.guidance.trim();
  const atomReferences = context.atomReferences.map((reference) => {
    const nodeId = reference.nodeId.trim();
    const nodeTitle = reference.nodeTitle.trim();
    if (!nodeId || !nodeTitle) throw new Error('Atom 컨텍스트의 노드 정보가 없습니다.');
    if (!Number.isInteger(reference.depth) || reference.depth < 1 || reference.depth > 5) {
      throw new Error('Atom 컨텍스트 depth는 1에서 5 사이여야 합니다.');
    }
    return {
      instance: reference.instance,
      node_id: nodeId,
      node_title: nodeTitle,
      depth: reference.depth,
      titles_only: reference.titlesOnly,
    };
  });
  const defaults = context.sessionDefaults;
  const agentId = defaults?.agentId.trim() ?? '';
  const nodeId = defaults?.nodeId.trim() ?? '';
  const modelPreset = defaults?.modelPreset?.trim() ?? '';
  if (defaults && (!agentId || !nodeId)) {
    throw new Error('기본 담당은 에이전트와 노드를 모두 선택해야 합니다.');
  }
  if (defaults?.modelPreset !== undefined && !modelPreset) {
    throw new Error('모델 preset은 비어 있지 않아야 합니다.');
  }
  const wire: InitialFolderContextWire = {
    ...(guidance ? { guidance } : {}),
    ...(atomReferences.length > 0 ? { atom_references: atomReferences } : {}),
    ...(defaults ? {
      session_defaults: {
        agent_id: agentId,
        node_id: nodeId,
        ...(modelPreset ? { model_preset: modelPreset } : {}),
      },
    } : {}),
  };
  return Object.keys(wire).length > 0 ? wire : undefined;
}
