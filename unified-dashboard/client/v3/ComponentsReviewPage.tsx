import { useState, type ReactNode } from "react";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { FolderPanelHeader, SessionPanelHeader } from "./WorkspacePanelHeaders";
import { DashboardIconCap, Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle, Popover, PopoverPopup, PopoverTrigger } from "@seosoyoung/soul-ui";
import type { UploadedFile } from "@seosoyoung/soul-ui/hooks/useFileUpload";
import { Folder, Layers, LayoutDashboard, MessageSquare, MoreHorizontal, Plus, RotateCcw, SendHorizontal, SquarePen, Star } from "lucide-react";
import { CardRowView } from "./CardRow";
import { RichSessionRow } from "./RichSessionRow";
import { PlannerFolderCardView } from "./PlannerFolderCard";
import { InlineMarkdownCard } from "./InlineMarkdownCard";
import { CardTimeline } from "./CardTimeline";
import { CardComposer } from "./CardComposer";
import { FolderPicker } from "./FolderPicker";
import { FolderDescriptionPanel } from "./FolderDescriptionPanel";
import { FolderTodayToggle } from "./FolderTodayToggle";
import { ComponentsReviewControls } from "./ComponentsReviewControls";
import { ProjectNavigationTree } from "./ProjectNavigationTree";
import { reviewCard, reviewDetail, reviewFolder, reviewFolders, reviewSession, reviewTitle } from "./components-review-fixtures";
import "./components-review.css";
import { PostItCardSamples } from "./PostItCardSamples";
import { CardBoardSamples } from "./CardBoardSamples";

const sections = [
  { id: "board", title: "카드 보드", icon: LayoutDashboard },
  { id: "rows", title: "목록 행", icon: Folder },
  { id: "heads", title: "머리·캡", icon: Layers },
  { id: "bubbles", title: "말풍선", icon: MessageSquare },
  { id: "input", title: "입력창", icon: SendHorizontal },
  { id: "controls", title: "선택·설정", icon: SquarePen },
  { id: "surfaces", title: "패널 표면", icon: SquarePen },
];

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
  const [request, setRequest] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folder, setFolder] = useState(reviewFolders[0]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [description, setDescription] = useState("폴더 설명을 누르면 기존 편집기가 열립니다.");
  const [comments, setComments] = useState(reviewDetail.comments ?? []);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const open = (label: string) => setNotice(`${label} 샘플을 열었습니다.`);
  const folderStar = { starred, pending: false, error: null, toggle: async () => setStarred(value => !value) };
  const send = () => {
    if (!request.trim()) return;
    setComments(current => [...current, { id: `components-comment-${current.length}`, cardId: reviewCard.id,
      authorKind: "user", authorId: "sample", sessionId: null, kind: "comment", body: request,
      createdAt: new Date().toISOString() }]);
    setRequest(""); setFiles([]); setNotice("샘플 메시지를 페이지의 말풍선에 추가했습니다.");
  };
  const reset = () => {
    setStarred(false); setInToday(false); setDocumentExpanded(false); setRequest(""); setFiles([]);
    setFolder(reviewFolders[0]); setComments([]); setNotice("샘플 상태를 초기화했습니다.");
  };
  const folderProps = {
    sessions: [reviewSession], nodeConnectivity: { ready: true, connectedNodeIds: new Set(["eiaserinnys"]) },
    isInToday: inToday, folderStar, onComplete: async () => open("폴더 완료"),
    onToggleToday: async () => setInToday(value => !value), onMoveToParent: () => open("상위 폴더 이동"),
  };

  return <article className="v3-detail-pane v3-detail-pane--inline" data-testid="components-review">
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
          <p role="status" className="v3-components-label">{notice}</p>
          <section id="components-board" className="v3-detail-section">
            <CardBoardSamples onOpen={open}/>
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
              <Sample name="CardRowView / RunRowFrame" state="기본 · 여러 항목 · 긴 한국어 제목">
                <div className="v3-run-list">{[reviewCard.title, reviewTitle].map((label, index) => <CardRowView key={label}
                  card={{ ...reviewCard, id: `components-card-${index}`, title: label }} assignee={reviewSession} detail={reviewDetail} onOpen={() => open("카드")}/>)}</div>
              </Sample>
              <Sample name="CardRowView / RunRowFrame actions" state="같은 내용 · 막힘 / 검수 · 미리보기 유무 · small 캡">
                {(["blocked", "review"] as const).map(status => <CardRowView key={status}
                  card={{...reviewCard, status, title: "상태별 같은 카드", request: "같은 미리보기", id: `compare-${status}`}}
                  assignee={reviewSession} onOpen={() => open("카드 비교")}
                  completion={{pending:false,onComplete:()=>open("완료 비교")}}/>)}
                <CardRowView card={{...reviewCard, title: "상태별 같은 카드", request: "", id: "compare-no-preview"}}
                  assignee={reviewSession} onOpen={() => open("카드 비교")}/>
              </Sample>
              <Sample name="PostItCardView / PostItGrid" state="채팅 글자 비율 · 상태 변경 · 사유 입력 · 질문 · 로컬 샘플">
                <PostItCardSamples onOpen={open}/>
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
          </section>
          <section id="components-input" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>입력창</h3></div>
            <Sample name="CardComposer / ChatInputComposer / ChatInputEditor" state="한 줄 → 여러 줄 · 전송 · 로컬 첨부">
              <div className="v3-card-handoff">
                <CardComposer text={request} onChangeText={setRequest} onSend={send} placeholder="샘플 메시지" inputLabel="검수 메시지"
                  label="샘플 전송" disabled={!request.trim()} pending={false} files={files}
                  onAddFiles={incoming => {
                    const added = Array.from(incoming).map(file => ({ id: crypto.randomUUID(), file, path: null, status: "done" as const }));
                    setFiles(current => [...current, ...added]);
                  }} onRemoveFile={id => setFiles(current => current.filter(file => file.id !== id))}/>
                <div className="v3-card-handoff-controls">
                  <Popover open={folderOpen} onOpenChange={setFolderOpen}>
                    <PopoverTrigger className="v3-card-handoff-chip control-surface v3-card-handoff-folder rounded-full" aria-label="샘플 폴더 선택">
                      <span>📁 {folder.name}</span><span aria-hidden="true">▾</span>
                    </PopoverTrigger>
                    <PopoverPopup side="top" align="start" className="v3-shell v3-card-folder-picker">
                      <FolderPicker folders={reviewFolders} starredFolderIds={reviewFolders.map(item => item.id)} disabledFolderIds={new Set()}
                        selectedFolderId={folder.id} pending={false} onSelect={next => { setFolder(next); setFolderOpen(false); }}/>
                    </PopoverPopup>
                  </Popover>
                </div>
              </div>
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
            </div>
          </section>
          <section id="components-surfaces" className="v3-detail-section">
            <div className="v3-detail-section-head"><h3>패널 표면</h3><span className="v3-spacer"/>
              <DashboardIconCap size="small" label="샘플 패널 열기" onClick={() => setPanelOpen(true)}><Layers className="h-4 w-4"/></DashboardIconCap>
            </div>
            <div className="v3-components-samples">
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
  </article>;
}
