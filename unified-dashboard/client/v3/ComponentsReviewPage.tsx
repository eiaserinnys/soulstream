import {CardCreateSample} from "./CardCreateSample";
import { SessionMenuProvider } from "./SessionMenuProvider";
import { SessionMenuReviewSample } from "./SessionMenuReviewSample";
import { useState, type ReactNode } from "react";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { SystemMessage } from "@seosoyoung/soul-ui/components/chat/SystemMessage";
import { CollapsibleCaption } from "@seosoyoung/soul-ui/components/chat/CollapsibleCaption";
import { LabeledDivider } from "@seosoyoung/soul-ui/components/chat/LabeledDivider";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { FolderPanelHeader, SessionPanelHeader } from "./WorkspacePanelHeaders";
import { Button, DashboardIconCap, Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle, formatAssignedCardContextSnapshot } from "@seosoyoung/soul-ui";
import { Folder, Layers, LayoutDashboard, MessageSquare, MoreHorizontal, Plus, RotateCcw, SendHorizontal, SquarePen, Star } from "lucide-react";
import { CardRowView } from "./CardRow";
import { RichSessionRow } from "./RichSessionRow";
import { PlannerFolderCardView } from "./PlannerFolderCard";
import { InlineMarkdownCard } from "./InlineMarkdownCard";
import { CardTimeline } from "./CardTimeline";
import { CardHandoffSample } from "./CardHandoffSample";
import { FolderPicker } from "./FolderPicker";
import { FolderDescriptionPanel } from "./FolderDescriptionPanel";
import { FolderTodayToggle } from "./FolderTodayToggle";
import { ComponentsReviewControls } from "./ComponentsReviewControls";
import { ProjectNavigationTree } from "./ProjectNavigationTree";
import { reviewCard, reviewCardItems, reviewDetail, reviewFolder, reviewFolders, reviewNow, reviewSession, reviewTitle } from "./components-review-fixtures";
import "./components-review.css";
import { PostItCardSamples } from "./PostItCardSamples";
import { ReadOnlyCardListSample } from "./ReadOnlyCardListSample";
import { CardOrchestrationSettingsSample } from "./CardOrchestrationSettingsSample";
import { CardBoardSamples } from "./CardBoardSamples";
import { CardCheckItemsSamples } from "./CardCheckItemsSamples";
import { V3_SESSION_PANEL_DEFAULT_WIDTH_PX } from "./v3-layout-metrics";
import { PersistentChatDisplayReviewSample } from "./PersistentChatDisplayReviewSample";
import { PersistentManuscriptChatReviewSample } from "./PersistentManuscriptChatReviewSample";
import { PersistentTurnEndCaptionsReviewSample } from "./PersistentTurnEndCaptionsReviewSample";
import { PersistentAgentMessageGroupReviewSample } from "./PersistentAgentMessageGroupReviewSample";
import { ManuscriptActivityReviewSample } from "./ManuscriptActivityReviewSample";
import { PersistentSessionSettingsReviewSample } from "./PersistentSessionSettingsReviewSample";
import { PersistentSessionInstructionsReviewSample } from "./PersistentSessionInstructionsReviewSample";
import { PersistentSessionScreenReviewSample } from './PersistentSessionScreenReviewSample';
import { SwayCharacterReviewSample } from "./SwayCharacterReviewSample";
import { PersistentSessionTaskListReviewSample } from "./PersistentSessionTaskListReviewSample";
import { PersistentSessionPortraitToggleReviewSample } from "./PersistentSessionPortraitToggleReviewSample";

const sections = [
  { id: "board", title: "카드 보드", icon: LayoutDashboard },
  { id: "rows", title: "목록 행", icon: Folder },
  { id: "heads", title: "머리·캡", icon: Layers },
  { id: "bubbles", title: "말풍선", icon: MessageSquare },
  { id: "input", title: "입력창", icon: SendHorizontal },
  { id: "controls", title: "선택·설정", icon: SquarePen },
  { id: "surfaces", title: "패널 표면", icon: SquarePen },
];

const assignedCardPreview = formatAssignedCardContextSnapshot({
  total: 1, omitted: 0, capturedAt: "2026-10-02T01:00:00.000Z",
  cards: [{
    id: "860fe149-ae89-46bd-bb3e-b6115229edba",
    title: "담당 카드 현황 매 턴 주입·외부 변경 알림",
    status: "running",
    latestCommentAt: "2026-10-02T00:55:00.000Z",
    latestReportAt: "2026-10-02T00:40:00.000Z",
  }],
});

