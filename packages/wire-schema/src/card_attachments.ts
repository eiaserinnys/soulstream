/** Stored card attachment metadata; paths belong to the named worker node. */
export interface CardAttachment {
  nodeId: string;
  path: string;
  name: string;
  mimeType: string;
}
