import type { ApiClient } from '../api/client';
import type { CardDto, CardStatus } from '../api/cardTypes';
import type { CatalogFolder, Session, SessionEvent } from '../api/types';
import type { PlannerFolder } from '../api/plannerTypes';

// Invented public data only. No IDs or assets from an actual account.
const time = '2026-10-01T00:00:00Z';
export const folders: CatalogFolder[] = [
  { id: 'public-project', name: '공개 예시 프로젝트', parentFolderId: null, sortOrder: 0,
    projectPageId: null, settings: {}, archived: false, status: 'open', version: 1 },
  { id: 'public-child', name: '길이가 긴 폴더 이름의 줄바꿈과 말줄임을 확인하는 공개 예시',
    parentFolderId: 'public-project', sortOrder: 1, projectPageId: null,
    settings: {}, archived: false, status: 'open', version: 1 },
];
export const sessions: Session[] = [
  { agentSessionId: 'public-running', displayName: '현재 실행 중인 공개 예시 세션',
    status: 'running', agentName: '예시 에이전트', backend: 'codex', modelLabel: '예시 모델',
    createdAt: time, updatedAt: time },
  { agentSessionId: 'public-review', displayName: '결과를 확인할 공개 예시 세션',
    status: 'completed', agentName: '예시 에이전트', reviewRequired: true,
    reviewState: 'needs_review', createdAt: time, updatedAt: time },
  { agentSessionId: 'public-idle', displayName: '대기 중인 공개 예시 세션',
    status: 'idle', agentName: '예시 에이전트', createdAt: time, updatedAt: time },
  { agentSessionId: 'public-error', displayName: '오류가 표시된 공개 예시 세션',
    status: 'error', agentName: '예시 에이전트', createdAt: time, updatedAt: time },
  { agentSessionId: 'public-attention', displayName: '사용자 응답이 필요한 공개 예시 세션',
    status: 'running', agentName: '예시 에이전트', createdAt: time, updatedAt: time,
    pendingAttentions: [{ id: 'public-question', sourceEventId: 1, sessionId: 'public-attention',
      kind: 'input_request', requestedAt: time, title: '공개 질문 예시', body: '확인해주세요.',
      requiresDetail: false }] },
];
export function makeCard(status: CardStatus): CardDto {
  return { id: 'public-' + status, folderId: folders[0].id,
    title: '현재 카드 행을 검수하는 공개 예시', request: '공개 fixture로 표시와 동작을 확인합니다.',
    brief: '', attachments: [], status, positionKey: 'a', queuePositionKey: null,
    blockedKind: status === 'blocked' ? 'question' : null, blockedDetail: null,
    assigneeKind: 'agent', assigneeAgentId: 'public-agent', assigneeSessionId: null,
    assigneeUserId: null, nodeId: null, modelPreset: '예시 모델',
    archived: false, version: 1, createdAt: time, updatedAt: time,completedAt:status==='done'?new Date().toISOString():null };
}
export const initialCards = (['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'] as const).map(makeCard);
export const starredFolders: PlannerFolder[] = folders.map((folder) => ({
  page: { id: folder.id, title: folder.name, dailyDate: null, version: 1,
    archived: false, metadata: {}, createdAt: time, updatedAt: time },
  blocks: [], folderId: folder.id, folderSummary: null, status: 'open', assignee: '',
  contextCount: 0, progress: null, projectPageId: null, sessions: [], sessionIds: [],
}));
export type AssignmentScenario = 'unassigned' | 'partial' | 'agent' | 'assigned' | 'live';
export type FixtureState = 'normal' | 'empty' | 'error' | 'loading';
export type FolderSessionPageScenario = 'many' | 'short';
export const fixtureOptions = [
  { value: 'normal', label: '기본' }, { value: 'empty', label: '빈 목록' },
  { value: 'error', label: '조회 실패' }, { value: 'loading', label: '로딩' },
] as const;