function Sample({ name, state, children }: { name: string; state: string; children: ReactNode }) {
  return <div className="v3-components-sample" data-component={name}>
    <p className="v3-components-label">{name} · {state}</p>{children}
  </div>;
}

export function ComponentsReviewPage() {
  const [title, setTitle] = useState("컴포넌트 검수");
  const [notice, setNotice] = useState("샘플을 눌러 비교합니다. 입력과 버튼은 이 페이지 안에서만 동작합니다.");
  const [starred, setStarred] = useState(false);
  const [inToday, setInToday] = useState(false);
  const [documentExpanded, setDocumentExpanded] = useState(false);
  const [documentBody, setDocumentBody] = useState("# 문서 샘플\n\n운영 문서 행과 같은 표시와 여백을 사용합니다.");
  const [inputSampleVersion, setInputSampleVersion] = useState(0);
  const [folder, setFolder] = useState(reviewFolders[0]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [description, setDescription] = useState("폴더 설명을 누르면 기존 편집기가 열립니다.");
  const [comments, setComments] = useState(reviewDetail.comments ?? []);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const open = (label: string) => setNotice(`${label} 샘플을 열었습니다.`);
  const folderStar = { starred, pending: false, error: null, toggle: async () => setStarred(value => !value) };
  const send = (request:string) => {
    if (!request.trim()) return;
    setComments(current => [...current, { id: `components-comment-${current.length}`, cardId: reviewCard.id,
      authorKind: "user", authorId: "sample", sessionId: null, kind: "comment", body: request,
      createdAt: new Date().toISOString() }]);
    setNotice("샘플 메시지를 페이지의 말풍선에 추가했습니다.");
  };
  const reset = () => {
    setStarred(false); setInToday(false); setDocumentExpanded(false); setInputSampleVersion(value=>value+1);
    setFolder(reviewFolders[0]); setComments([]); setNotice("샘플 상태를 초기화했습니다.");
  };
  const folderProps = {
    sessions: [reviewSession], nodeConnectivity: { ready: true, connectedNodeIds: new Set(["eiaserinnys"]) },
    isInToday: inToday, folderStar, onComplete: async () => open("폴더 완료"),
    onToggleToday: async () => setInToday(value => !value), onMoveToParent: () => open("상위 폴더 이동"),
  };

  return <SessionMenuProvider sessions={[reviewSession]}
    onRename={async()=>open("세션 이름 변경")} onDelete={async()=>open("세션 삭제")}
    onMove={async(_id,target)=>open(`폴더 이동 · ${target.page.title}`)} onCreated={()=>open("세션 승계")}>
    <article className="v3-detail-pane v3-detail-pane--inline" data-testid="components-review">
    <FolderPanelHeader title={title} onRename={async next => setTitle(next)} inline
      backLabel="대시보드로 돌아가기" onBack={() => window.location.assign("/")} actions={
        <DashboardIconCap label="샘플 상태 초기화" onClick={reset}><RotateCcw className="h-4 w-4" /></DashboardIconCap>
      }/>
    <div className="v3-detail-scroll">
      <div className="v3-task-detail-layout">
        <nav className="v3-task-section-nav" aria-label="검수 섹션">
          {sections.map(({ id, title: label, icon: Icon }) => <button key={id} type="button" className="v3-task-section-anchor"
            onClick={() => document.getElementById(`components-${id}`)?.scrollIntoView({ block: "start" })}>
            <Icon className="h-4 w-4" /><span>{label}</span>
          </button>)}
        </nav>
        <div className="v3-task-detail-content">
          <Button variant="link" render={<a href="/dialogues"/>}>다이얼로그 비교</Button>
          <p role="status" className="v3-components-label">{notice}</p>
          <section id="components-board" className="v3-detail-section">
            <p className="v3-components-label">CardWorkspace / CardDetailPane · 확인 항목·커멘트·세션·노트 탭 · 짧은·긴 대화 · 하단 입력창</p>
            <CardBoardSamples/>
            <Sample name="CardNowPanel / CardCheckItems / CardNotes" state="실제 항목 상태 · 확인함 묶음 · 상황판 이력 · 노트 접기">
              <CardCheckItemsSamples/>
            </Sample>
          </section>
          <section id="components-rows" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>목록 행</h3></div>
            <div className="v3-components-samples">
              <Sample name="RichSessionRow / RunRowFrame" state="기본 · 행 클릭 · 포커스">
                <div className="v3-run-list"><RichSessionRow session={reviewSession} onOpen={() => open("세션")}/></div>
              </Sample>
              <Sample name="RichSessionRow" state="small · 긴 한국어 제목">
                <div className="v3-run-list"><RichSessionRow size="small" session={{ ...reviewSession, agentSessionId: "components-small", displayName: reviewTitle }} onOpen={() => open("small 세션")}/></div>
              </Sample>
              <Sample name="RichSessionRow" state="긴 오프라인 상태 · 미리보기 유무">
                <div className="v3-run-list">{(["default", "small"] as const).map(size => <RichSessionRow key={size} size={size}
                  nodeOffline session={{ ...reviewSession, agentSessionId: `components-offline-${size}`, displayName: reviewTitle }}
                  onOpen={() => open("오프라인 세션")}/>)}</div>
              </Sample>
              <Sample name="RichSessionRow / RunRowFrame" state="운영 패널 폭 · 소속 · 긴 제목과 본문 · 오른쪽 상태와 시간">
                <div className="v3-run-list" style={{ width: "100%", maxWidth: V3_SESSION_PANEL_DEFAULT_WIDTH_PX }} data-testid="session-row-operating-sample">
                  <RichSessionRow session={{ ...reviewSession, displayName: reviewTitle }} affiliation={reviewTitle} preview={reviewTitle} onOpen={() => open("운영 폭 세션")}/>
                </div>
              </Sample>
              <Sample name="CardRowView / RunRowFrame" state="기본 · 여러 항목 · 긴 한국어 제목">
                <div className="v3-run-list">{[reviewCard.title, reviewTitle].map((label, index) => <CardRowView key={label}
                  card={{ ...reviewCard, ...(index===0?{items:reviewCardItems,now:reviewNow}:{}), id: `components-card-${index}`, title: label }} assignee={reviewSession} detail={reviewDetail} onOpen={() => open("카드")}/>)}</div>
              </Sample>
              <Sample name="작업 목록과 카드 읽기 요약" state="예시"><PersistentSessionTaskListReviewSample/></Sample>
              <Sample name="CardRowView / RunRowFrame actions" state="같은 내용 · 막힘 / 검수 · 미리보기 유무 · small 캡">
                {(["blocked", "review"] as const).map(status => <CardRowView key={status}
                  card={{...reviewCard, status, title: "상태별 같은 카드", request: "같은 미리보기", id: `compare-${status}`}}
                  assignee={reviewSession} onOpen={() => open("카드 비교")}
                  completion={{pending:false,onComplete:()=>open("완료 비교")}}/>)}
                <CardRowView card={{...reviewCard, title: "상태별 같은 카드", request: "", id: "compare-no-preview"}}
                  assignee={reviewSession} onOpen={() => open("카드 비교")}/>
              </Sample>
              <Sample name="PostItCardView / PostItGrid" state="채팅 글자 비율 · 상태/색상 메뉴 표면 · 사유 입력 · 질문 · 로컬 샘플">
                <PostItCardSamples onOpen={open}/>
              </Sample>
              <Sample name="PostItCardView / PostItGrid readonly" state="승인된 iframe 5그룹 · 태그 없음 · 비대화형 카드 · 필터와 새로고침">
                <ReadOnlyCardListSample/>
              </Sample>
              <Sample name="PlannerFolderCardView" state="하위 폴더 · 관리 캡">
                <div className="v3-task-list"><PlannerFolderCardView {...folderProps} task={reviewFolder("폴더 카드 기본", "components-folder-card")}
                  onOpen={() => open("폴더")} onRename={() => open("폴더 관리")} onArchive={() => open("폴더 보관")}/></div>
              </Sample>
              <Sample name="PlannerFolderCardView" state="상위 폴더 · 긴 한국어 제목">
                <div className="v3-task-list"><PlannerFolderCardView {...folderProps} navigationLabel="상위 폴더"
                  sessions={[]} task={{ ...reviewFolder(reviewTitle, "components-parent"), assignee: "담당 미지정" }} onOpen={() => open("상위 폴더")}/></div>
              </Sample>
              <Sample name="InlineMarkdownCard" state="문서 행 · 펼치기 · 본문 편집">
                <div className="v3-inline-board-list"><InlineMarkdownCard title={reviewTitle} expanded={documentExpanded}
                  onToggle={() => setDocumentExpanded(value => !value)} onRename={() => open("문서 이름 수정")}>
                  {documentExpanded ? <div className="v3-inline-markdown"><FolderDescriptionPanel variant="inline" markdown={documentBody}
                    ariaLabel="검수 문서" onSave={async body => setDocumentBody(body)}/></div> : null}
                </InlineMarkdownCard></div>
              </Sample>
            </div>
          </section>
          <section id="components-heads" className="v3-detail-section">
            <div className="v3-components-samples">
            <Sample name="FolderPanelHeader / SessionPanelHeader" state="운영 머리와 첫 본문 · 긴 제목 · 모델 · 상태 · 스토리">
              <div className="v3-components-panel-pair" data-testid="components-panel-headers">
                <article className="v3-detail-pane">
                  <FolderPanelHeader title={reviewTitle} onRename={async () => open("폴더 이름")}
                    backLabel="샘플 뒤로" onBack={() => open("뒤로")}
                    status={{value:"in_progress",icon:"○",label:"Open"}} actions={<>
                      <DashboardIconCap label="샘플 폴더 별표" onClick={() => setStarred(value => !value)}><Star className="h-4 w-4"/></DashboardIconCap>
                      <FolderTodayToggle inToday={inToday} onToggle={async () => setInToday(value => !value)}/>
                      <DashboardIconCap label="샘플 폴더 보드" onClick={() => open("보드")}><LayoutDashboard className="h-4 w-4"/></DashboardIconCap>
                      <DashboardIconCap label="샘플 폴더 메뉴" onClick={() => open("메뉴")}><MoreHorizontal className="h-4 w-4"/></DashboardIconCap>
                    </>}/>
                  <div className="v3-detail-scroll"><div className="v3-task-detail-content"><section className="v3-detail-section">
                    <div className="v3-detail-section-head"><h3>정보</h3></div>
                    <FolderDescriptionPanel markdown={description} onSave={async body => setDescription(body)}/>
                  </section></div></div>
                </article>
                <section className="v3-chat-pane">
                  <SessionPanelHeader session={{...reviewSession,displayName:reviewTitle,modelLabel:"Claude Opus",modelPreset:"qa-opus",backend:"claude"}}
                    streamActive connectionStatus="connected" reconnect={() => open("다시 연결")} onClose={() => open("닫기")}/>
                  <div className="v3-chat-content"><AssistantMessage portraitUrl="/system-portrait.png"
                    msg={{id:"header-first-message",role:"assistant",treeNodeId:"header-first-message",treeNodeType:"text",content:"머리 아래 첫 채팅입니다. 구분선 양쪽 여백을 함께 확인합니다."}}/></div>
                </section>
              </div>
            </Sample>
            <Sample name="섹션 머리" state="실제 다음 항목 · small 캡">
            <div>
            <div className="v3-detail-section-head"><h3>섹션 머리와 캡</h3><span className="v3-spacer"/>
              <DashboardIconCap size="small" label="샘플 항목 추가" onClick={() => open("항목 추가")}><Plus className="h-4 w-4"/></DashboardIconCap>
            </div>
            <div className="v3-run-list"><RichSessionRow size="small" session={reviewSession} onOpen={() => open("섹션 항목")}/></div>
            </div></Sample>
            <Sample name="FolderTodayToggle / DashboardIconCap" state="기본 · 선택 · 포커스">
              <div className="v3-folder-header-actions">
                <FolderTodayToggle inToday={inToday} onToggle={async () => setInToday(value => !value)}/>
                <DashboardIconCap label="샘플 별표" aria-pressed={starred} onClick={() => setStarred(value => !value)}>
                  <Star className="h-4 w-4" fill={starred ? "currentColor" : "none"}/>
                </DashboardIconCap>
                <DashboardIconCap label="비활성 샘플" disabled><Plus className="h-4 w-4"/></DashboardIconCap>
              </div>
            </Sample>
            </div>
          </section>
          <section id="components-bubbles" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>말풍선과 첨부</h3></div>
            <Sample name="CardTimeline / UserMessage / AssistantMessage" state="보고 · 이미지 확대 · 첨부 열기">
              <CardTimeline card={reviewCard} detail={{ ...reviewDetail, comments }} portraitUrl="/system-portrait.png" userPortraitUrl={null}
                onAnswer={() => open("질문 응답")} pending={false}/>
            </Sample>
            <Sample name="SystemMessage / CollapsibleCaption / LabeledDivider" state="기존 요약 · 접힘/펼침 · 말줄임 · 가운데 라벨">
              <div data-testid="caption-comparison">
                <UserMessage msg={{id:"assigned-card-input",role:"user",treeNodeId:"assigned-card-input",treeNodeType:"user_message",content:"외부 카드 알림을 확인해줘"}}/>
                <SystemMessage msg={{id:"assigned-card-preview",role:"system",treeNodeId:"assigned-card-preview",treeNodeType:"assigned_card_context",content:assignedCardPreview}}/>
                <AssistantMessage msg={{id:"caption-sample-answer",role:"assistant",treeNodeId:"caption-sample-answer",treeNodeType:"assistant_message",content:"구현을 맡겼습니다. 다른 작업 결과를 기다립니다."}}/>
                <SystemMessage msg={{id:"caption-sample-summary",role:"system",treeNodeId:"caption-sample-summary",treeNodeType:"turn_summary",content:"기존 요약: 다른 작업 결과를 기다립니다."}}/>
                <PersistentChatDisplayReviewSample />
                <PersistentManuscriptChatReviewSample />
                <PersistentTurnEndCaptionsReviewSample />
                <PersistentAgentMessageGroupReviewSample />
                <Sample name="Manuscript activity" state="도구·생각 구간 · 접힘/펼침 · 상태 · 생각 중"><ManuscriptActivityReviewSample /></Sample>
                <LabeledDivider label="다음 대화" />
                <LabeledDivider label="매우 긴 구분선 라벨이 좁은 화면에서 어떻게 보이는지 확인합니다" />
              </div>
            </Sample>
            <Sample name="CollapsibleCaption / align=start" state="기본 접힘 · 펼침 · 후보 없음 · 긴 줄 말줄임">
              <div className="space-y-2">
                <CollapsibleCaption title="Jev 후보 3">
                  <>
                    <div className="min-w-0 truncate text-xs text-muted-foreground">T38 · 요약 한 줄 · 3/3</div>
                    <div className="min-w-0 truncate text-xs text-muted-foreground">#412 · 카드 한 줄 · 2/3</div>
                    <div className="min-w-0 truncate text-xs text-muted-foreground">세션 제목 · 한 줄 · 2/3</div>
                  </>
                </CollapsibleCaption>
                <CollapsibleCaption initiallyCollapsed={false} title="Jev 후보 3">
                  <div className="min-w-0 truncate text-xs text-muted-foreground">T38 · 요약 한 줄 · 3/3</div>
                </CollapsibleCaption>
                <CollapsibleCaption initiallyCollapsed={false} title="Jev 후보 0">
                  <div className="min-w-0 truncate text-xs text-muted-foreground">2점 이상인 후보가 없습니다.</div>
                </CollapsibleCaption>
                <CollapsibleCaption initiallyCollapsed={false} title="Jev 후보 제목이 좁은 화면에서 말줄임되는 긴 제목 샘플">
                  <div className="min-w-0 truncate text-xs text-muted-foreground">T38 · 제목과 본문이 좁은 화면에서도 한 줄로 말줄임되는 후보 내용 샘플 · 3/3</div>
                </CollapsibleCaption>
              </div>
            </Sample>
            <Sample name="CollapsibleCaption / align=end" state="사용자 말풍선 방향 · 접힘 · 펼침 · 긴 줄 말줄임">
              <div className="space-y-2">
                <CollapsibleCaption title="Jev 후보 1" align="end">
                  <div className="min-w-0 truncate text-xs text-muted-foreground">#413 · 좁은 화면에서 한 줄 말줄임을 확인하기 위한 매우 긴 Jev 후보 설명 문장입니다 · 3/3</div>
                </CollapsibleCaption>
                <CollapsibleCaption title="Jev 후보 1 · 펼침" align="end" initiallyCollapsed={false}>
                  <div className="min-w-0 truncate text-xs text-muted-foreground">#413 · 좁은 화면에서 한 줄 말줄임을 확인하기 위한 매우 긴 Jev 후보 설명 문장입니다 · 3/3</div>
                </CollapsibleCaption>
              </div>
            </Sample>
          </section>
          <section id="components-input" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>입력창</h3></div>
            <Sample name="공통 세션 메뉴 / FolderMoveDialog / SessionSuccessionModal" state="운영 행·헤더 우클릭 · 기존 폴더 선택기 · 승계 · 비활성 사유">
              <SessionMenuReviewSample/>
            </Sample>
            <Sample name="CardCreateDialog / AgentNodeAssignmentFields / SessionAttachmentFields" state="운영 폼 · 폴더·실행 대상·첨부 · 로컬 검수 저장"><CardCreateSample/></Sample>
          <Sample name="CardHandoffView / CardComposer / ChatInputComposer / ChatInputEditor" state="선택행 위 · 한 줄 → 여러 줄 · 전송 · 로컬 첨부">
              <CardHandoffSample key={inputSampleVersion} onSend={send}/>
            </Sample>
          </section>
          <section id="components-controls" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>선택과 설정</h3></div>
            <div className="v3-components-samples">
            <Sample name="ProjectNavigationTree / FolderPicker" state="같은 폴더 이름 영역 · 로컬 선택">
              <div className="v3-nav-list"><ProjectNavigationTree folders={reviewFolders} selectedFolderId={folder.id}
                isExpanded={id => expandedFolders.has(id)} onToggleExpanded={id => setExpandedFolders(current => {
                  const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
                })} onSelect={setFolder} onContextMenu={() => open("폴더 메뉴")} onReorder={async () => open("폴더 순서")}/></div>
            </Sample>
            <ComponentsReviewControls/>
            <Sample name="PersistentSessionDetails / PersistentSessionMonitoring" state="표시 필드 · 판단 있음/없음 · 값 있음 · 기록 없음 · 불러오는 중 · 조회 실패"><PersistentSessionSettingsReviewSample/></Sample>
            <Sample name="PersistentSessionInstructions" state="빈 목록 · 항목 여럿 · 편집 중 · 상한 안내"><PersistentSessionInstructionsReviewSample/></Sample>
            <Sample name="PersistentSessionPortraitToggle" state="표시 · 숨김"><PersistentSessionPortraitToggleReviewSample/></Sample>
            <Sample name="CardOrchestrationSettingsForm / Input / Button" state="실제 설정 폼 · 모델 순서 · 저장 · 로컬 샘플"><CardOrchestrationSettingsSample/></Sample>
            </div>
          </section>
          <section id="components-surfaces" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>패널 표면</h3><span className="v3-spacer"/>
              <DashboardIconCap size="small" label="샘플 패널 열기" onClick={() => setPanelOpen(true)}><Layers className="h-4 w-4"/></DashboardIconCap>
            </div>
            <div className="v3-components-samples">
            <Sample name="SwayCharacter" state="원본 WebGL · 정지 이미지 · 표시 끔"><SwayCharacterReviewSample/></Sample>
            <Sample name="PersistentSessionScreen" state="운영 전화면 · 독립 세션과 전송"><PersistentSessionScreenReviewSample/></Sample>
            <Sample name="FolderDescriptionPanel / DialogPopup" state="폴더 설명 · 대화상자">
              <FolderDescriptionPanel markdown={description} onSave={async body => { setDescription(body); open("설명 저장"); }}/>
              <Dialog open={panelOpen} onOpenChange={setPanelOpen}><DialogPopup>
                <DialogHeader><DialogTitle>패널 표면 샘플</DialogTitle></DialogHeader>
                <DialogPanel><FolderDescriptionPanel markdown={documentBody} onSave={async body => { setDocumentBody(body); open("패널 저장"); }}/></DialogPanel>
              </DialogPopup></Dialog>
            </Sample>
            {(["compact", "daily"] as const).map(variant => <Sample key={variant} name="FolderDescriptionPanel" state={`${variant} · 동일 편집 표면`}>
              <FolderDescriptionPanel variant={variant} markdown={description} ariaLabel={`${variant} 설명`}
                onSave={async body => setDescription(body)}/>
            </Sample>)}
            </div>
          </section>
        </div>
      </div>
    </div>
  </article></SessionMenuProvider>;
}
