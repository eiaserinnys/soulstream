/**
 * Soul Plugin Types - Soul 블록 타입 정의
 *
 * Soul Server 이벤트를 표현하기 위한 블록 타입과 content 스키마를 정의합니다.
 * 모든 soul:* 블록은 읽기 전용입니다.
 */

// ============================================================================
// Block Types
// ============================================================================

/**
 * Soul 블록 타입 열거
 */
export const SOUL_BLOCK_TYPES = [
  'soul:user',        // 사용자 메시지
  'soul:assistant',   // AI 어시스턴트 응답
  'soul:thinking',    // AI 사고 과정 (extended thinking)
  'soul:tool_use',    // 도구 호출
  'soul:tool_result', // 도구 실행 결과
  'soul:error',       // 에러 메시지
  'soul:intervention', // 사용자 개입 (세션 중간 추가 메시지)
] as const

export type SoulBlockType = typeof SOUL_BLOCK_TYPES[number]

/**
 * 주어진 문자열이 유효한 Soul 블록 타입인지 확인
 */
export function isSoulBlockType(type: string): type is SoulBlockType {
  return SOUL_BLOCK_TYPES.includes(type as SoulBlockType)
}

// ============================================================================
// Content Schemas
// ============================================================================

/**
 * Soul 컨텐츠 기본 인터페이스
 */
export interface SoulContentBase {
  _version: 1
  soulType: SoulBlockType
  metadata: {
    timestamp: string // ISO 8601 형식
  }
}

/**
 * 사용자 메시지 컨텐츠
 */
export interface SoulUserContent extends SoulContentBase {
  soulType: 'soul:user'
  text: string
  metadata: {
    timestamp: string
  }
}

/**
 * AI 어시스턴트 응답 컨텐츠
 */
export interface SoulAssistantContent extends SoulContentBase {
  soulType: 'soul:assistant'
  text: string
  metadata: {
    timestamp: string
    model?: string // 예: 'claude-sonnet-4-20250514'
  }
}

/**
 * AI 사고 과정 컨텐츠 (Extended Thinking)
 */
export interface SoulThinkingContent extends SoulContentBase {
  soulType: 'soul:thinking'
  text: string
  metadata: {
    timestamp: string
  }
}

/**
 * 도구 호출 컨텐츠
 */
export interface SoulToolUseContent extends SoulContentBase {
  soulType: 'soul:tool_use'
  metadata: {
    timestamp: string
    toolName: string
    toolId: string
    input: Record<string, unknown>
  }
}

/**
 * 도구 실행 결과 컨텐츠
 */
export interface SoulToolResultContent extends SoulContentBase {
  soulType: 'soul:tool_result'
  output: string
  metadata: {
    timestamp: string
    toolId: string
    isError: boolean
  }
}

/**
 * 에러 메시지 컨텐츠
 */
export interface SoulErrorContent extends SoulContentBase {
  soulType: 'soul:error'
  metadata: {
    timestamp: string
    errorType: string // 예: 'rate_limit', 'api_error', 'timeout'
    message: string
  }
}

/**
 * 사용자 개입 컨텐츠 (세션 중간 추가 메시지)
 */
export interface SoulInterventionContent extends SoulContentBase {
  soulType: 'soul:intervention'
  text: string
  metadata: {
    timestamp: string
  }
}

/**
 * 모든 Soul 컨텐츠 타입 유니온
 */
export type SoulContent =
  | SoulUserContent
  | SoulAssistantContent
  | SoulThinkingContent
  | SoulToolUseContent
  | SoulToolResultContent
  | SoulErrorContent
  | SoulInterventionContent

// ============================================================================
// Content Factory
// ============================================================================

/**
 * Soul 컨텐츠 생성 입력 타입
 */
export interface CreateSoulUserInput {
  text: string
  timestamp: string
}

export interface CreateSoulAssistantInput {
  text: string
  timestamp: string
  model?: string
}

export interface CreateSoulThinkingInput {
  text: string
  timestamp: string
}

export interface CreateSoulToolUseInput {
  toolName: string
  toolId: string
  input: Record<string, unknown>
  timestamp: string
}

export interface CreateSoulToolResultInput {
  toolId: string
  output: string
  isError: boolean
  timestamp: string
}

export interface CreateSoulErrorInput {
  errorType: string
  message: string
  timestamp: string
}

export interface CreateSoulInterventionInput {
  text: string
  timestamp: string
}

type CreateSoulContentInput =
  | CreateSoulUserInput
  | CreateSoulAssistantInput
  | CreateSoulThinkingInput
  | CreateSoulToolUseInput
  | CreateSoulToolResultInput
  | CreateSoulErrorInput
  | CreateSoulInterventionInput

