/**
 * NodeHandles - 공통 Handle 컴포넌트
 *
 * 모든 노드에서 사용하는 4방향 Handle을 제공합니다.
 * 부모-자식 간 수평 에지(right→left)와 수직 에지(bottom→top)를 지원합니다.
 */

import { Handle, Position } from '@xyflow/react';
import { handleStyle } from './node-styles';

interface NodeHandlesProps {
  color: string;
}

export function NodeHandles({ color }: NodeHandlesProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" style={handleStyle(color)} />
      <Handle type="target" position={Position.Left} id="left" style={handleStyle(color)} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle(color)} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle(color)} />
    </>
  );
}
