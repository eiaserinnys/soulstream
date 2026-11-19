import React from "react";
import { createRoot } from "react-dom/client";
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import "../../client/v3/v3-dashboard-styles";
import { LiquidGlassProvider } from "@seosoyoung/soul-ui";
import { AuthProvider } from "@seosoyoung/soul-ui/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";
import { V3GlobalToolbar } from "../../client/v3/V3GlobalToolbar";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { InterventionMessage } from "@seosoyoung/soul-ui/components/chat/InterventionMessage";
import { ChatToolApproval } from "@seosoyoung/soul-ui/components/chat/ChatToolApproval";
import { ChatInputRequest } from "@seosoyoung/soul-ui/components/chat/ChatInputRequest";
import { ContextBlock } from "@seosoyoung/soul-ui/components/chat/ContextBlock";
import { SystemPromptMessage } from "@seosoyoung/soul-ui/components/chat/SystemPromptMessage";
import { ToolCallGroup } from "@seosoyoung/soul-ui/components/chat/ToolCallGroup";
import { ChatView } from "@seosoyoung/soul-ui/components/chat/ChatView";
import { AskQuestionBanner } from "@seosoyoung/soul-ui/components/AskQuestionBanner";
import { ClaudeRuntimeNotificationsPanel } from "@seosoyoung/soul-ui/components/ClaudeRuntimeNotificationsPanel";
import { ClaudeRuntimeSchedulesPanel } from "@seosoyoung/soul-ui/components/ClaudeRuntimeSchedulesPanel";
import { ClaudeRuntimeTasksPanel } from "@seosoyoung/soul-ui/components/ClaudeRuntimeTasksPanel";

const scene = new URLSearchParams(location.search).get("scene") ?? "toolbar";
const question = { header: "작업 범위", question: "기존 대화의 맥락과 첨부 자료를 함께 살펴보고 변경 사항을 정리할까요?", options: [{ label: "함께 확인", description: "관련된 자료를 먼저 살펴봅니다." }, { label: "대화만 확인" }] };
const base = { id: "message", treeNodeId: "message", treeNodeType: "text", content: "지난 대화와 관련 자료를 살펴보고 중요한 변경 사항을 알려 주세요. 긴 질문도 작은 화면에서 자연스럽게 읽히는지 확인합니다." };
const runtime = { updatedAt: Date.now(), tasks: { task: { taskId: "task-20261119", status: "running", updatedAt: Date.now(), taskType: "agent", isBackgrounded: true, summary: "관련 문서와 대화를 확인하는 중" }, failure: { taskId: "task-failure", status: "failed", updatedAt: Date.now() } }, schedules: { schedule: { scheduleId: "schedule-1", kind: "cron", status: "active", nextRunAt: "2026-11-20T00:00:00Z", prompt: "아침 업무를 정리합니다" }, failed: { scheduleId: "schedule-2", kind: "cron", status: "failed" } }, notifications: { n: { notificationId: "n", source: "system", message: "관련 자료를 확인했습니다", updatedAt: Date.now() } }, remoteTriggers: { r: { triggerId: "r", source: "message_origin", prompt: "다음 단계 확인", updatedAt: Date.now() } }, transcriptMirror: { updatedAt: Date.now(), errorCount: 1, lastError: "연결 오류" }, planMode: { active: true, updatedAt: Date.now() }, worktreeMode: { active: false, worktreeAction: "keep", updatedAt: Date.now() } } as any;
const attention: any = { id: "attention", kind: "input_request", sessionId: "review", sourceEventId: 1, requestedAt: new Date().toISOString(), title: "작업 범위를 확인해 주세요", body: question.question, requiresDetail: true };
const node: any = scene === "approval-banner" ? { id: "approval", type: "tool_approval", approvalId: "approval", toolName: "Read", toolInput: { path: "문서/계획.md" }, content: "", completed: false, resolved: false, children: [] } : { id: "question", type: "input_request", requestId: "question", content: "", completed: false, responded: false, expired: false, questions: [question], children: [] };
useDashboardStore.setState({ activeSessionKey: scene === "empty" ? null : "review", activeSessionSummary: { agentSessionId: "review", status: scene === "waiting" ? "completed" : "running", eventCount: 0, agentName: scene === "named" ? "서소영" : undefined, agentId: scene === "named" ? "seosoyoung" : undefined, backend: "codex", pendingAttentions: scene === "attention" ? [attention] : [] } as any, claudeRuntime: runtime, tree: scene.endsWith("-banner") ? { id: "root", type: "session", sessionId: "review", content: "", completed: false, children: [node] } as any : null, treeVersion: 1 });

function App() {
  const msg = base as any;
  const llm = { isLlm: true, llmModel: "Claude Opus 4.6" };
  let content: React.ReactNode;
  if (scene === "toolbar") content = <V3GlobalToolbar onOpenConfig={() => {}} onOpenSearch={() => {}} />;
  else if (scene === "empty" || scene === "waiting" || scene === "input-error") content = <div style={{ height: 500 }}><ChatView /></div>;
  else if (scene === "attention" || scene.endsWith("-banner")) content = <AskQuestionBanner treeEnabled={scene !== "attention"} />;
  else if (scene === "cards") content = <><ChatToolApproval sessionId="review" msg={{ ...msg, toolName: "Read", toolInput: { path: "문서/작업 계획.md" }, approvalId: "approval" }} /><ChatInputRequest sessionId="review" msg={{ ...msg, questions: [question], requestId: "question", timeoutSec: 300 }} /></>;
  else if (scene === "context") content = <><ToolCallGroup messages={[{ ...msg, role: "tool", toolName: "Read", toolResult: "완료" }]} /><ContextBlock items={[{ key: "project", label: "프로젝트 배경", content: "대화 화면을 점검하고 사용자에게 결과를 설명합니다." }]} /><SystemPromptMessage msg={msg} /></>;
  else if (scene === "runtime") content = <><ClaudeRuntimeNotificationsPanel sessionId="review" /><ClaudeRuntimeSchedulesPanel sessionId="review" runtime={runtime} /><ClaudeRuntimeTasksPanel sessionId="review" runtime={runtime} /></>;
  else content = <><UserMessage msg={{ ...msg, role: "user", ...(scene === "named" ? { agentInfo: { agent_name: "로젤린", agent_id: "roselin", agent_node: "silent-manari-ts" } } : {}) }} llmContext={scene === "llm" ? llm : undefined} /><AssistantMessage msg={{ ...msg, role: "assistant", usage: { input_tokens: 1220, output_tokens: 320 } }} llmContext={scene === "llm" ? llm : undefined} /><InterventionMessage msg={{ ...msg, role: "intervention", content: "진행 중인 작업에 이 조건도 반영해 주세요." }} /></>;
  return <LiquidGlassProvider><main className="v3-shell v3-chat-surface min-h-screen text-foreground" data-testid="review-frame">{content}</main></LiquidGlassProvider>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><AuthProvider><App /></AuthProvider></QueryClientProvider>);