/**
 * Soul 컨텐츠 생성 팩토리 함수
 */
export function createSoulContent(
  type: 'soul:user',
  input: CreateSoulUserInput
): SoulUserContent
export function createSoulContent(
  type: 'soul:assistant',
  input: CreateSoulAssistantInput
): SoulAssistantContent
export function createSoulContent(
  type: 'soul:thinking',
  input: CreateSoulThinkingInput
): SoulThinkingContent
export function createSoulContent(
  type: 'soul:tool_use',
  input: CreateSoulToolUseInput
): SoulToolUseContent
export function createSoulContent(
  type: 'soul:tool_result',
  input: CreateSoulToolResultInput
): SoulToolResultContent
export function createSoulContent(
  type: 'soul:error',
  input: CreateSoulErrorInput
): SoulErrorContent
export function createSoulContent(
  type: 'soul:intervention',
  input: CreateSoulInterventionInput
): SoulInterventionContent
export function createSoulContent(
  type: SoulBlockType,
  input: CreateSoulContentInput
): SoulContent {
  switch (type) {
    case 'soul:user':
      return {
        _version: 1,
        soulType: 'soul:user',
        text: (input as CreateSoulUserInput).text,
        metadata: {
          timestamp: input.timestamp,
        },
      }

    case 'soul:assistant':
      const assistantInput = input as CreateSoulAssistantInput
      return {
        _version: 1,
        soulType: 'soul:assistant',
        text: assistantInput.text,
        metadata: {
          timestamp: assistantInput.timestamp,
          model: assistantInput.model,
        },
      }

    case 'soul:thinking':
      return {
        _version: 1,
        soulType: 'soul:thinking',
        text: (input as CreateSoulThinkingInput).text,
        metadata: {
          timestamp: input.timestamp,
        },
      }

    case 'soul:tool_use':
      const toolUseInput = input as CreateSoulToolUseInput
      return {
        _version: 1,
        soulType: 'soul:tool_use',
        metadata: {
          timestamp: toolUseInput.timestamp,
          toolName: toolUseInput.toolName,
          toolId: toolUseInput.toolId,
          input: toolUseInput.input,
        },
      }

    case 'soul:tool_result':
      const toolResultInput = input as CreateSoulToolResultInput
      return {
        _version: 1,
        soulType: 'soul:tool_result',
        output: toolResultInput.output,
        metadata: {
          timestamp: toolResultInput.timestamp,
          toolId: toolResultInput.toolId,
          isError: toolResultInput.isError,
        },
      }

    case 'soul:error':
      const errorInput = input as CreateSoulErrorInput
      return {
        _version: 1,
        soulType: 'soul:error',
        metadata: {
          timestamp: errorInput.timestamp,
          errorType: errorInput.errorType,
          message: errorInput.message,
        },
      }

    case 'soul:intervention':
      const interventionInput = input as CreateSoulInterventionInput
      return {
        _version: 1,
        soulType: 'soul:intervention',
        text: interventionInput.text,
        metadata: {
          timestamp: interventionInput.timestamp,
        },
      }

    default:
      throw new Error(`Unknown soul block type: ${type}`)
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * SoulContent 타입 가드
 */
export function isSoulContent(value: unknown): value is SoulContent {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_version' in value &&
    (value as SoulContentBase)._version === 1 &&
    'soulType' in value &&
    isSoulBlockType((value as SoulContentBase).soulType)
  )
}

export function isSoulUserContent(value: unknown): value is SoulUserContent {
  return isSoulContent(value) && value.soulType === 'soul:user'
}

export function isSoulAssistantContent(value: unknown): value is SoulAssistantContent {
  return isSoulContent(value) && value.soulType === 'soul:assistant'
}

export function isSoulThinkingContent(value: unknown): value is SoulThinkingContent {
  return isSoulContent(value) && value.soulType === 'soul:thinking'
}

export function isSoulToolUseContent(value: unknown): value is SoulToolUseContent {
  return isSoulContent(value) && value.soulType === 'soul:tool_use'
}

export function isSoulToolResultContent(value: unknown): value is SoulToolResultContent {
  return isSoulContent(value) && value.soulType === 'soul:tool_result'
}

export function isSoulErrorContent(value: unknown): value is SoulErrorContent {
  return isSoulContent(value) && value.soulType === 'soul:error'
}

export function isSoulInterventionContent(value: unknown): value is SoulInterventionContent {
  return isSoulContent(value) && value.soulType === 'soul:intervention'
}
