/** 노드 ID 문자열을 0~359 hue 값으로 해시한다 (djb2 XOR 변형) */
export function nodeIdToHue(nodeId: string): number {
  let hash = 5381;
  for (let i = 0; i < nodeId.length; i++) {
    hash = ((hash << 5) + hash) ^ nodeId.charCodeAt(i);
  }
  return Math.abs(hash) % 360;
}
