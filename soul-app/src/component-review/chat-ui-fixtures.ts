import { validateChatUiDocument, renderText, type ChatUiDocumentV1, type Field, type Node } from '@soulstream/chat-ui';
import type { SessionEvent } from '../api/types';
const source={type:'external_link' as const,label:'OpenUI 원문',url:'https://www.openui.com/blog/how-chatgpt-intelligent-ui-works'};
const options=[{id:'app',label:'앱 먼저'},{id:'web',label:'웹 먼저'},{id:'both',label:'웹과 앱 함께'},{id:'contract',label:'공통 계약부터 확인'},{id:'capture',label:'작은 화면에서 입력과 돌아가기 확인'},{id:'hold',label:'추가 검수 뒤 결정'}];
const base:Partial<ChatUiDocumentV1>={schema_version:1,units:{count:{dims:{count:1},symbol:'명',scale:1},rate:{dims:{'currency:KRW':1,count:-1},symbol:'원/명',scale:1},won:{dims:{'currency:KRW':1},symbol:'원',scale:1},ratio:{dims:{},symbol:'',scale:1}},sources:{original:source,unshown:{type:'external_link',label:'Renderer 문서',url:'https://www.openui.com/docs/openui-lang/renderer'}}};
const controls:Record<string, Field>={memo:{type:'text',initial:'',maxLength:200},notify:{type:'boolean',initial:true},order:{type:'choice',initial:'app',options},checks:{type:'selection',initial:['focus'],options:[{id:'focus',label:'입력창 포커스'},{id:'reset',label:'전체 초기화'},{id:'sources',label:'글 대체의 출처'},{id:'narrow',label:'좁은 화면'},{id:'a11y',label:'키보드와 체크 상태'},{id:'draft',label:'기존 초안과 첨부 보존'}]}};
const actions:Node[]=[{id:'copy',kind:'button',label:'복사',action:{type:'copy'}},{id:'reset',kind:'button',label:'초기화',action:{type:'reset'}}];
const formItems=[{field:'memo',label:'덧붙일 말'},{field:'notify',label:'결과 알림'},{field:'order',label:'진행 순서'},{field:'checks',label:'확인할 것'}];
const pas:ChatUiDocumentV1={...base,schema_version:1,fields:controls,assumptions:[],body:[{id:'heading',kind:'heading',level:2,parts:['다음 작업을 골라줘']},{id:'cards',kind:'group',layout:'stack',children:[{id:'card1',kind:'entity',label:'#270 화면 시안 검수 중',details:['입력창 배치와 전체 초기화를 확인한 뒤 디렉터 동의를 받아.'],source:'original'},{id:'card2',kind:'entity',label:'공통 계약 반영됨',details:['값과 계산, 글 변환을 웹과 앱이 함께 써.'],source:'unshown'}]},{id:'form',kind:'form',items:formItems,submitLabel:'이 순서로 요청',action:{type:'compose',parts:['진행 순서: ',{value:{field:'order'}},'\n확인할 것: ',{value:{field:'checks'}},'\n덧붙일 말: ',{value:{field:'memo'}},'\n결과 알림: ',{value:{field:'notify'}}]}},{id:'actions',kind:'group',layout:'wrap',children:actions},{id:'citation',kind:'citation',source:'original'},{id:'caption',kind:'caption',parts:['카드 현황 예시']}]};
const normal:ChatUiDocumentV1={...base,schema_version:1,fields:{seats:{type:'number',initial:8,min:1,max:50,step:1,unit:'count'},annual:{type:'boolean',initial:false},...controls},data:{price:{value:29000,unit:'rate'}},computed:{total:{op:'mul',args:[{op:'ref',ref:{field:'seats'}},{op:'ref',ref:{data:'price'}},{op:'if',args:[{op:'ref',ref:{field:'annual'}},{op:'const',value:0.8,unit:'ratio'},{op:'const',value:1,unit:'ratio'}]}]}},assumptions:[],body:[{id:'heading',kind:'heading',level:2,parts:['팀 요금']},{id:'inputs',kind:'group',layout:'stack',children:[{id:'slider',kind:'slider',field:'seats',label:'인원수'},{id:'checkbox',kind:'checkbox',field:'annual',label:'연간 결제 (20% 할인)'}]},{id:'total',kind:'text',emphasis:'strong',parts:[{value:{computed:'total'},unit:'won'},'/월']},{id:'hint',kind:'text',visibleWhen:{op:'lte',args:[{op:'const',value:10,unit:'count'},{op:'ref',ref:{field:'seats'}}]},parts:['10명 이상이면 팀 예산을 함께 확인해.']},{id:'assumption',kind:'caption',parts:['인당 월 29,000원, 세금 제외']},{id:'entity',kind:'entity',label:'요금 가정',details:['실제 서비스 요금이 아닌 계산 예시야.'],source:'original'},{id:'compose',kind:'button',label:'이 조건으로 질문',action:{type:'compose',parts:[{value:{field:'seats'}},', 연간 결제: ',{value:{field:'annual'}},', 월 ',{value:{computed:'total'},unit:'won'},' 조건으로 비교해 줘.']}},{id:'actions',kind:'group',layout:'wrap',children:actions},{id:'citation',kind:'citation',source:'original'}]};
const gallery:ChatUiDocumentV1={...normal,body:[{id:'heading',kind:'heading',level:2,parts:['첫 조각 갤러리']},{id:'text',kind:'text',parts:['같은 문서를 네 문맥에 표시해.']},{id:'strong',kind:'text',emphasis:'strong',parts:['강조는 본문 크기 그대로']},{id:'caption',kind:'caption',parts:['heading, text, caption, group']},{id:'group',kind:'group',layout:'stack',children:[{id:'slider',kind:'slider',field:'seats',label:'인원수'},{id:'checkbox',kind:'checkbox',field:'annual',label:'연간 결제 (20% 할인)'}]},{id:'form',kind:'form',items:[{field:'seats',label:'인원수 (명)'},...formItems],submitLabel:'이 값으로 요청',action:{type:'compose'}},{id:'entity',kind:'entity',label:'자료 상세',details:['OpenUI 원문에서 확인한 구성 요소야.'],source:'original'},{id:'citation',kind:'citation',source:'original'},{id:'actions',kind:'group',layout:'wrap',children:[...actions,{id:'set',kind:'button',label:'12명으로 설정',action:{type:'set',field:'seats',value:12}}]}]};

