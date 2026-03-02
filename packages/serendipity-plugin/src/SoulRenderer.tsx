/**
 * SoulRenderer - Soul 블록 렌더러
 *
 * Soul Server 이벤트를 위한 읽기 전용 블록 렌더러입니다.
 * soul:* 타입의 블록을 각 타입에 맞게 렌더링합니다.
 */

import type { NodeRendererProps } from './plugin-types'
import {
  isSoulContent,
  isSoulUserContent,
  isSoulAssistantContent,
  isSoulThinkingContent,
  isSoulToolUseContent,
  isSoulToolResultContent,
  isSoulErrorContent,
  isSoulInterventionContent,
  type SoulContent,
} from './types'

// ============================================================================
// Icons
// ============================================================================

function UserIcon() {
  return (
    <svg
      data-testid="soul-user-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function AssistantIcon() {
  return (
    <svg
      data-testid="soul-assistant-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  )
}

function ThinkingIcon() {
  return (
    <svg
      data-testid="soul-thinking-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function ToolUseIcon() {
  return (
    <svg
      data-testid="soul-tool-use-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

function ToolResultIcon() {
  return (
    <svg
      data-testid="soul-tool-result-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg
      data-testid="soul-error-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function InterventionIcon() {
  return (
    <svg
      data-testid="soul-intervention-icon"
      className="soul-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      {/* Hand/palm icon - representing user intervention */}
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  )
}

// ============================================================================
// Renderers
// ============================================================================

interface SoulBlockProps {
  className?: string
  icon: React.ReactNode
  children: React.ReactNode
  label: string
}

function SoulBlock({ className = '', icon, children, label }: SoulBlockProps) {
  return (
    <article
      className={`soul-block ${className}`}
      data-testid="soul-block"
      aria-label={label}
    >
      <div className="soul-block-icon">
        {icon}
      </div>
      <div className="soul-block-content">
        {children}
      </div>
    </article>
  )
}

function UserBlock({ content }: { content: SoulContent }) {
  if (!isSoulUserContent(content)) return null

  return (
    <SoulBlock className="soul-block-user" icon={<UserIcon />} label="User message">
      <div className="soul-text">{content.text}</div>
    </SoulBlock>
  )
}

function AssistantBlock({ content }: { content: SoulContent }) {
  if (!isSoulAssistantContent(content)) return null

  return (
    <SoulBlock className="soul-block-assistant" icon={<AssistantIcon />} label="Assistant response">
      <div className="soul-text">{content.text}</div>
      {content.metadata.model && (
        <span className="soul-model-badge">{content.metadata.model}</span>
      )}
    </SoulBlock>
  )
}

function ThinkingBlock({ content }: { content: SoulContent }) {
  if (!isSoulThinkingContent(content)) return null

  return (
    <SoulBlock className="soul-block-thinking" icon={<ThinkingIcon />} label="Thinking process">
      <div className="soul-text">{content.text}</div>
    </SoulBlock>
  )
}

function ToolUseBlock({ content }: { content: SoulContent }) {
  if (!isSoulToolUseContent(content)) return null

  const { toolName, input } = content.metadata

  return (
    <SoulBlock className="soul-block-tool-use" icon={<ToolUseIcon />} label={`Tool call: ${toolName}`}>
      <div className="soul-tool-header">
        <span className="soul-tool-name">{toolName}</span>
      </div>
      <pre className="soul-tool-input">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    </SoulBlock>
  )
}

function ToolResultBlock({ content }: { content: SoulContent }) {
  if (!isSoulToolResultContent(content)) return null

  const { isError } = content.metadata

  return (
    <SoulBlock
      className={`soul-block-tool-result ${isError ? 'soul-tool-result-error' : ''}`}
      icon={<ToolResultIcon />}
      label={isError ? 'Tool error result' : 'Tool result'}
    >
      <pre className="soul-tool-output">
        <code>{content.output}</code>
      </pre>
    </SoulBlock>
  )
}

function ErrorBlock({ content }: { content: SoulContent }) {
  if (!isSoulErrorContent(content)) return null

  const { errorType, message } = content.metadata

  return (
    <SoulBlock className="soul-block-error" icon={<ErrorIcon />} label={`Error: ${errorType}`}>
      <div className="soul-error-type">{errorType}</div>
      <div className="soul-error-message">{message}</div>
    </SoulBlock>
  )
}

function InterventionBlock({ content }: { content: SoulContent }) {
  if (!isSoulInterventionContent(content)) return null

  return (
    <SoulBlock className="soul-block-intervention" icon={<InterventionIcon />} label="User intervention">
      <div className="soul-text">{content.text}</div>
    </SoulBlock>
  )
}

// ============================================================================
// Main Renderer
// ============================================================================

/**
 * SoulRenderer - Soul 블록의 메인 렌더러
 *
 * node.content에서 soulType을 읽어 적절한 렌더러를 선택합니다.
 */
export function SoulRenderer({ node }: NodeRendererProps) {
  // 런타임 타입 검증
  if (!isSoulContent(node.content)) {
    return (
      <div className="soul-block soul-block-invalid">
        <span>Invalid soul block content</span>
      </div>
    )
  }

  const content = node.content

  switch (content.soulType) {
    case 'soul:user':
      return <UserBlock content={content} />

    case 'soul:assistant':
      return <AssistantBlock content={content} />

    case 'soul:thinking':
      return <ThinkingBlock content={content} />

    case 'soul:tool_use':
      return <ToolUseBlock content={content} />

    case 'soul:tool_result':
      return <ToolResultBlock content={content} />

    case 'soul:error':
      return <ErrorBlock content={content} />

    case 'soul:intervention':
      return <InterventionBlock content={content} />

    default:
      return (
        <div className="soul-block soul-block-unknown">
          <span>Unknown soul type: {(content as SoulContent).soulType}</span>
        </div>
      )
  }
}