export function createReviewApi(state: FixtureState = 'normal', options: { assignment?:AssignmentScenario; pendingExecution?:boolean; home?: boolean; emptyReview?: boolean; failWrites?: boolean; completed?: 'none' | 'only'; manyCompleted?:boolean;
  folderSessionPages?: FolderSessionPageScenario;
  onFolderSessionPageRequest?(pageId: string, cursor: string | null, releaseResponse?: () => void): void;
  onCreateCard?(body: Parameters<ApiClient['createCard']>[0]): void } = {}) {
  const cards = new Map(initialCards.map((card) => [card.id, { ...card }]));
  const folderSessionPageSize = options.folderSessionPages === 'many' ? 20 : 2;
  const folderSessionCount = options.folderSessionPages === 'many' ? 60
    : options.folderSessionPages === 'short' ? 6 : 0;
  const folderSessions: Session[] = Array.from({ length: folderSessionCount }, (_, index) => {
    const id = `public-folder-${options.folderSessionPages}-${String(index + 1).padStart(2, '0')}`;
    return {
      agentSessionId: id,
      displayName: `공개 폴더 세션 ${String(index + 1).padStart(2, '0')}`,
      status: 'completed',
      createdAt: new Date(Date.parse(time) - index * 60_000).toISOString(),
      updatedAt: new Date(Date.parse(time) - index * 60_000).toISOString(),
      folderId: folders[0].id,
      nodeId: 'public-node',
      agentId: 'public-agent',
      agentName: '예시 에이전트',
      backend: 'codex',
    };
  });
  const reviewSessions = [...sessions, ...folderSessions];
  if(options.manyCompleted)for(let index=0;index<1000;index++)cards.set(`completed-${index}`,{...makeCard('done'),id:`completed-${index}`,title:index%10===0?'검색할 긴 완료 카드 제목입니다. 같은 폭과 본문을 유지합니다.':'완료 카드 '+index,completedAt:new Date(Date.now()-index*10*60*1000).toISOString()});
  if (options.home) for (let index = 1; index <= 4; index++) cards.set(`public-review-${index}`, { ...makeCard('review'), id: `public-review-${index}`, title: `검수할 공개 예시 ${index}`, latestActivity: { kind: 'report', body: '같은 제목과 본문으로 카드 크기와 읽기 흐름을 확인합니다.', format: 'markdown', createdAt: time } });
  if(options.assignment)for(const [id,card] of cards){
    const assigned=options.assignment==='assigned'||options.assignment==='live';
    cards.set(id,{...card,status:options.assignment==='live'?'running':card.status,
      assigneeKind:assigned?'session':options.assignment==='agent'?'agent':null,
      assigneeAgentId:options.assignment==='agent'?'public-agent':null,
      assigneeSessionId:assigned?'public-running':null,
      nodeId:assigned||options.assignment==='partial'?'public-node':null,modelPreset:assigned?'public-model':null});
  }
  if (options.emptyReview) for (const [id, card] of cards) if (card.status === 'review') cards.delete(id);
  if (options.completed) for (const [id, card] of cards) {
    if (options.completed === 'none' ? card.status === 'done' : card.status !== 'done') cards.delete(id);
  }
  if (options.folderSessionPages === 'short') cards.clear();
  const read = async <T,>(value: T): Promise<T> => {
    if (state === 'error') throw new Error('공개 예시: 목록을 불러오지 못했습니다.');
    if (state === 'loading') return new Promise(() => {});
    return value;
  };
  const api: Pick<ApiClient, 'uploadAttachment' | 'getPage' | 'getPlannerFolder' | 'getFolderSnapshot' | 'getPlannerToday' | 'getPlannerFolderSessions' | 'getPlannerFolderSubfolders' | 'getFolderBoardItems' | 'listCards' | 'listCompletedCards' | 'getCard' | 'createCard' | 'executeCard' | 'getCardExecution' | 'saveCardExecutionSettings' | 'getSessionsByIds' | 'setCardStatus' | 'getStarredFolders' | 'listNodes' | 'listNodeAgents' | 'listModelPresets'> = {
    // Mock upload only: the sample asset is served by the review export.
    uploadAttachment: async (_sessionId, nodeId, file) => ({ path: file.uri, filename: file.name, node_id: nodeId }),
    getPage:async id=>read({page:{...starredFolders[0].page,id},blocks:[],stateVector:''}),
    getPlannerFolder:async (id,query)=>read({folder:{...folders[0],id,projectPageId:'public-page'},page:{...starredFolders[0].page,id:'public-page'},blocks:[],cards:[...cards.values()].filter(card=>card.folderId===id&&(query?.includeCompleted!==false||card.status!=='done')),subfolders:{items:[],nextCursor:null},sessions:{items:[],nextCursor:null}}),
    getFolderSnapshot:async (id,query)=>read({folder:folders[0],cards:[...cards.values()].filter(card=>card.folderId===id&&(query?.includeCompleted!==false||card.status!=='done'))}),
    getPlannerToday:async()=>read({daily:{page:starredFolders[0].page,blocks:[],stateVector:''},attention:[],running:[],queued:[],projects:[],memoBlocks:[],folders:[],reviewSessionIds:[]}),
    getPlannerFolderSessions:async(pageId,cursor)=>{
      let releaseResponse:(()=>void)|undefined;
      const gatedResponse=options.folderSessionPages==='many'&&cursor==='1'
        ?new Promise<void>(resolve=>{releaseResponse=resolve;})
        :null;
      options.onFolderSessionPageRequest?.(pageId,cursor??null,releaseResponse);
      const pageIndex=cursor===undefined?0:Number(cursor);
      const start=pageIndex*folderSessionPageSize;
      const items=folderSessions.slice(start,start+folderSessionPageSize)
        .map(session=>({agentSessionId:session.agentSessionId}));
      const result={items,nextCursor:start+folderSessionPageSize<folderSessions.length?String(pageIndex+1):null};
      if(gatedResponse)await gatedResponse;
      else if(options.folderSessionPages)await new Promise(resolve=>setTimeout(resolve,120));
      return read(result);
    },
    getPlannerFolderSubfolders:async()=>read({items:[],nextCursor:null}),
    getFolderBoardItems:async()=>read([]),
    listCards: async (folderId,query) => read({ cards: state === 'empty' ? [] : [...cards.values()].filter((card) => (!folderId || card.folderId === folderId)&&(query?.includeCompleted!==false||card.status!=='done')) }),
    listCompletedCards:async params=>{
      const filtered=state==='empty'?[]:[...cards.values()].filter(card=>card.status==='done'&&(!params.folderId||card.folderId===params.folderId)&&(!params.completedFrom||card.completedAt!>=params.completedFrom)&&(!params.completedBefore||card.completedAt!<params.completedBefore)&&(`${card.title} ${card.request}`.toLocaleLowerCase().includes((params.q??'').toLocaleLowerCase()))).sort((a,b)=>(b.completedAt??'').localeCompare(a.completedAt??'')||b.id.localeCompare(a.id));
      const offset=Number(params.cursor??0),limit=params.limit??60;
      return read({cards:filtered.slice(offset,offset+limit),nextCursor:offset+limit<filtered.length?String(offset+limit):null});
    },
    getCard: async (id) => {
      const card = cards.get(id);
      if (!card) throw new Error('알 수 없는 공개 예시 카드');
      return { card, reports: card.status === 'review' || card.status === 'done' ? [{ id: `report-${id}`, cardId: id, title: '공개 보고', format: 'markdown', body: '변경을 확인해 주세요.', createdAt: time }] : [], comments: [{id:'public-comment',cardId:id,authorKind:'user',authorId:'public-user',sessionId:null,kind:'comment',body:'요청과 결과를 확인합니다.',createdAt:time}], questions: card.blockedKind === 'question' ? [{ id: 'public-question', cardId: id, sessionId: 'public-session', text: '공개 질문입니다.', options: null, answer: null, askedAt: time }] : [], sessions:card.assigneeSessionId?[{...sessions[0],status:options.assignment==='live'?'running':'completed',cardId:id,nodeId:'public-node',agentId:'public-agent'}]:[] };
    },
    createCard: async (body) => {
      options.onCreateCard?.(body);
      if (options.failWrites) throw new Error('공개 예시: 저장 실패');
      const card = { ...makeCard(body.queue ? 'queued' : 'todo'), id: `public-draft-${cards.size}`, title: body.title, request: body.request, folderId: body.folderId,
        assigneeKind: body.assignee?.kind ?? null, assigneeAgentId: body.assignee?.agentId ?? null,
        assigneeSessionId: body.assignee?.sessionId ?? null, assigneeUserId: body.assignee?.userId ?? null,
        nodeId: body.nodeId ?? null, modelPreset: body.modelPreset ?? null, attachments: body.attachments ?? [] };
      cards.set(card.id, card); return { card, folderId: card.folderId };
    },
    setCardStatus: async (id, status, expectedVersion) => {
      if (options.failWrites) throw new Error('공개 예시: 저장 실패');
      const current = cards.get(id);
      if (!current) throw new Error('알 수 없는 공개 예시 카드');
      if (current.version !== expectedVersion) throw new Error('공개 예시: 버전 충돌');
      const card = { ...current, status, version: current.version + 1,completedAt:status==='done'?new Date().toISOString():null };
      cards.set(id, card);
      return { folderId: card.folderId, card };
    },
    getSessionsByIds:async(sessionIds)=>read(reviewSessions.filter(session=>sessionIds.includes(session.agentSessionId))),
    saveCardExecutionSettings:async(id,value,expectedVersion)=>{
      if(options.failWrites)throw new Error('공개 예시: 저장 실패');
      const current=cards.get(id)!;
      if(current.assigneeSessionId||current.version!==expectedVersion)throw new Error('공개 예시: 설정 변경 불가');
      const card={...current,...value,assigneeAgentId:value.agentId,version:current.version+1};cards.set(id,card);return {card,folderId:card.folderId};
    },
    executeCard:async(id,_version,key)=>{
      if(options.failWrites)throw new Error('공개 예시: 실행 실패. 기존 상태를 유지합니다.');
      const current=cards.get(id)!;const already=current.status==='running'&&!!current.assigneeSessionId;
      const card={...current,status:'running' as const,assigneeKind:'session' as const,assigneeSessionId:'public-running',version:current.version+1};cards.set(id,card);
      return {card,folderId:card.folderId,execution:{requestId:key,sessionId:'public-running',state:options.pendingExecution?'pending' as const:already?'already_running' as const:'started' as const}};
    },
    getCardExecution:async(id,key)=>({card:cards.get(id)!,folderId:cards.get(id)!.folderId,execution:{requestId:key,sessionId:'public-running',state:options.pendingExecution?'pending':'started'}}),
    getStarredFolders: async () => read({ items: state === 'empty' ? [] : starredFolders, nextCursor: null }),
    listNodes: async () => read({ nodes: state === 'empty' ? [] : [{ nodeId: 'public-node' }, { nodeId: 'public-other-node' }] }),
    listNodeAgents: async () => read({ agents: state === 'empty' ? [] : [
      { id: 'public-agent', name: '공개 예시 에이전트', default_preset: 'public-model' },
      { id: 'public-other-agent', name: '다른 예시 에이전트', default_preset: 'public-model' },
    ] }),
    listModelPresets: async () => read({ model_presets: state === 'empty' ? [] : [
      { id: 'public-model', label: '사용 가능한 예시 모델', backend: 'codex', available: true,
        reason: null, reason_label: null, resets_at: null, usage_warning: false },
      { id: 'public-exhausted-model', label: '사용량 소진 예시 모델', backend: 'codex', available: true,
        reason: 'quota_exhausted', reason_label: '7일 사용량 제한', resets_at: null, usage_warning: false },
      { id: 'public-unavailable-model', label: '사용 불가 예시 모델', backend: 'codex', available: false,
        reason: 'limit', reason_label: '공개 예시: 사용량 한도', resets_at: null, usage_warning: false },
    ] }),
  };
  // Existing injected API contracts accept ApiClient. This object implements
  // only the methods the samples use and has no transport or fallback client.
  return api as ApiClient;
}
export function message(type: SessionEvent['type'], text: string): SessionEvent {
  return { id: 'public-' + type, type, data: { text } };
}
export const guidance = '이 프로젝트는 공개 fixture만 사용합니다.\n현재 앱의 표시와 상호작용을 확인합니다.\n'.repeat(6);
