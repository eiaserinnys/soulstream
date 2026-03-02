/**
 * Serendipity Plugin Types - 호환성을 위한 최소한의 타입 정의
 *
 * 이 파일은 Serendipity의 플러그인 인터페이스와 호환되는 타입을 정의합니다.
 * Serendipity가 이 플러그인을 사용할 때, 실제 타입은 Serendipity 측에서 제공됩니다.
 */

import type { ComponentType, KeyboardEvent, DragEvent } from 'react'

/**
 * 아웃라이너 노드 기본 구조
 *
 * Serendipity의 OutlinerNode와 호환됩니다.
 */
export interface OutlinerNode {
  id: string
  type: string
  content: unknown
  children?: OutlinerNode[]
  parentId?: string | null
  order?: number
}

/**
 * 노드 렌더러 Props
 *
 * Serendipity의 NodeRendererProps와 호환됩니다.
 * 플러그인 렌더러 컴포넌트가 받는 Props 타입입니다.
 */
export interface NodeRendererProps {
  /** 현재 노드 */
  node: OutlinerNode
  /** 노드의 깊이 (들여쓰기 레벨) */
  depth: number
  /** 이 노드가 포커스되었는지 */
  isFocused: boolean
  /** 이 노드가 선택되었는지 */
  isSelected: boolean
  /** 번호 매기기 리스트에서의 인덱스 */
  listIndex?: number

  // 콜백들 (Serendipity에서 제공)
  onContentChange: (nodeId: string, content: unknown) => void
  onFocus: (nodeId: string) => void
  onKeyDown: (
    nodeId: string,
    event: KeyboardEvent<HTMLDivElement>,
    cursorInfo?: unknown
  ) => boolean | void
  onNavigatePrev?: (nodeId: string) => void
  onNavigateNext?: (nodeId: string) => void
  onBackspaceAtStart?: (nodeId: string) => boolean | void

  // 드래그 앤 드롭
  onDragStart?: (nodeId: string, event: DragEvent) => void
  onDragOver?: (nodeId: string, depth: number, event: DragEvent) => void
  onDragLeave?: (event: DragEvent) => void
  onDrop?: (event: DragEvent) => void
  onDragEnd?: (event: DragEvent) => void
}

/**
 * 노드 렌더러 플러그인 설정
 *
 * Serendipity의 NodeRendererPlugin과 호환됩니다.
 */
export interface NodeRendererPlugin {
  /**
   * 블록 타입 또는 패턴
   * - 정확한 매칭: 'code', 'paragraph', 'heading'
   * - 패턴 매칭: 'soul:*' (matchPattern: true 필요)
   */
  type: string

  /**
   * 렌더러 컴포넌트
   */
  component: ComponentType<NodeRendererProps>

  /**
   * true인 경우 type을 패턴으로 처리
   * - 'prefix:*' 형태는 'prefix:'로 시작하는 모든 타입에 매칭
   */
  matchPattern?: boolean

  /**
   * 플러그인 우선순위 (높을수록 먼저 매칭)
   * 기본값: 0
   * 정확한 매칭이 패턴 매칭보다 항상 우선
   */
  priority?: number
}