export const chatUiDocuments = { pas, normal, gallery };
export type ChatUiExample = keyof typeof chatUiDocuments;

// The publication envelope matches the saved Sonnet/Sol event shape. These
// public documents are the approved v3 examples, not production user payloads.
export function chatUiFixtureEvent(example: ChatUiExample, overrides: Record<string, unknown> = {}): SessionEvent {
  const validation = validateChatUiDocument(chatUiDocuments[example]);
  if (!validation.ok) throw new Error('검수 문서가 유효하지 않습니다.');
  return {
    id: `chat-ui-review-${example}`, type: 'assistant_message',
    data: { content: renderText(validation.document), ui: {
      schema_version: 1, ui_id: `review_${example}`, hash: 'a'.repeat(64), revision: 1,
      document: chatUiDocuments[example], ...overrides,
    } },
  };
}

export const chatUiCoverageDocument: ChatUiDocumentV1 = {
  ...gallery,
  fields: {
    ...gallery.fields,
    short: { type: 'choice', initial: 'first', options: [{ id: 'first', label: '기본' }, { id: 'second', label: '추가' }] },
    longCheck: { type: 'boolean', initial: true },
    longChoice: { type: 'choice', initial: 'long', options: [
      { id: 'long', label: '작은 화면의 입력과 돌아가기, 기존 초안과 첨부 보존 확인' },
      { id: 'short', label: '입력만 확인' },
    ] },
  },
  sources: { ...gallery.sources, assumption: { type: 'assumption', label: '계산 가정', note: '실제 서비스 요금이 아닌 계산 예시야.' } },
  assumptions: ['검수용 공개 예시'],
  body: [
    ...gallery.body,
    { id: 'coverage', kind: 'form', items: [
      { field: 'short', label: '확인 범위' },
      { field: 'memo', label: '포커스 확인' },
      { field: 'longCheck', label: '입력창 포커스와 글 대체의 출처, 기존 초안과 첨부 보존' },
      { field: 'longChoice', label: '자세한 범위' },
    ], submitLabel: '이 범위로 요청', action: { type: 'compose' } },
    { id: 'sourceAction', kind: 'button', label: '참고 자료 열기', action: { type: 'open_source', source: 'unshown' } },
    { id: 'assumptionSource', kind: 'citation', source: 'assumption' },
  ],
};
