const omissionMarker = "\n[중간 생략]\n";

export function clampText(text: string, max: number): string {
  const characters = [...text];
  const limit = Math.max(0, Math.floor(max));
  if (characters.length <= limit) return text;

  const marker = [...omissionMarker];
  if (limit <= marker.length) return marker.slice(0, limit).join("");

  const contentLength = limit - marker.length;
  const frontLength = Math.ceil(contentLength / 2);
  const backLength = Math.floor(contentLength / 2);
  return [
    ...characters.slice(0, frontLength),
    ...marker,
    ...(backLength > 0 ? characters.slice(-backLength) : []),
  ].join("");
}
